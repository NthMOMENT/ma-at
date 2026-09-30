// Week 3 design (solver credit scoring), Phase 3: routing. Picks WHICH
// configured solver posts collateral for an intent, then hands off to the
// existing, unchanged runArbitrumSettlementSequence with that solver's deps.
//
// Plugged in immediately BEFORE runArbitrumSettlementSequence's call site
// (dispatchArbitrumSettlement, called from listener.ts), not inside it — the
// sequence, its signature and every one of its existing branches stay as
// they were; it only gains an optional deps.routing it spreads into its
// pre-broadcast ledger writes. evaluateArbitrumGate still runs inside the
// sequence as the final check on the selected solver (Phase 1's design).
//
// L1: every gate input is read fresh per intent — approval, balance, the
// intent's own on-chain state, the solver track record. Nothing here caches
// a tier or a balance across intents. L5: no eligible solver -> no
// collateral, the reason for EACH candidate recorded, via the same refusal
// path the sequence itself uses. L7: in-memory capital reservations stop two
// selections double-booking one solver's last capital and cover a lagging
// RPC read for RESERVATION_HOLD_SEC after collateral confirms.
import * as fs from "fs";
import * as path from "path";
import type { PublicClient } from "viem";
import type { ProofOutputJson } from "./prover_pipeline";
import {
  evaluateArbitrumGate,
  runArbitrumSettlementSequence,
  refuseArbitrumSettlement,
  configuredSolverAddresses,
  isSolverApprovedOnChain,
  MAX_TRANSFER_WEI,
  DELIVERY_MARGIN_SEC,
  ARBITRUM_GAS_BUFFER_WEI,
  type ArbitrumSettlementDeps,
  type OnChainIntent,
  type TxOutcome,
} from "./arbitrum_settlement";
import { getArbitrumLedgerEntry, getPostingCollateralEntries, type ArbitrumLedgerEntry } from "./arbitrum_ledger";
import {
  readSolverRecord,
  listKnownIntentIds,
  computeTier,
  tierCapWei,
  defaultTierConfig,
  defaultTierCapPct,
  type ReadSolverRecordResult,
  type SolverRecord,
  type TierConfig,
  type TierCapPct,
} from "./solver_stats";
import { INTENT_STATUS_PENDING } from "./intent_status";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const EMPTY_RECORD: SolverRecord = { settled: 0, slashed: 0, refunded: 0, expired: 0, excluded: 0, resolved: 0, successRate: null };

function addrKey(address: string): string {
  return address.toLowerCase();
}

function intentKey(intentId: string): string {
  return intentId.replace(/^0x/i, "").toLowerCase();
}

// ─── Capital reservations (§3.4) ─────────────────────────────────────────────
// In-memory only, never persisted: on restart the chain and the ledger are
// the truth (L3), and a still-Pending intent simply gets a fresh selection.
// The same object also owns the selection mutex, so "atomic with respect to
// other selections" and "the reservations those selections read and write"
// can never be two separately-constructed things.

interface Reservation {
  wei: bigint;
  /** null while the collateral tx is unresolved; set once it confirms. */
  releaseAtMs: number | null;
}

export class ReservationBook {
  private readonly bySolver = new Map<string, Map<string, Reservation>>();
  private lock: Promise<void> = Promise.resolve();

  constructor(private readonly nowMs: () => number = Date.now) {}

  /** Serializes fn against every other runExclusive call on this book. */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  reserve(solver: string, intentId: string, wei: bigint): void {
    const s = addrKey(solver);
    let forSolver = this.bySolver.get(s);
    if (!forSolver) {
      forSolver = new Map();
      this.bySolver.set(s, forSolver);
    }
    forSolver.set(intentKey(intentId), { wei, releaseAtMs: null });
  }

