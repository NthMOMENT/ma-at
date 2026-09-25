// Shared prover-invocation + settle-gate pipeline. Both listener.ts (EVM)
// and tron_listener.ts import this rather than each rolling their own copy
// — the two are separate Node processes, so the correctness properties this
// module provides (one prover run on the host at a time; a proof is never
// trusted to describe itself) have to hold across process boundaries, not
// just within one file.
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { setProving, setRetrying, setVerified, setRejected, setAlert } from "./intent_state";

// ─── Config ──────────────────────────────────────────────────────────────────

export const PROVER_BINARY =
  process.env.PROVER_BINARY_PATH ?? path.resolve(__dirname, "../../zk/target/release/prove");

// prove.rs writes proof_<id>.{json,bin} relative to its CWD. Pin that CWD
// explicitly on every spawn so files always land in the same place — zk/ —
// regardless of where the Node process happens to have been started from.
export const ZK_DIR = process.env.ZK_DIR_PATH ?? path.resolve(path.dirname(PROVER_BINARY), "../..");

const LOCK_FILE = process.env.PROVER_LOCK_FILE ?? "/tmp/maat-prover.lock";

// Ground truth for the settle gate (Phase 5A briefing) — always compared
// against the proof's claimed value, never derived from it.
export const EXPECTED_VKEY = "0x000c653a242999b53decd2c3d31fc211e432b38eb4ead432b789607eb8621937";
export const SOLANA_CHAIN_ID = 1399811149n;

const MAX_PROVER_RETRIES = 3;
const RETRY_BACKOFF_MS = [5_000, 15_000, 45_000];

// Hard wall-clock cap on a single prove-mode run — prove takes ~7min
// normally; 30min leaves generous headroom while still bounding a hung or
// runaway run. Enforced via systemd's own RuntimeMaxSec (not an external
// `timeout` wrapper) so the SAME mechanism that owns the cgroup also owns
// the kill, and flock's lock release is unaffected either way — flock
// releases as soon as the wrapped process group exits, whatever the cause.
const PROVER_TIMEOUT_SEC = Number(process.env.PROVER_TIMEOUT_SEC ?? 1800);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Proof JSON shape (mirrors prove.rs's ProofOutputJson) ──────────────────

export interface ProofOutputJson {
  tx_hash: string;
  mode: string;
  vkey: string;
  block_hash: string;
  block_number: number;
  block_timestamp: number;
  contract: string;
  intent_id: string;
  sender: string;
  amount: string;
  token_address: string;
  destination_wallet: string;
  destination_chain_id: number;
  expiry: number;
  slippage_bps: number;
}

// ─── Alerting ────────────────────────────────────────────────────────────────
// No paging integration exists in this codebase — surfaces loudly to stderr
// plus an append-only local log so a "never settle" event isn't lost in
// scrollback the next time this process restarts.

const ALERT_LOG = process.env.ALERT_LOG_PATH ?? path.resolve(__dirname, "../alerts.log");

export function alert(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.error(`[ALERT] ${line}`);
  try {
    fs.appendFileSync(ALERT_LOG, line + "\n");
  } catch (err) {
    console.error(`[ALERT] failed to write ${ALERT_LOG}:`, (err as Error).message);
  }
}

// ─── Settled-intent ledger ───────────────────────────────────────────────────
// Local, single-host, best-effort persistence — enough to stop this
// orchestrator from double-settling the same intent across its own
// restarts. NOT a substitute for an on-chain "already settled" check if
// this ever runs as more than one instance; flagged in the Gate 5B report.
//
// Three states per intent: absent (never attempted) -> "settling" (the
// payout tx has been SIGNED — its signature is known and recorded here —
// but not yet confirmed sent) -> "settled" (confirmed landed on-chain).
// The "settling" write happens before the signed tx is broadcast (see the
// SETTLING_SIG handshake between listener.ts and settle_intent.js), so a
// crash between sign and confirm leaves behind a signature the next boot
// can check on-chain, instead of silently forgetting the attempt — which
// would otherwise risk a second payout on retry.

export type LedgerStatus = "settling" | "settled";

export interface LedgerEntry {
  status: LedgerStatus;
  solanaSig?: string;
  updatedAt: string;
}

const LEDGER_PATH = process.env.SETTLED_LEDGER_PATH ?? path.resolve(__dirname, "../settled_intents.json");

function loadLedger(): Map<string, LedgerEntry> {
  const ledger = new Map<string, LedgerEntry>();
  try {
    const raw = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
    if (Array.isArray(raw)) {
      // Pre-Gate-5B-fix format: a plain array of settled intent ids.
      for (const id of raw as string[]) {
        ledger.set(id.toLowerCase(), { status: "settled", updatedAt: new Date(0).toISOString() });
      }
      return ledger;
    }
    for (const [id, entry] of Object.entries(raw as Record<string, LedgerEntry>)) {
      ledger.set(id.toLowerCase(), entry);
    }
    return ledger;
  } catch {
    return ledger;
  }
}

const settledLedger = loadLedger();

function persistLedger(intentId: string): void {
  try {
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(Object.fromEntries(settledLedger), null, 2));
  } catch (err) {
    alert(`failed to persist settled ledger after updating ${intentId}: ${(err as Error).message}`);
  }
}

