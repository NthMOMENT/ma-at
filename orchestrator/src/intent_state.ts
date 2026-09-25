// Per-intent state records — the single source of truth the /proof dashboard
// reads (ma-at-web's app/api/proofs/route.ts, by absolute path via
// MAAT_STATE_DIR). One JSON file per intent under STATE_DIR, not one shared
// file: listener.ts (EVM) and tron_listener.ts (TRON) are separate
// processes, so a shared file would need cross-process locking to avoid a
// read-modify-write race; per-intent files sidestep that entirely, since two
// processes only ever write the same intentId's file if the same intent
// somehow arrived on two chains at once, which cannot happen.
//
// This module does NOT replace settled_intents.json (prover_pipeline.ts) as
// the settle gate's double-settle authority — that ledger keeps deciding
// whether settle_intent.js may run (see isAlreadySettled/markSettling/
// markSettled there). The `settlement` field on IntentState only mirrors
// that ledger's outcome, for display — never consult it for the gate.
import * as fs from "fs";
import * as path from "path";

export const STATE_DIR = process.env.MAAT_STATE_DIR ?? path.resolve(__dirname, "../state/intents");

export type ProofStatusKind = "queued" | "proving" | "retrying" | "verified" | "rejected" | "alert" | "skipped";

export interface ProofStatus {
  kind: ProofStatusKind;
  /** Present only when kind === "retrying": the attempt about to run. */
  attempt?: number;
  /** Present only when kind === "retrying". */
  maxAttempts?: number;
  /** Present only when kind === "skipped": the source chain with no prover support. */
  chain?: string;
}

export type SettlementKind = "none" | "settling" | "settled" | "unconfirmed-needs-review";

export interface SettlementStatus {
  kind: SettlementKind;
  /** The Solana payout tx signature, once signed. */
  sig?: string;
}

export type FinalityStatus = "pending" | "final";

export interface IntentStateTimestamps {
  queuedAt?: string;
  provingStartedAt?: string;
  verifiedAt?: string;
  settlingAt?: string;
  settledAt?: string;
  finalAt?: string;
}

export interface IntentState {
  intentId: string;
  sourceChain: string;
  sourceTxHash: string;
  blockNumber: number | null;
  blockHash: string | null;
  amountWei: string;
  tokenAddress: string;
  destinationChainId: string;
  /** Base58 for a Solana destination — see decodeDestinationWallet in listener.ts. */
  destinationWallet: string;
  vkey: string | null;
  proofStatus: ProofStatus;
  /** Set only when proofStatus.kind === "rejected". */
  rejectReason: string | null;
  /**
   * Human-readable text from the most recent alert() call touching this
   * intent, at ANY stage (prover, settle gate, settlement spawn) — kept
   * independent of proofStatus.kind so a settle-gate refusal or a
   * settlement-script failure after a successful proof doesn't overwrite a
   * true "verified" proofStatus with a misleading generic "alert" one.
   */
  alertReason: string | null;
  settlement: SettlementStatus;
  finality: FinalityStatus;
  timestamps: IntentStateTimestamps;
  updatedAt: string;
}

function keyOf(intentId: string): string {
  return intentId.replace(/^0x/i, "").toLowerCase();
}

function filePathOf(intentId: string): string {
  return path.join(STATE_DIR, `${keyOf(intentId)}.json`);
}

