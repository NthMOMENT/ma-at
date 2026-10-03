// RPC key rotation (Gate rpc-rotation): replaces "always try
// ALCHEMY_RPC_URL_1 first" with a round-robin start point, and skips a URL
// that just hit a monthly-capacity/429 error until RPC_COOLDOWN_SEC has
// passed instead of hammering it on every single poll. State is in-memory
// only, keyed by URL string, and shared by every rotating transport this
// process creates (listener.ts's arbClient, arbitrum_settlement.ts's
// solver/orchestrator wallet clients) — they draw on the same
// ALCHEMY_RPC_URL_1/2/3 Alchemy accounts/quotas, so one client learning a
// URL is capped keeps every other client in this process off it too.
//
// Mirrors zk/script/src/rpc_rotation.rs, which does the same thing but
// file-backed (best-effort, via zk/.rpc_health.json) since each prove/
// header_check invocation there is a fresh process rather than one
// long-running one.
import { custom, type Transport } from "viem";

export const DEFAULT_COOLDOWN_SEC = 1800;
// Matches viem http()'s own default request timeout exactly (see http.js:
// `timeout_ ?? config.timeout ?? 10_000`) — this transport does its own
// fetch, bypassing http(), so it has to set this itself or a hung (open but
// silent) connection would wait forever instead of 10s.
export const DEFAULT_TIMEOUT_MS = 10_000;
// Matches viem's own outer retry defaults exactly (createTransport.js:
// `retryCount = 3`; buildRequest.js's backoff: `~~(1 << count) * retryDelay`
// with retryDelay = 150). fallback() forces retryCount:0 on each INNER
// http() transport (so, like this transport, it never retries a single URL
// before moving to the next one) but its OUTER buildRequest wrapper still
// retries the WHOLE multi-URL sweep up to retryCount times if every URL in
// it fails with what viem classifies as a transient error. This transport
// preserves that outer-sweep retry so "all three keys blip at once
// transiently" doesn't throw one attempt sooner than fallback() used to.
export const DEFAULT_SWEEP_RETRY_COUNT = 3;
export const DEFAULT_SWEEP_RETRY_DELAY_MS = 150;

export function cooldownSecFromEnv(): number {
  const raw = Number(process.env.RPC_COOLDOWN_SEC);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_COOLDOWN_SEC;
}