export function getLedgerEntry(intentId: string): LedgerEntry | undefined {
  return settledLedger.get(intentId.toLowerCase());
}

export function isAlreadySettled(intentId: string): boolean {
  return settledLedger.get(intentId.toLowerCase())?.status === "settled";
}

/// Called synchronously right after the payout tx is SIGNED and its
/// signature is known — BEFORE it is broadcast. Persists immediately (sync
/// fs write) so the record survives a crash on the very next line, which is
/// the whole point: the alternative (recording only after send+confirm)
/// loses exactly the case that matters, a crash between those two steps.
export function markSettling(intentId: string, solanaSig: string): void {
  settledLedger.set(intentId.toLowerCase(), { status: "settling", solanaSig, updatedAt: new Date().toISOString() });
  persistLedger(intentId);
}

export function markSettled(intentId: string): void {
  const existing = settledLedger.get(intentId.toLowerCase());
  settledLedger.set(intentId.toLowerCase(), { status: "settled", solanaSig: existing?.solanaSig, updatedAt: new Date().toISOString() });
  persistLedger(intentId);
}

/// Every intent still parked in "settling" — a signed payout whose fate
/// (landed? dropped?) was never confirmed, most likely because the process
/// crashed or restarted between markSettling() and markSettled(). The
/// caller (listener.ts, on boot) must check each solanaSig on-chain and
/// resolve it — never re-invoke settle_intent.js for one of these blindly,
/// since the original signed tx may already have landed and paid out.
export function getSettlingEntries(): Array<{ intentId: string; solanaSig: string }> {
  const out: Array<{ intentId: string; solanaSig: string }> = [];
  for (const [intentId, entry] of settledLedger.entries()) {
    if (entry.status === "settling" && entry.solanaSig) out.push({ intentId, solanaSig: entry.solanaSig });
  }
  return out;
}

// ─── Prover invocation ────────────────────────────────────────────────────────
// Every spawn — from either listener process — goes through `flock` on a
// shared lockfile wrapping `systemd-run --scope`, so at most one prover runs
// on this host at a time regardless of which chain triggered it: prove mode
// alone needs ~7min/~14GB, and two concurrent runs would blow the box's RAM.
// `flock` does not give a hard FIFO ordering guarantee between two separate
// waiting processes, only mutual exclusion — acceptable at this intent
// volume; each process's own jobs are still strictly FIFO via ProverQueue
// below.

function runProverProcess(txHash: string): Promise<number> {
  return new Promise((resolve) => {
    const args = [
      LOCK_FILE,
      "systemd-run",
      "--scope",
      "--wait",
      "--collect",
      "-p",
      "MemoryMax=14G",
      "-p",
      "MemorySwapMax=8G",
      "-p",
      `RuntimeMaxSec=${PROVER_TIMEOUT_SEC}`,
      "--",
      PROVER_BINARY,
      "prove",
      txHash,
    ];
    console.log(
      `[PROVER] flock ${LOCK_FILE} systemd-run --scope -p MemoryMax=14G -p MemorySwapMax=8G -p RuntimeMaxSec=${PROVER_TIMEOUT_SEC} -- prove prove ${txHash}`
    );
    const proc = spawn("flock", args, {
      cwd: ZK_DIR,
      env: { ...process.env, SP1_PROVER: "cpu" },
    });
    proc.stdout.on("data", (d: Buffer) => process.stdout.write(`[PROVER] ${d}`));
    proc.stderr.on("data", (d: Buffer) => process.stderr.write(`[PROVER] ${d}`));
    proc.on("close", (code) => resolve(code ?? 1));
    proc.on("error", (err) => {
      console.error(`[PROVER] failed to spawn flock/systemd-run:`, err.message);
      resolve(1); // couldn't even start — infra, retry
    });
  });
}

function readProofJson(intentIdHex: string): ProofOutputJson | null {
  const jsonPath = path.join(ZK_DIR, `proof_${intentIdHex}.json`);
  const binPath = path.join(ZK_DIR, `proof_${intentIdHex}.bin`);
  if (!fs.existsSync(jsonPath) || !fs.existsSync(binPath)) {
    console.error(`[PROVER] exit 0 but ${jsonPath} / ${binPath} missing — treating as anomaly, not settling`);
    return null;
  }
  let json: ProofOutputJson;
  try {
    json = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  } catch (err) {
    console.error(`[PROVER] failed to parse ${jsonPath}:`, (err as Error).message);
    return null;
  }
  if (json.mode !== "prove") {
    console.error(`[PROVER] ${jsonPath} has mode="${json.mode}" (expected "prove") — refusing to settle off it`);
    return null;
  }
  return json;
}