function ensureDir(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

export function readState(intentId: string): IntentState | null {
  try {
    return JSON.parse(fs.readFileSync(filePathOf(intentId), "utf8")) as IntentState;
  } catch {
    return null;
  }
}

// Atomic write: temp file + rename (same filesystem, since both live under
// STATE_DIR) — the web API route's readdir+readFileSync pass never observes
// a partially-written JSON file, and a crash mid-write leaves only an
// orphaned .tmp file, never a corrupt .json one.
function writeStateFile(state: IntentState): void {
  ensureDir();
  const final = filePathOf(state.intentId);
  const tmp = `${final}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, final);
}

function blankState(intentId: string): IntentState {
  return {
    intentId,
    sourceChain: "unknown",
    sourceTxHash: "unknown",
    blockNumber: null,
    blockHash: null,
    amountWei: "0",
    tokenAddress: "unknown",
    destinationChainId: "unknown",
    destinationWallet: "unknown",
    vkey: null,
    proofStatus: { kind: "queued" },
    rejectReason: null,
    alertReason: null,
    settlement: { kind: "none" },
    finality: "pending",
    timestamps: {},
    updatedAt: new Date().toISOString(),
  };
}

// Every setter below goes through this — including ones invoked from
// contexts (boot-time ledger reconciliation, an old ledger entry that
// predates this file existing) where no prior state record is guaranteed to
// exist. Falling back to a placeholder rather than throwing keeps a missing
// record from ever crashing either listener process.
function upsert(intentId: string, patch: (prev: IntentState) => IntentState): void {
  const prev = readState(intentId) ?? blankState(intentId);
  const next = patch(prev);
  next.updatedAt = new Date().toISOString();
  writeStateFile(next);
}

// ─── Creation — called once per intent, from logIntentCreated ───────────────

export interface IntentCreatedFields {
  intentId: string;
  sourceChain: string;
  sourceTxHash: string;
  blockNumber: number | null;
  blockHash: string | null;
  amountWei: string;
  tokenAddress: string;
  destinationChainId: string;
  destinationWallet: string;
}

export function recordIntentCreated(fields: IntentCreatedFields, proofStatus: ProofStatus): void {
  upsert(fields.intentId, (prev) => ({
    ...prev,
    intentId: fields.intentId,
    sourceChain: fields.sourceChain,
    sourceTxHash: fields.sourceTxHash,
    blockNumber: fields.blockNumber,
    blockHash: fields.blockHash,
    amountWei: fields.amountWei,
    tokenAddress: fields.tokenAddress,
    destinationChainId: fields.destinationChainId,
    destinationWallet: fields.destinationWallet,
    proofStatus,
    timestamps: {
      ...prev.timestamps,
      queuedAt: proofStatus.kind === "queued" ? new Date().toISOString() : prev.timestamps.queuedAt,
    },
  }));
}

// ─── Stage transitions — proof side (called from prover_pipeline.ts) ────────

export function setProving(intentId: string): void {
  upsert(intentId, (prev) => ({
    ...prev,
    proofStatus: { kind: "proving" },
    timestamps: { ...prev.timestamps, provingStartedAt: prev.timestamps.provingStartedAt ?? new Date().toISOString() },
  }));
}

export function setRetrying(intentId: string, attempt: number, maxAttempts: number): void {
  upsert(intentId, (prev) => ({ ...prev, proofStatus: { kind: "retrying", attempt, maxAttempts } }));
}

export function setVerified(intentId: string, vkey: string): void {
  upsert(intentId, (prev) => ({
    ...prev,
    vkey,
    proofStatus: { kind: "verified" },
    timestamps: { ...prev.timestamps, verifiedAt: new Date().toISOString() },
  }));
}

export function setRejected(intentId: string, reason: string): void {
  upsert(intentId, (prev) => ({ ...prev, proofStatus: { kind: "rejected" }, rejectReason: reason }));
}

export function setAlert(intentId: string, reason: string): void {
  upsert(intentId, (prev) => ({ ...prev, proofStatus: { kind: "alert" }, alertReason: reason }));
}

/** Records an alert's text without downgrading proofStatus — see the
 *  `alertReason` doc comment on IntentState for why. */
export function recordAlertReason(intentId: string, reason: string): void {
  upsert(intentId, (prev) => ({ ...prev, alertReason: reason }));
}

// ─── Stage transitions — settlement side ─────────────────────────────────────
// Called alongside (never instead of) prover_pipeline.ts's markSettling/
// markSettled, which remain the settle gate's actual authority.

export function setSettling(intentId: string, sig: string): void {
  upsert(intentId, (prev) => ({
    ...prev,
    settlement: { kind: "settling", sig },
    timestamps: { ...prev.timestamps, settlingAt: new Date().toISOString() },
  }));
}

export function setSettled(intentId: string, sig: string): void {
  upsert(intentId, (prev) => ({
    ...prev,
    settlement: { kind: "settled", sig },
    timestamps: { ...prev.timestamps, settledAt: new Date().toISOString() },
  }));
}

export function setUnconfirmedNeedsReview(intentId: string, sig: string): void {
  upsert(intentId, (prev) => ({ ...prev, settlement: { kind: "unconfirmed-needs-review", sig } }));
}

// ─── Finality (orchestrator-side poller only — see listener.ts) ─────────────

/** Pure comparison, split out from the RPC call so it's testable without a
 *  live arbClient — see intent_state.gate.test.ts. */
export function isBlockFinal(blockNumber: number, finalizedBlockNumber: number): boolean {
  return blockNumber <= finalizedBlockNumber;
}

export function listPendingFinality(sourceChain: string): IntentState[] {
  ensureDir();
  const out: IntentState[] = [];
  for (const name of fs.readdirSync(STATE_DIR)) {
    if (!name.endsWith(".json")) continue;
    try {
      const state = JSON.parse(fs.readFileSync(path.join(STATE_DIR, name), "utf8")) as IntentState;
      if (state.sourceChain === sourceChain && state.finality === "pending" && state.blockNumber != null) {
        out.push(state);
      }
    } catch {
      // Skip a file mid-write (pre-rename .tmp siblings never match the
      // .json suffix above) or otherwise unreadable — next poll picks it up.
    }
  }
  return out;
}

export function setFinal(intentId: string): void {
  upsert(intentId, (prev) => ({
    ...prev,
    finality: "final",
    timestamps: { ...prev.timestamps, finalAt: new Date().toISOString() },
  }));
}

// ─── Listing (web API route reads state files directly, not via this — kept
// here only for the orchestrator's own use, e.g. tests) ──────────────────────

export function listAllStates(): IntentState[] {
  ensureDir();
  const out: IntentState[] = [];
  for (const name of fs.readdirSync(STATE_DIR)) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(STATE_DIR, name), "utf8")) as IntentState);
    } catch {
      // skip
    }
  }
  return out;
}
