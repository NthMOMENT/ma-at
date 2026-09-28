// Crash-safe local ledger for the Arbitrum-side settlement sequence
// (postCollateral -> confirmSettlement, or -> slashSolver) — the same role
// prover_pipeline.ts's settledLedger plays for the Solana leg, kept as a
// SEPARATE file/authority rather than merged into it, mirroring that split
// (this ledger decides whether arbitrum_settlement.ts may (re)broadcast a
// tx; intent_state.ts's `arbitrumSettlement` field only mirrors it for
// display — never consult that for the gate).
//
// Every stage transition that follows a broadcast is recorded via the
// tx-hash-BEFORE-broadcast pattern used everywhere else in this codebase
// (settle_intent.js's SETTLING_SIG handshake; prover_pipeline.ts's
// markSettling) — see arbitrum_settlement.ts's onSigned callbacks.
import * as fs from "fs";
import * as path from "path";

export type ArbitrumStage =
  | "posting_collateral"
  | "collateral_posted"
  | "collateral_failed"
  | "confirming"
  | "confirmed"
  | "awaiting_expiry_slash"
  | "slashing"
  | "slashed";

export interface ArbitrumLedgerEntry {
  stage: ArbitrumStage;
  collateralTxHash?: string;
  confirmTxHash?: string;
  slashTxHash?: string;
  /** json.expiry (unix seconds) — recorded once collateral is posted, so the
   *  slash poller doesn't need to re-derive it from the proof JSON later. */
  expiry?: number;
  /** Which configured ARBITRUM_SOLVER_PRIVATE_KEY* address posted collateral
   *  for this intent — written at the posting_collateral transition, BEFORE
   *  broadcast (same tx-hash-before-broadcast timing as collateralTxHash
   *  itself). Entries written before this field existed have none; callers
   *  default to the orchestrator's first configured solver and rely on the
   *  existing on-chain solver check (arbitrum_settlement.ts's Step 2) to
   *  catch any real disagreement — see resumeCollateralPostedIntent. */
  solver?: `0x${string}`;
  updatedAt: string;
}

const LEDGER_PATH = process.env.ARBITRUM_LEDGER_PATH ?? path.resolve(__dirname, "../arbitrum_settled_intents.json");

function keyOf(intentId: string): string {
  return intentId.replace(/^0x/i, "").toLowerCase();
}

function loadLedger(): Map<string, ArbitrumLedgerEntry> {
  const ledger = new Map<string, ArbitrumLedgerEntry>();
  try {
    const raw = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8")) as Record<string, ArbitrumLedgerEntry>;
    for (const [id, entry] of Object.entries(raw)) {
      ledger.set(id, entry);
    }
  } catch {
    // First run, or file doesn't exist yet — start empty.
  }
  return ledger;
}

const ledger = loadLedger();

function persist(): void {
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(Object.fromEntries(ledger), null, 2));
}

export function getArbitrumLedgerEntry(intentId: string): ArbitrumLedgerEntry | undefined {
  return ledger.get(keyOf(intentId));
}

export function setArbitrumStage(intentId: string, stage: ArbitrumStage, patch: Partial<ArbitrumLedgerEntry> = {}): void {
  const key = keyOf(intentId);
  const prev = ledger.get(key);
  ledger.set(key, { ...prev, ...patch, stage, updatedAt: new Date().toISOString() });
  persist();
}

/** Every intent whose ledger stage is mid-sequence — a tx was signed (its
 *  hash recorded) but this process never confirmed the outcome, most likely
 *  because it crashed or restarted between signing and confirming. The
 *  caller (listener.ts, on boot) must resolve each via the chain itself —
 *  see reconcileArbitrumLedger in arbitrum_settlement.ts — never blindly
 *  re-broadcast. */
export function getMidSequenceEntries(): Array<{ intentId: string; entry: ArbitrumLedgerEntry }> {
  const out: Array<{ intentId: string; entry: ArbitrumLedgerEntry }> = [];
  for (const [intentId, entry] of ledger.entries()) {
    if (entry.stage === "posting_collateral" || entry.stage === "confirming" || entry.stage === "slashing") {
      out.push({ intentId, entry });
    }
  }
  return out;
}

export function getAwaitingExpirySlashEntries(): Array<{ intentId: string; entry: ArbitrumLedgerEntry }> {
  const out: Array<{ intentId: string; entry: ArbitrumLedgerEntry }> = [];
  for (const [intentId, entry] of ledger.entries()) {
    if (entry.stage === "awaiting_expiry_slash") out.push({ intentId, entry });
  }
  return out;
}

/** Collateral landed but the sequence never reached confirmSettlement — a gap
 *  reconcileArbitrumLedger flags for manual follow-up rather than silently
 *  auto-resuming (see that function's doc comment). */
export function getCollateralPostedEntries(): Array<{ intentId: string; entry: ArbitrumLedgerEntry }> {
  const out: Array<{ intentId: string; entry: ArbitrumLedgerEntry }> = [];
  for (const [intentId, entry] of ledger.entries()) {
    if (entry.stage === "collateral_posted") out.push({ intentId, entry });
  }
  return out;
}
