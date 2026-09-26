// RPC key rotation (Gate rpc-rotation) — the Rust-side counterpart to
// orchestrator/src/rpc_rotation.ts. Each `prove`/`header_check` invocation
// is a fresh process, so state can't live in memory the way it does on the
// orchestrator side; instead it's a small JSON file
// ({url_index: cooldown_until_unix_ts}), read/written best-effort. A failed
// write is not fatal — it only means no memory of a cooldown across the
// NEXT fresh process, not a broken current run. A missing or corrupted file
// is treated as "no info, try URL_1 first" rather than a crash.
use std::collections::HashMap;
use std::env;
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

pub const DEFAULT_COOLDOWN_SEC: u64 = 1800;
pub const DEFAULT_HEALTH_FILE_PATH: &str = ".rpc_health.json";

fn health_file_path() -> String {
    env::var("RPC_HEALTH_FILE_PATH").unwrap_or_else(|_| DEFAULT_HEALTH_FILE_PATH.to_string())
}

fn cooldown_sec() -> u64 {
    env::var("RPC_COOLDOWN_SEC")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_COOLDOWN_SEC)
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Missing file, unreadable file, or invalid JSON all fall back to an empty
/// map — "no info, try URL_1 first" — never a crash.
fn load_health(path: &str) -> HashMap<String, u64> {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Write-then-rename, same pattern as prove.rs's proof_<id>.json — but
/// unlike that write, failure here is swallowed on purpose: losing this
/// file only costs cross-process memory of a cooldown, never correctness.
fn save_health(path: &str, health: &HashMap<String, u64>) {
    let Ok(json) = serde_json::to_string(health) else {
        return;
    };
    let tmp = format!("{path}.tmp");
    if fs::write(&tmp, json).is_ok() {
        let _ = fs::rename(&tmp, path);
    }
}

/// Loosely matched on purpose: Alchemy's monthly-capacity error and a plain
/// throughput-burst 429 should both trigger the same cooldown — over-
/// rotating away from a struggling key beats precisely classifying it.
pub fn is_capacity_error(msg: &str) -> bool {
    let lower = msg.to_lowercase();
    lower.contains("429") || lower.contains("capacity") || lower.contains("rate limit") || lower.contains("too many requests")
}

/// Indices into the caller's URL list (0 = URL_1, 1 = URL_2, ...), in the
/// order they should be tried this run: any index still cooling down per
/// the health file at `path` (as of `now`) is skipped — unless every index
/// is cooling down, in which case cooldowns are ignored rather than
/// producing an empty order.
fn rotation_order_at(urls_len: usize, path: &str, now: u64) -> Vec<usize> {
    let health = load_health(path);
    let cooling = |i: usize| health.get(&i.to_string()).copied().unwrap_or(0) > now;
    let available: Vec<usize> = (0..urls_len).filter(|&i| !cooling(i)).collect();
    if available.is_empty() {
        (0..urls_len).collect()
    } else {
        available
    }
}

pub fn rotation_order(urls_len: usize) -> Vec<usize> {
    rotation_order_at(urls_len, &health_file_path(), now_unix())
}

/// Marks `url_index` cooling down for `cooldown` seconds from `now`,
/// persisting best-effort to the health file at `path`. Logs the
/// cooldown-START line exactly once (only when it wasn't already cooling
/// down) — a later run that just skips this same still-cooling index via
/// `rotation_order` must never log again for it.
fn record_capacity_error_at(url_index: usize, path: &str, now: u64, cooldown: u64) {
    let mut health = load_health(path);
    let already_cooling = health.get(&url_index.to_string()).copied().unwrap_or(0) > now;
    health.insert(url_index.to_string(), now + cooldown);
    save_health(path, &health);
    if !already_cooling {
        eprintln!(
            "[rpc] URL_{}: monthly-capacity/429 error — cooling down for {cooldown}s",
            url_index + 1
        );
    }
}

pub fn record_capacity_error(url_index: usize) {
    record_capacity_error_at(url_index, &health_file_path(), now_unix(), cooldown_sec());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    // Each test uses its own tmp file path (rather than the env-var-backed
    // default) so tests running in parallel threads within the same process
    // never race on shared file/global state.
    fn tmp_path(name: &str) -> String {
        std::env::temp_dir()
            .join(format!("maat_rpc_health_test_{name}_{}.json", std::process::id()))
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn missing_file_tries_all_from_url_1() {
        let path = tmp_path("missing");
        let _ = fs::remove_file(&path);
        assert_eq!(rotation_order_at(3, &path, 1000), vec![0, 1, 2]);
    }

    #[test]
    fn corrupted_file_falls_back_to_all_from_url_1() {
        let path = tmp_path("corrupt");
        fs::write(&path, "{ this is not valid json").unwrap();
        assert_eq!(rotation_order_at(3, &path, 1000), vec![0, 1, 2]);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn capacity_error_marks_cooldown_and_is_skipped_next_run() {
        let path = tmp_path("cooldown");
        let _ = fs::remove_file(&path);
        record_capacity_error_at(0, &path, 1000, 1800);
        // A later, fresh "process" (just a fresh read of the same file here)
        // still within the cooldown window skips index 0.
        assert_eq!(rotation_order_at(3, &path, 1500), vec![1, 2]);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn cooldown_expires_after_cooldown_sec() {
        let path = tmp_path("expiry");
        let _ = fs::remove_file(&path);
        record_capacity_error_at(0, &path, 1000, 1800); // cooldown_until = 2800
        assert_eq!(rotation_order_at(3, &path, 2799), vec![1, 2]);
        assert_eq!(rotation_order_at(3, &path, 2800), vec![0, 1, 2]);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn all_cooling_down_falls_back_to_trying_all() {
        let path = tmp_path("all_cooling");
        let _ = fs::remove_file(&path);
        record_capacity_error_at(0, &path, 1000, 1800);
        record_capacity_error_at(1, &path, 1000, 1800);
        record_capacity_error_at(2, &path, 1000, 1800);
        assert_eq!(rotation_order_at(3, &path, 1500), vec![0, 1, 2]);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn detects_capacity_errors_loosely() {
        assert!(is_capacity_error("HTTP 429 from RPC endpoint"));
        assert!(is_capacity_error("Your app has exceeded its monthly capacity limit"));
        assert!(is_capacity_error("rate limit exceeded"));
        assert!(!is_capacity_error("connection timed out"));
    }
}