export function timeoutMsFromEnv(): number {
  const raw = Number(process.env.RPC_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface UrlHealth {
  coolDownUntilMs: number;
}

const healthByUrl = new Map<string, UrlHealth>();

function getHealth(url: string): UrlHealth {
  let h = healthByUrl.get(url);
  if (!h) {
    h = { coolDownUntilMs: 0 };
    healthByUrl.set(url, h);
  }
  return h;
}

/// Test-only reset — nothing in production code needs to clear this map.
export function _resetHealthForTests(): void {
  healthByUrl.clear();
}

/// Loosely matched on purpose: Alchemy's monthly-capacity error and a
/// plain throughput-burst 429 should both trigger the same cooldown —
/// over-rotating away from a struggling key beats precisely classifying it.
export function isCapacityError(err: unknown): boolean {
  const msg = String((err as { message?: string } | undefined)?.message ?? err ?? "").toLowerCase();
  return msg.includes("429") || msg.includes("capacity") || msg.includes("rate limit") || msg.includes("too many requests");
}

/// Indices into `urls`, in the order they should be tried: round-robin
/// starting at `startIndex`, skipping any URL still cooling down as of
/// `nowMs` — unless EVERY URL is cooling down, in which case cooldowns are
/// ignored rather than failing outright with zero attempts, and the order
/// is instead least-recently-cooled first (ascending cooldown-expiry time)
/// so the URL most likely to have actually recovered is tried first.
export function rotationOrder(urls: readonly string[], startIndex: number, nowMs: number): number[] {
  const order: number[] = [];
  for (let i = 0; i < urls.length; i++) order.push((startIndex + i) % urls.length);
  const available = order.filter((i) => getHealth(urls[i]).coolDownUntilMs <= nowMs);
  if (available.length > 0) return available;
  return [...order].sort((a, b) => getHealth(urls[a]).coolDownUntilMs - getHealth(urls[b]).coolDownUntilMs);
}

/// Marks `url` cooling down for `cooldownSec` starting at `nowMs`. Logs the
/// cooldown-START line exactly once per window (returns nothing; check
/// console output if needed) — a later call that merely SKIPS this same
/// still-cooling URL must never log again, which is what avoids re-printing
/// a "monthly limit exceeded" line on every ~4s poll for the next 30
/// minutes. `urlLabel` is a display label only (e.g. "Arbitrum URL_2") —
/// never the raw URL, which embeds the Alchemy API key.
export function recordCapacityError(url: string, nowMs: number, cooldownSec: number, urlLabel: string): void {
  const health = getHealth(url);
  const alreadyCoolingDown = health.coolDownUntilMs > nowMs;
  health.coolDownUntilMs = nowMs + cooldownSec * 1000;
  if (!alreadyCoolingDown) {
    console.warn(
      `[RPC] ${urlLabel}: monthly-capacity/429 error — cooling down for ${cooldownSec}s (until ${new Date(health.coolDownUntilMs).toISOString()})`
    );
  }
}

/// A JSON-RPC error carrying its numeric `code`, which viem's buildRequest
/// maps to a typed error (e.g. -32000 -> InvalidInputRpcError). A code-less
/// Error becomes UnknownRpcError instead, and watchContractEvent only
/// re-creates an expired filter on InvalidInputRpcError — so dropping the
/// code left every watcher stuck on "filter not found" until a restart.
function jsonRpcError(code: number, message: string, prefix: string): Error {
  return Object.assign(new Error(`${prefix}RPC error ${code}: ${message}`), { code });
}

/// A single HTTP attempt against one URL, aborted after `timeoutMs` — same
/// default (10s) and same failure mode (an AbortError) as viem's http().
async function rpcPost(url: string, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Like viem's http(): a non-2xx whose body is a valid JSON-RPC error
      // (Alchemy answers an expired filter with 400 + -32000 "filter not
      // found") is surfaced as that RPC error, not a bare HTTP failure.
      // "HTTP <status>" stays in the message so isCapacityError still sees 429s.
      const errBody = (await res.json().catch(() => undefined)) as { error?: { code?: unknown; message?: unknown } } | undefined;
      const e = errBody?.error;
      if (typeof e?.code === "number" && typeof e?.message === "string") {
        throw jsonRpcError(e.code, e.message, `HTTP ${res.status} from RPC endpoint: `);
      }
      throw new Error(`HTTP ${res.status} from RPC endpoint`);
    }
    const body = (await res.json()) as { error?: { code: number; message: string }; result?: unknown };
    if (body.error) {
      throw jsonRpcError(body.error.code, body.error.message, "");
    }
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

/// Builds a viem Transport that rotates across `urls`, in-memory only, per
/// the rules above. Replaces `fallback(urls.map((u) => http(u)))` at every
/// call site that previously always tried URL_1 first.
export function createRotatingHttpTransport(urls: readonly string[], clientLabel: string): Transport {
  if (urls.length === 0) {
    throw new Error(`createRotatingHttpTransport(${clientLabel}): no URLs configured`);
  }
  const cooldownSec = cooldownSecFromEnv();
  const timeoutMs = timeoutMsFromEnv();
  let nextStartIndex = 0;

  /// One pass over the rotation order (skipping URLs still cooling down),
  /// same as before — never retries a single URL, just like fallback()'s
  /// inner transports never did either. Throws the last error if every
  /// attempted URL failed.
  async function attemptSweep(method: string, params: unknown): Promise<unknown> {
    const order = rotationOrder(urls, nextStartIndex, Date.now());
    let lastErr: unknown;
    for (const idx of order) {
      try {
        const result = await rpcPost(urls[idx], method, params ?? [], timeoutMs);
        nextStartIndex = (idx + 1) % urls.length;
        return result;
      } catch (err) {
        lastErr = err;
        if (isCapacityError(err)) {
          recordCapacityError(urls[idx], Date.now(), cooldownSec, `${clientLabel} URL_${idx + 1}`);
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  return custom(
    {
      // Retries the WHOLE sweep (not a single URL — see attemptSweep) up to
      // DEFAULT_SWEEP_RETRY_COUNT times with the same exponential backoff
      // viem's own outer retry layer uses, preserving the "all 3 keys blip
      // at once" resilience fallback() had, which retryCount:0 below would
      // otherwise remove entirely.
      async request({ method, params }: { method: string; params?: unknown }) {
        let lastErr: unknown;
        for (let attempt = 0; attempt <= DEFAULT_SWEEP_RETRY_COUNT; attempt++) {
          try {
            return await attemptSweep(method, params);
          } catch (err) {
            lastErr = err;
            if (attempt < DEFAULT_SWEEP_RETRY_COUNT) {
              await sleep((1 << attempt) * DEFAULT_SWEEP_RETRY_DELAY_MS);
            }
          }
        }
        throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
      },
    },
    // retryCount: 0 here means viem's OWN outer retry layer (buildRequest)
    // is disabled — deliberately, because the request() above already does
    // its own equivalent outer-sweep retry. Leaving both enabled would
    // retry-of-retries (up to 3 * 3 sweeps) on a genuinely dead endpoint.
    { name: `rotating-http(${clientLabel})`, retryCount: 0 }
  );
}