  /** Collateral confirmed: keep counting it for holdMs more (a lagging RPC
   *  node may still report the pre-collateral balance), then it lapses. */
  holdFor(solver: string, intentId: string, holdMs: number): void {
    const r = this.bySolver.get(addrKey(solver))?.get(intentKey(intentId));
    if (r && r.releaseAtMs === null) r.releaseAtMs = this.nowMs() + holdMs;
  }

  /** Returns true only for the call that actually removed it. */
  release(solver: string, intentId: string): boolean {
    return this.bySolver.get(addrKey(solver))?.delete(intentKey(intentId)) ?? false;
  }

  reservedWei(solver: string): bigint {
    const forSolver = this.bySolver.get(addrKey(solver));
    if (!forSolver) return 0n;
    const now = this.nowMs();
    let total = 0n;
    for (const [id, r] of forSolver) {
      if (r.releaseAtMs !== null && now >= r.releaseAtMs) {
        forSolver.delete(id);
        continue;
      }
      total += r.wei;
    }
    return total;
  }

  hasIntent(intentId: string): boolean {
    const k = intentKey(intentId);
    for (const forSolver of this.bySolver.values()) if (forSolver.has(k)) return true;
    return false;
  }
}

// ─── Onboarding tiers (orchestrator/solver_onboarding.json, committed) ──────
// Unknown solver, bad entry, or missing/corrupt file -> tier 3 (probation,
// the smallest cap) with a warning: fail toward less credit, never more.

export function loadOnboardingTiers(filePath: string = path.resolve(__dirname, "../solver_onboarding.json")): (solver: string) => number {
  const tiers = new Map<string, number>();
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!Array.isArray(raw)) throw new Error("not an array");
    for (const entry of raw) {
      if (typeof entry?.solver === "string" && [1, 2, 3].includes(entry?.onboardingTier)) {
        tiers.set(addrKey(entry.solver), entry.onboardingTier);
      } else {
        console.warn(`[ROUTING] WARNING: ignoring malformed entry in ${filePath}`);
      }
    }
  } catch (err) {
    console.warn(`[ROUTING] WARNING: failed to read ${filePath} (${(err as Error).message}) — every solver defaults to onboarding tier 3`);
  }
  return (solver) => {
    const tier = tiers.get(addrKey(solver));
    if (tier === undefined) {
      console.warn(`[ROUTING] WARNING: solver ${solver} has no onboarding tier in ${filePath} — defaulting to tier 3`);
      return 3;
    }
    return tier;
  };
}

export function reservationHoldSec(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.RESERVATION_HOLD_SEC ?? 30);
}

// ─── selectSolver (§3.1) ─────────────────────────────────────────────────────

export interface RoutingIntent {
  id: `0x${string}`;
  json: ProofOutputJson;
}

export interface SelectionDeps {
  isApproved(solver: `0x${string}`): Promise<boolean>;
  getBalanceWei(solver: `0x${string}`): Promise<bigint>;
  /** The same intents(id) reader as ArbitrumSettlementDeps.readIntent. */
  readIntent(intentId: `0x${string}`): Promise<OnChainIntent>;
  getSolverRecords(): Promise<ReadSolverRecordResult>;
  getOnboardingTier(solver: `0x${string}`): number;
  getPostingCollateralEntries(): Array<{ intentId: string; entry: ArbitrumLedgerEntry }>;
  reservations: ReservationBook;
  gate: { maxTransferWei: bigint; gasBufferWei: bigint; deliveryMarginSec: number };
  tierConfig: TierConfig;
  tierCapPct: TierCapPct;
}

export interface CandidateEvaluation {
  solver: `0x${string}`;
  eligible: boolean;
  /** Every gate this candidate failed; empty when eligible. */
  reasons: string[];
  tier: number | null;
  tierCapWei: bigint | null;
  successRate: number | null;
  /** Fresh balance minus every reservation, BEFORE this intent. */
  availableWei: bigint | null;
}