export type ProverOutcome =
  | { status: "settle-check"; json: ProofOutputJson }
  | { status: "rejected" }
  | { status: "alert" };

/// Runs the prover in `prove` mode ONLY — no separate `execute` pass first;
/// setup() alone is heavy enough (~7GB observed) that paying for it twice
/// per intent isn't affordable — with retry-with-backoff on infra failure,
/// and classifies the result purely by exit code (0/1/2/4) plus, on 0, the
/// JSON it wrote. Never scrapes stdout for the decision.
export async function proveIntent(txHash: string, intentIdHex: string): Promise<ProverOutcome> {
  setProving(intentIdHex);
  for (let attempt = 1; attempt <= MAX_PROVER_RETRIES; attempt++) {
    const code = await runProverProcess(txHash);

    if (code === 0) {
      const json = readProofJson(intentIdHex);
      if (!json) {
        const reason = "prover exited 0 but its output was missing/invalid — not settling";
        alert(`intent ${intentIdHex}: ${reason}`);
        setAlert(intentIdHex, reason);
        return { status: "alert" };
      }
      setVerified(intentIdHex, json.vkey);
      return { status: "settle-check", json };
    }
    if (code === 2) {
      console.log(`[PROVER] intent ${intentIdHex}: semantic reject (exit 2) — marking Rejected, no retry`);
      setRejected(intentIdHex, "semantic reject (exit 2)");
      return { status: "rejected" };
    }
    if (code === 4) {
      const reason = "proof FAILED VERIFICATION (exit 4) — never settling";
      alert(`intent ${intentIdHex}: ${reason}`);
      setAlert(intentIdHex, reason);
      return { status: "alert" };
    }

    // exit 1, or any other/unexpected code (e.g. OOM-killed by the
    // MemoryMax=14G cgroup limit, or killed by RuntimeMaxSec's timeout) —
    // treated as infra, retry with backoff.
    if (attempt === MAX_PROVER_RETRIES) {
      const reason = `prover failed ${MAX_PROVER_RETRIES}/${MAX_PROVER_RETRIES} attempts (last exit ${code}) — giving up, never settling`;
      alert(`intent ${intentIdHex}: ${reason}`);
      setAlert(intentIdHex, reason);
      return { status: "alert" };
    }
    const backoff = RETRY_BACKOFF_MS[attempt - 1] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
    console.warn(`[PROVER] intent ${intentIdHex}: exit ${code} (infra) on attempt ${attempt}/${MAX_PROVER_RETRIES} — retrying in ${backoff}ms`);
    setRetrying(intentIdHex, attempt + 1, MAX_PROVER_RETRIES);
    await sleep(backoff);
  }
  /* istanbul ignore next — loop above always returns */
  return { status: "alert" };
}

// ─── FIFO queue (per-process) ─────────────────────────────────────────────────
// Serializes jobs originating from THIS process. Cross-process exclusivity
// (this listener vs. the other chain's listener, a separate Node process)
// is handled by the flock in runProverProcess, not by this queue.

type Job = () => Promise<void>;

export class ProverQueue {
  private queue: Job[] = [];
  private running = false;

  enqueue(job: Job): void {
    this.queue.push(job);
    this.pump();
  }

  private pump(): void {
    if (this.running) return;
    const next = this.queue.shift();
    if (!next) return;
    this.running = true;
    next().finally(() => {
      this.running = false;
      this.pump();
    });
  }
}

// ─── Settle gate ──────────────────────────────────────────────────────────────

export interface SettleGateResult {
  ok: boolean;
  failedChecks: string[];
}

/// Settle ONLY if every one of these holds (Phase 5B briefing). Every input
/// besides `json` is re-derived independently — a fresh RPC call for the
/// canonical block hash, the local ledger for "already settled", the wall
/// clock for expiry — so a proof can never talk the orchestrator into
/// settling by asserting something false about itself; block_hash in
/// particular is the check that catches a fabricated-but-internally-
/// consistent header, since the proof's own claim about it is never trusted.
export function evaluateSettleGate(json: ProofOutputJson, expectedContract: string, canonicalBlockHash: string): SettleGateResult {
  const failed: string[] = [];
  if (json.contract.toLowerCase() !== expectedContract.toLowerCase()) failed.push("contract");
  if (json.block_hash.toLowerCase() !== canonicalBlockHash.toLowerCase()) failed.push("block_hash");
  if (json.vkey.toLowerCase() !== EXPECTED_VKEY.toLowerCase()) failed.push("vkey");
  if (isAlreadySettled(json.intent_id)) failed.push("already_settled");
  if (BigInt(json.destination_chain_id) !== SOLANA_CHAIN_ID) failed.push("destination_chain_id");
  if (Math.floor(Date.now() / 1000) >= json.expiry) failed.push("expiry");
  return { ok: failed.length === 0, failedChecks: failed };
}