export interface SelectionResult {
  solver: `0x${string}` | null;
  tier: number | null;
  reason: string;
  collateralWei: bigint;
  /** collateral + gas buffer — what was reserved for the winner. */
  reservationWei: bigint;
  candidates: CandidateEvaluation[];
}

type Read<T> = { ok: true; value: T } | { ok: false };

async function attempt<T>(fn: () => Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch {
    return { ok: false };
  }
}

/// Reads every input fresh (under the book's mutex), then evaluates gates,
/// ranks survivors and reserves the winner in ONE synchronous step — no
/// await between reading reservations and writing the winner's.
export function selectSolver(candidates: `0x${string}`[], intent: RoutingIntent, nowSec: number, deps: SelectionDeps): Promise<SelectionResult> {
  return deps.reservations.runExclusive(async () => {
    const onChain = await attempt(() => deps.readIntent(intent.id));
    const stats = await attempt(() => deps.getSolverRecords());
    const reads: Array<{ solver: `0x${string}`; approved: Read<boolean>; balance: Read<bigint> }> = [];
    for (const solver of candidates) {
      reads.push({ solver, approved: await attempt(() => deps.isApproved(solver)), balance: await attempt(() => deps.getBalanceWei(solver)) });
    }
    // ── No await below this line. ──
    return decide(reads, intent, nowSec, deps, onChain, stats);
  });
}

function decide(
  reads: Array<{ solver: `0x${string}`; approved: Read<boolean>; balance: Read<bigint> }>,
  intent: RoutingIntent,
  nowSec: number,
  deps: SelectionDeps,
  onChain: Read<OnChainIntent>,
  stats: Read<ReadSolverRecordResult>
): SelectionResult {
  const { json } = intent;
  const amountWei = BigInt(json.amount);
  const collateralWei = (amountWei * 150n) / 100n; // same formula as runArbitrumSettlementSequence
  const reservationWei = collateralWei + deps.gate.gasBufferWei;

  let intentFailure: string | null = null;
  if (!onChain.ok) {
    intentFailure = "intent_read_failed";
  } else if (onChain.value.status !== INTENT_STATUS_PENDING || onChain.value.solver.toLowerCase() !== ZERO_ADDRESS) {
    intentFailure = `intent_not_open_onchain(status=${onChain.value.status},solver=${onChain.value.solver})`;
  }

  // Signed-but-unconfirmed collateral txs from the ledger, minus any this
  // process is already counting in memory (never both).
  const inFlight = deps.getPostingCollateralEntries().filter(({ intentId }) => !deps.reservations.hasIntent(intentId));
  const ledgerReservedWei = (solver: string): bigint => {
    let total = 0n;
    for (const { entry } of inFlight) {
      // A legacy entry (pre-Phase-1) has no solver: count it against every
      // candidate. A legacy entry (pre-Phase-3) has no collateralWei: assume
      // the largest possible collateral. Both only ever shrink availability.
      if (entry.solver && addrKey(entry.solver) !== addrKey(solver)) continue;
      const collateral = entry.collateralWei ? BigInt(entry.collateralWei) : (deps.gate.maxTransferWei * 150n) / 100n;
      total += collateral + deps.gate.gasBufferWei;
    }
    return total;
  };

  const evaluations: CandidateEvaluation[] = reads.map(({ solver, approved, balance }) => {
    const reasons: string[] = [];
    if (!approved.ok) reasons.push("approval_read_failed");
    else if (!approved.value) reasons.push("not_approved");

    let availableWei: bigint | null = null;
    const gateParams = { maxTransferWei: deps.gate.maxTransferWei, gasBufferWei: deps.gate.gasBufferWei, nowSec, deliveryMarginSec: deps.gate.deliveryMarginSec };
    if (!balance.ok) {
      reasons.push("balance_read_failed");
      const gate = evaluateArbitrumGate(json, { ...gateParams, solverBalanceWei: 0n });
      reasons.push(...gate.failedChecks.filter((c) => c !== "insufficient_solver_balance"));
    } else {
      availableWei = balance.value - deps.reservations.reservedWei(solver) - ledgerReservedWei(solver);
      const gate = evaluateArbitrumGate(json, { ...gateParams, solverBalanceWei: availableWei });
      for (const check of gate.failedChecks) {
        reasons.push(check === "insufficient_solver_balance" ? `insufficient_available_capital(available=${availableWei},required=${reservationWei})` : check);
      }
    }
    if (intentFailure) reasons.push(intentFailure);

    let tier: number | null = null;
    let cap: bigint | null = null;
    let successRate: number | null = null;
    if (!stats.ok) {
      reasons.push("track_record_unavailable");
    } else {
      const record = stats.value.records[addrKey(solver)] ?? EMPTY_RECORD;
      tier = computeTier(deps.getOnboardingTier(solver), record, deps.tierConfig, stats.value.complete);
      cap = tierCapWei(tier as 1 | 2 | 3, deps.gate.maxTransferWei, deps.tierCapPct);
      successRate = record.successRate;
      if (cap < amountWei) reasons.push(`tier_cap_exceeded(T${tier} cap=${cap} < amount=${amountWei})`);
    }

    return { solver, eligible: reasons.length === 0, reasons, tier, tierCapWei: cap, successRate, availableWei };
  });

  const survivors = evaluations.filter((e) => e.eligible);
  const byRate = (e: CandidateEvaluation) => e.successRate ?? -1; // no history ranks below any recorded rate
  survivors.sort(
    (a, b) =>
      cmpBig(a.tierCapWei!, b.tierCapWei!) || // smallest tier cap first
      byRate(b) - byRate(a) || // then higher success rate
      cmpBig(b.availableWei!, a.availableWei!) || // then more capital left after this intent (same reservation for all)
      (addrKey(a.solver) < addrKey(b.solver) ? -1 : addrKey(a.solver) > addrKey(b.solver) ? 1 : 0) // then lowest address
  );

  const winner = survivors[0];
  if (!winner) {
    const detail = evaluations.length === 0 ? "no solvers configured" : evaluations.map((e) => `${e.solver}: ${e.reasons.join(", ")}`).join("; ");
    return { solver: null, tier: null, reason: `no eligible solver — ${detail}`, collateralWei, reservationWei, candidates: evaluations };
  }

  let why = "only eligible solver";
  const runnerUp = survivors[1];
  if (runnerUp) {
    if (winner.tierCapWei !== runnerUp.tierCapWei) why = "smallest eligible tier cap";
    else if (byRate(winner) !== byRate(runnerUp)) why = "higher success rate";
    else if (winner.availableWei !== runnerUp.availableWei) why = "more available capital";
    else why = "lowest-address tie-break";
  }

  deps.reservations.reserve(winner.solver, intent.id, reservationWei);
  return { solver: winner.solver, tier: winner.tier, reason: `selected ${winner.solver} (T${winner.tier}): ${why}`, collateralWei, reservationWei, candidates: evaluations };
}

function cmpBig(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ─── dispatchArbitrumSettlement (§3.2) ───────────────────────────────────────

export interface DispatchDeps extends SelectionDeps {
  candidates(): `0x${string}`[];
  /** buildRealDeps bound to one configured solver (listener.ts supplies it). */
  buildSettlementDeps(solverAddress: `0x${string}`): ArbitrumSettlementDeps;
  nowSec(): number;
  reservationHoldMs: number;
}

/// Replaces listener.ts's direct runArbitrumSettlementSequence call: select a
/// solver, then run the unchanged sequence with that solver's deps. Returns
/// the selection (null when routing never ran because the intent is already
/// mid-sequence).
export async function dispatchArbitrumSettlement(deps: DispatchDeps, intentId: `0x${string}`, json: ProofOutputJson): Promise<SelectionResult | null> {
  const candidates = deps.candidates();

  const existing = getArbitrumLedgerEntry(intentId);
  if (existing && existing.stage !== "collateral_failed") {
    // Already mid/past the sequence: the sequence's own guard alerts and
    // returns before using deps (so which solver's deps doesn't matter).
    // Routing must NOT run here — a "no eligible solver" outcome would
    // overwrite this live entry with collateral_failed.
    await runArbitrumSettlementSequence(deps.buildSettlementDeps(candidates[0]), intentId, json);
    return null;
  }

  const selection = await selectSolver(candidates, { id: intentId, json }, deps.nowSec(), deps);
  console.log(`[ROUTING] intent ${intentId}: ${selection.reason}`);

  if (!selection.solver) {
    const reason = `Arbitrum solver routing REFUSED (${selection.reason}) — no collateral posted; user can reclaim via cancelIntent once the intent expires`;
    refuseArbitrumSettlement(intentId, json, reason, { selectedSolver: null, tierAtSelection: null, routingReason: selection.reason });
    return selection;
  }

  const solver = selection.solver;
  // The reservation leaves "pending" exactly once: released on any failure,
  // or put on RESERVATION_HOLD_SEC hold once postCollateral confirms (at
  // which point the sequence immediately records collateral_posted).
  let reservationResolved = false;
  const releaseReservation = (): void => {
    if (reservationResolved) return;
    reservationResolved = true;
    deps.reservations.release(solver, intentId);
  };

  try {
    const base = deps.buildSettlementDeps(solver);
    const settlementDeps: ArbitrumSettlementDeps = {
      ...base,
      routing: { selectedSolver: solver, tierAtSelection: selection.tier, routingReason: selection.reason, collateralWei: selection.collateralWei.toString() },
      async postCollateral(id, valueWei, onSigned) {
        let outcome: TxOutcome;
        try {
          outcome = await base.postCollateral(id, valueWei, onSigned);
        } catch (err) {
          releaseReservation();
          throw err;
        }
        if (outcome.ok) {
          reservationResolved = true;
          deps.reservations.holdFor(solver, intentId, deps.reservationHoldMs);
        } else {
          releaseReservation();
        }
        return outcome;
      },
    };
    await runArbitrumSettlementSequence(settlementDeps, intentId, json);
  } finally {
    // No-op if already released or on hold. Covers the sequence ending
    // before postCollateral ever ran (final gate refused) or throwing.
    releaseReservation();
  }
  return selection;
}

// ─── Real wiring ─────────────────────────────────────────────────────────────

/** One book per process — every intent's selection shares it. */
const processReservations = new ReservationBook();

export function buildRealRoutingDeps(
  publicClient: PublicClient,
  intentManagerAddress: `0x${string}`,
  buildSettlementDeps: (solverAddress: `0x${string}`) => ArbitrumSettlementDeps
): DispatchDeps {
  const candidates = configuredSolverAddresses();
  // Same intents(id) reader the sequence uses (the read is solver-independent).
  const reader = buildSettlementDeps(candidates[0]);
  return {
    candidates: () => candidates,
    buildSettlementDeps,
    nowSec: () => Math.floor(Date.now() / 1000),
    reservationHoldMs: reservationHoldSec() * 1000,
    isApproved: (solver) => isSolverApprovedOnChain(publicClient, intentManagerAddress, solver),
    getBalanceWei: (solver) => publicClient.getBalance({ address: solver }),
    readIntent: (id) => reader.readIntent(id),
    getSolverRecords: () => readSolverRecord({ readIntent: (id) => reader.readIntent(id) }, listKnownIntentIds()),
    getOnboardingTier: loadOnboardingTiers(),
    getPostingCollateralEntries,
    reservations: processReservations,
    gate: { maxTransferWei: MAX_TRANSFER_WEI, gasBufferWei: ARBITRUM_GAS_BUFFER_WEI, deliveryMarginSec: DELIVERY_MARGIN_SEC },
    tierConfig: defaultTierConfig(),
    tierCapPct: defaultTierCapPct(),
  };
}
