// Gate test (Week 3 design, Phase 3 — routing): selectSolver's hard gates,
// tier filter, ranking and tie-breaks; capital reservations under
// concurrency; dispatchArbitrumSettlement's integration with the unchanged
// runArbitrumSettlementSequence; and the L6 slash guard with two solvers.
// Mocked chain calls only (an in-memory FakeChain) — no real RPC, no real
// signing, no live transfers. Same "no test runner" pattern as the other
// *.gate.test.ts files.
//
// Every path is fresh per run (mktemp). Run with:
//
//   MAAT_STATE_DIR=$(mktemp -d) \
//   SETTLED_LEDGER_PATH=$(mktemp -u) \
//   ALERT_LOG_PATH=$(mktemp -u) \
//   ARBITRUM_LEDGER_PATH=$(mktemp -u) \
//   ZK_DIR_PATH=$(mktemp -d) \
//   ALCHEMY_RPC_URL_1=https://example-placeholder.invalid/v2/test \
//   ARBITRUM_SOLVER_PRIVATE_KEY=0x1111111111111111111111111111111111111111111111111111111111111111 \
//   ARBITRUM_ORCHESTRATOR_PRIVATE_KEY=0x2222222222222222222222222222222222222222222222222222222222222222 \
//   SOLANA_PAYOUT_RETRY_INTERVAL_MS=1000 \
//   CONFIRM_RETRY_BACKOFF_MS=200,200,200,200 \
//   POST_COLLATERAL_VERIFY_DELAY_MS=50 \
//   npx ts-node src/solver_routing.gate.test.ts
//
// MAX_TRANSFER_WEI / DELIVERY_MARGIN_SEC / ARBITRUM_GAS_BUFFER_WEI must be
// left at their defaults (0.01 ETH / 600s / 0.001 ETH): the amounts below
// are sized against them.
import * as fs from "fs";
import * as path from "path";

for (const v of [
  "MAAT_STATE_DIR",
  "SETTLED_LEDGER_PATH",
  "ALERT_LOG_PATH",
  "ARBITRUM_LEDGER_PATH",
  "ZK_DIR_PATH",
  "ALCHEMY_RPC_URL_1",
  "ARBITRUM_SOLVER_PRIVATE_KEY",
  "ARBITRUM_ORCHESTRATOR_PRIVATE_KEY",
]) {
  if (!process.env[v]) {
    console.error(`[gate-test] refusing to run without ${v} set (see this file's header comment)`);
    process.exit(1);
  }
}
for (const v of ["MAX_TRANSFER_WEI", "DELIVERY_MARGIN_SEC", "ARBITRUM_GAS_BUFFER_WEI"]) {
  if (process.env[v]) {
    console.error(`[gate-test] refusing to run with ${v} set — amounts here are sized against its default`);
    process.exit(1);
  }
}

import {
  runArbitrumSettlementSequence,
  pollAwaitingSlash,
  MAX_TRANSFER_WEI,
  DELIVERY_MARGIN_SEC,
  ARBITRUM_GAS_BUFFER_WEI,
  type ArbitrumSettlementDeps,
  type OnChainIntent,
} from "./arbitrum_settlement";
import { getArbitrumLedgerEntry, setArbitrumStage, getPostingCollateralEntries, type ArbitrumLedgerEntry } from "./arbitrum_ledger";
import { readState } from "./intent_state";
import { markSettling, type ProofOutputJson } from "./prover_pipeline";
import { selectSolver, dispatchArbitrumSettlement, ReservationBook, loadOnboardingTiers, type DispatchDeps, type SelectionDeps } from "./solver_routing";
import { INTENT_STATUS_PENDING, INTENT_STATUS_SETTLED } from "./intent_status";
import type { ReadSolverRecordResult, SolverRecord } from "./solver_stats";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    console.error(`  FAIL ${name}`);
    failures++;
  }
}

const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;
const SOLVER_A = "0xE39677A621d3f232E9b6A97e84aCD03443540a61" as `0x${string}`; // onboarding T2
const SOLVER_B = "0xb1cc4DB8EC2430E60aaf1b1B8e564b8364383637" as `0x${string}`; // onboarding T1
const SOLVER_C = "0x00000000000000000000000000000000000000c3" as `0x${string}`; // synthetic, tie-break tests
const ORCHESTRATOR = ("0x" + "60".repeat(20)) as `0x${string}`;

// Sized against the defaults: MAX 0.01 ETH -> caps T1 0.01, T2 0.003, T3 0.0005 ETH.
const SMALL = 1_000_000_000_000_000n; // 0.001 ETH: fits T1 and T2
const LARGE = 5_000_000_000_000_000n; // 0.005 ETH: above T2's cap, fits T1
const RESERVE_SMALL = (SMALL * 150n) / 100n + ARBITRUM_GAS_BUFFER_WEI; // 0.0025 ETH
const PLENTY = 10n ** 18n;

const TIERS: Record<string, number> = { [SOLVER_A.toLowerCase()]: 2, [SOLVER_B.toLowerCase()]: 1, [SOLVER_C.toLowerCase()]: 2 };
const TIER_CONFIG = { promoteMinResolved: 10, promoteMinSuccess: 0.95, demoteMinResolved: 3, demoteMaxSuccess: 0.8 };
const CAP_PCT = { 1: 100, 2: 30, 3: 5 };

let idCounter = 0x100;
function freshId(): `0x${string}` {
  idCounter++;
  return ("0x" + idCounter.toString(16).padStart(64, "0")) as `0x${string}`;
}
function hexOf(id: string): string {
  return id.replace(/^0x/, "").toLowerCase();
}

function baseJson(id: `0x${string}`, overrides: Partial<ProofOutputJson> = {}): ProofOutputJson {
  return {
    tx_hash: "0x" + "11".repeat(32),
    mode: "prove",
    vkey: "0x" + "00".repeat(32),
    block_hash: "0x" + "ab".repeat(32),
    block_number: 12345,
    block_timestamp: Math.floor(Date.now() / 1000) - 60,
    contract: "0x9D1bd7119E9FefF6Baa3968272811323B354B16f",
    intent_id: id,
    sender: "0x" + "33".repeat(20),
    amount: "0x" + SMALL.toString(16),
    token_address: ZERO,
    destination_wallet: "0x" + "44".repeat(32),
    destination_chain_id: 1399811149,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    slippage_bps: 50,
    ...overrides,
  };
}

function writeFakeProof(id: string, json?: ProofOutputJson): void {
  const dir = process.env.ZK_DIR_PATH as string;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `proof_${hexOf(id)}.bin`), Buffer.from("fake-proof-bytes"));
  if (json) fs.writeFileSync(path.join(dir, `proof_${hexOf(id)}.json`), JSON.stringify(json));
}

// ─── In-memory chain: intents, balances, approvals ──────────────────────────

class FakeChain {
  intents = new Map<string, { status: number; solver: `0x${string}`; collateral: bigint }>();
  balances = new Map<string, bigint>();
  approvals = new Map<string, boolean>();

  open(id: string): void {
    this.intents.set(hexOf(id), { status: INTENT_STATUS_PENDING, solver: ZERO, collateral: 0n });
  }
  fund(solver: string, wei: bigint, approved = true): void {
    this.balances.set(solver.toLowerCase(), wei);
    this.approvals.set(solver.toLowerCase(), approved);
  }
  balance(solver: string): bigint {
    return this.balances.get(solver.toLowerCase()) ?? 0n;
  }
  read(id: string): OnChainIntent {
    const i = this.intents.get(hexOf(id)) ?? { status: INTENT_STATUS_PENDING, solver: ZERO, collateral: 0n };
    return { owner: ("0x" + "99".repeat(20)) as `0x${string}`, amount: SMALL, tokenAddress: ZERO, status: i.status, solver: i.solver, collateralPosted: i.collateral };
  }
}

interface SettleOpts {
  revertPost?: boolean;
  throwAfterSign?: boolean;
  solanaFails?: boolean;
  nowSec?: () => number;
  onPostSigned?: (id: `0x${string}`) => void;
}

/// Settlement deps for one solver, acting on `chain`. Every call is logged
/// WITHOUT the intent id, so two runs on different ids compare directly.
function settlementDepsFor(chain: FakeChain, solver: `0x${string}`, log: string[], opts: SettleOpts = {}): ArbitrumSettlementDeps {
  return {
    solverAddress: solver,
    orchestratorAddress: ORCHESTRATOR,
    async getSolverBalanceWei() {
      log.push(`getSolverBalanceWei(${solver})`);
      return chain.balance(solver);
    },
    async readIntent(id) {
      const r = chain.read(id);
      log.push(`readIntent -> status=${r.status} solver=${r.solver}`);
      return r;
    },
    async postCollateral(id, value, onSigned) {
      log.push(`postCollateral(solver=${solver}, value=${value})`);
      onSigned(("0x" + "aa".repeat(32)) as `0x${string}`);
      opts.onPostSigned?.(id);
      if (opts.throwAfterSign) throw new Error("simulated crash after signing postCollateral");
      const i = chain.intents.get(hexOf(id));
      if (opts.revertPost || !i || i.solver !== ZERO) return { ok: false, txHash: ("0x" + "aa".repeat(32)) as `0x${string}`, error: "reverted" };
      i.solver = solver;
      i.collateral = value;
      chain.balances.set(solver.toLowerCase(), chain.balance(solver) - value);
      return { ok: true, txHash: ("0x" + "aa".repeat(32)) as `0x${string}` };
    },
    async confirmSettlement(id, zk, onSigned) {
      log.push(`confirmSettlement`);
      onSigned(("0x" + "bb".repeat(32)) as `0x${string}`);
      const i = chain.intents.get(hexOf(id))!;
      i.status = INTENT_STATUS_SETTLED;
      chain.balances.set(i.solver.toLowerCase(), chain.balance(i.solver) + i.collateral);
      return { ok: true, txHash: ("0x" + "bb".repeat(32)) as `0x${string}` };
    },
    async slashSolver(_id, onSigned) {
      log.push(`slashSolver`);
      onSigned(("0x" + "cc".repeat(32)) as `0x${string}`);
      return { ok: true, txHash: ("0x" + "cc".repeat(32)) as `0x${string}` };
    },
    async runSolanaPayout() {
      log.push(`runSolanaPayout`);
      return opts.solanaFails ? { ok: false, error: "solana down" } : { ok: true, sig: "solana-sig" };
    },
    async checkSolanaSignatureLanded() {
      return false;
    },
    nowSec: opts.nowSec ?? (() => Math.floor(Date.now() / 1000)),
  };
}

function records(entries: Record<string, SolverRecord> = {}, complete = true): ReadSolverRecordResult {
  const out: Record<string, SolverRecord> = {};
  for (const [k, v] of Object.entries(entries)) out[k.toLowerCase()] = v;
  return { records: out, errors: [], complete };
}
function recordWith(settled: number, slashed: number): SolverRecord {
  const resolved = settled + slashed;
  return { settled, slashed, refunded: 0, expired: 0, excluded: 0, resolved, successRate: resolved === 0 ? null : settled / resolved };
}

interface RoutingWorld {
  deps: DispatchDeps;
  log: string[];
  book: ReservationBook;
  clock: { ms: number };
}

function routingWorld(chain: FakeChain, candidates: `0x${string}`[], opts: SettleOpts & { stats?: ReadSolverRecordResult; routingNowSec?: number; overrides?: Partial<SelectionDeps>; book?: ReservationBook } = {}): RoutingWorld {
  const log: string[] = [];
  const clock = { ms: 1_000_000 };
  const book = opts.book ?? new ReservationBook(() => clock.ms);
  const deps: DispatchDeps = {
    candidates: () => candidates,
    buildSettlementDeps: (solver) => settlementDepsFor(chain, solver, log, opts),
    nowSec: () => opts.routingNowSec ?? Math.floor(Date.now() / 1000),
    reservationHoldMs: 30_000,
    isApproved: async (s) => chain.approvals.get(s.toLowerCase()) ?? false,
    getBalanceWei: async (s) => chain.balance(s),
    readIntent: async (id) => chain.read(id),
    getSolverRecords: async () => opts.stats ?? records(),
    getOnboardingTier: (s) => TIERS[s.toLowerCase()] ?? 3,
    getPostingCollateralEntries,
    reservations: book,
    gate: { maxTransferWei: MAX_TRANSFER_WEI, gasBufferWei: ARBITRUM_GAS_BUFFER_WEI, deliveryMarginSec: DELIVERY_MARGIN_SEC },
    tierConfig: TIER_CONFIG,
    tierCapPct: CAP_PCT,
    ...opts.overrides,
  };
  return { deps, log, book, clock };
}

const MONEY = /^(postCollateral|confirmSettlement|slashSolver|runSolanaPayout)/;
function normalizedLedger(entry: ArbitrumLedgerEntry | undefined): string {
  if (!entry) return "none";
  const { updatedAt, selectedSolver, tierAtSelection, routingReason, collateralWei, ...rest } = entry;
  void updatedAt, selectedSolver, tierAtSelection, routingReason, collateralWei;
  return JSON.stringify(Object.keys(rest).sort().map((k) => [k, (rest as Record<string, unknown>)[k]]));
}
function normalizedDisplay(id: string): string {
  const s = readState(id);
  if (!s) return "none";
  const { reason, ...rest } = s.arbitrumSettlement;
  void reason;
  return JSON.stringify({ ...rest, alerted: !!s.alertReason });
}

/// Runs one scenario twice on identical fresh chains: "today" (the sequence
/// called directly with key 1's deps, exactly like listener.ts did before
/// Phase 3) and "routed" (dispatchArbitrumSettlement with only Solver A
/// configured). Returns both sides' observable outcomes.
async function todayVsRouted(
  jsonFor: (id: `0x${string}`) => ProofOutputJson,
  setup: { balance: bigint; opts?: SettleOpts; makeNowSec?: () => () => number }
): Promise<{ today: Outcome; routed: Outcome }> {
  const run = async (routed: boolean): Promise<Outcome> => {
    const id = freshId();
    const json = jsonFor(id);
    writeFakeProof(id);
    const chain = new FakeChain();
    chain.open(id);
    chain.fund(SOLVER_A, setup.balance);
    const opts = { ...setup.opts, nowSec: setup.makeNowSec?.() };
    let log: string[];
    if (routed) {
      const w = routingWorld(chain, [SOLVER_A], opts);
      log = w.log;
      await dispatchArbitrumSettlement(w.deps, id, json);
    } else {
      log = [];
      await runArbitrumSettlementSequence(settlementDepsFor(chain, SOLVER_A, log, opts), id, json);
    }
    const entry = getArbitrumLedgerEntry(id);
    return {
      id,
      log,
      money: log.filter((l) => MONEY.test(l)),
      ledger: normalizedLedger(entry),
      entry,
      display: normalizedDisplay(id),
      chain: JSON.stringify({ ...chain.read(id), amount: undefined, balanceA: chain.balance(SOLVER_A).toString() }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      alert: readState(id)?.alertReason ?? null,
    };
  };
  return { today: await run(false), routed: await run(true) };
}

interface Outcome {
  id: string;
  log: string[];
  money: string[];
  ledger: string;
  entry: ArbitrumLedgerEntry | undefined;
  display: string;
  chain: string;
  alert: string | null;
}

async function main(): Promise<void> {
  // ══════════════════ single solver: identical to today ══════════════════
  // "Today" = runArbitrumSettlementSequence with key 1's deps, no selection.
  // Identical means: the same settlement-deps calls in the same order with
  // the same arguments (which solver, what collateral), the same ledger entry
  // (ignoring only updatedAt and the four new routing fields), the same
  // display mirror, the same final chain state. When the sequence is never
  // entered (refusals), the routed side skips getSolverBalanceWei (routing
  // read the balance itself), so for those only the money calls are compared.

  console.log("[gate-test] 1a) single solver (only A), identical to today: happy path — same calls, same collateral, same ledger, same chain end state");
  {
    const { today, routed } = await todayVsRouted((id) => baseJson(id), { balance: PLENTY });
    check("full settlement-deps call log identical", JSON.stringify(today.log) === JSON.stringify(routed.log));
    check("postCollateral by Solver A with 1.5x collateral in both", today.money[0] === `postCollateral(solver=${SOLVER_A}, value=${(SMALL * 150n) / 100n})`);
    check("ledger entry identical apart from the routing fields", today.ledger === routed.ledger);
    check("both reached confirmed", today.entry?.stage === "confirmed" && routed.entry?.stage === "confirmed");
    check("display mirror identical", today.display === routed.display);
    check("final chain state identical", today.chain === routed.chain);
    check("routed entry records the decision (selected A, T2)", routed.entry?.selectedSolver === SOLVER_A && routed.entry?.tierAtSelection === 2);
  }

  console.log("[gate-test] 1b) single solver, identical to today: postCollateral reverts -> collateral_failed");
  {
    const { today, routed } = await todayVsRouted((id) => baseJson(id), { balance: PLENTY, opts: { revertPost: true } });
    check("full call log identical", JSON.stringify(today.log) === JSON.stringify(routed.log));
    check("ledger identical apart from routing fields (collateral_failed, tx hash kept)", today.ledger === routed.ledger && routed.entry?.stage === "collateral_failed");
    check("display identical", today.display === routed.display);
    check("no Solana payout on either side", !today.money.includes("runSolanaPayout") && !routed.money.includes("runSolanaPayout"));
  }

  console.log("[gate-test] 1c) single solver, identical to today: Solana payout never succeeds before expiry-margin -> awaiting_expiry_slash");
  {
    const fakeNow = Math.floor(Date.now() / 1000);
    const makeNowSec = () => {
      let calls = 0;
      return () => (++calls <= 2 ? fakeNow : fakeNow + 200);
    };
    const { today, routed } = await todayVsRouted((id) => baseJson(id, { expiry: fakeNow + 700 }), { balance: PLENTY, opts: { solanaFails: true }, makeNowSec });
    check("full call log identical", JSON.stringify(today.log) === JSON.stringify(routed.log));
    check("ledger identical apart from routing fields (awaiting_expiry_slash)", today.ledger === routed.ledger && routed.entry?.stage === "awaiting_expiry_slash");
    check("display identical", today.display === routed.display);
  }

  const refusals: Array<[string, (id: `0x${string}`) => ProofOutputJson, bigint]> = [
    ["too close to expiry", (id) => baseJson(id, { expiry: Math.floor(Date.now() / 1000) + 100 }), PLENTY],
    ["solver balance too low for 1.5x collateral + gas buffer", (id) => baseJson(id), SMALL],
    ["non-native token", (id) => baseJson(id, { token_address: "0x" + "ab".repeat(20) }), PLENTY],
    ["amount above MAX_TRANSFER_WEI", (id) => baseJson(id, { amount: "0x" + (MAX_TRANSFER_WEI * 2n).toString(16) }), PLENTY],
  ];
  for (const [label, jsonFor, balance] of refusals) {
    console.log(`[gate-test] 1d) single solver, same outcome as today when today's gate refuses: ${label} -> no collateral, collateral_failed, alert`);
    const { today, routed } = await todayVsRouted(jsonFor, { balance });
    check("no money calls on either side", today.money.length === 0 && routed.money.length === 0);
    check("ledger identical apart from routing fields (collateral_failed + expiry)", today.ledger === routed.ledger && routed.entry?.stage === "collateral_failed");
    check("display identical (collateral_failed, alerted)", today.display === routed.display);
    check("routed side records why (selectedSolver null + reason)", routed.entry?.selectedSolver === null && !!routed.entry?.routingReason);
    check("both alerts point the user at cancelIntent", !!today.alert?.includes("cancelIntent") && !!routed.alert?.includes("cancelIntent"));
  }

  console.log("[gate-test] 1e) INTENDED divergence from today (tier caps, the point of Phase 3): Solver A at T2 is capped at 30% of MAX_TRANSFER_WEI — a 0.005 ETH intent posts today, is refused when routed");
  {
    const { today, routed } = await todayVsRouted((id) => baseJson(id, { amount: "0x" + LARGE.toString(16) }), { balance: PLENTY });
    check("today: collateral posted", today.money.some((l) => l.startsWith("postCollateral")));
    check("routed: no collateral posted", routed.money.length === 0);
    check("routed: reason names the tier cap", !!routed.entry?.routingReason?.includes("tier_cap_exceeded(T2"));
  }

  // ══════════════════ two solvers: best fit ══════════════════

  console.log("[gate-test] 2) two solvers: small intent -> A (T2, smallest cap that fits); large intent -> B (only T1 fits)");
  {
    const chain = new FakeChain();
    chain.fund(SOLVER_A, PLENTY);
    chain.fund(SOLVER_B, PLENTY);
    const small = freshId();
    const large = freshId();
    chain.open(small);
    chain.open(large);
    const w = routingWorld(chain, [SOLVER_A, SOLVER_B]);
    const s1 = await selectSolver([SOLVER_A, SOLVER_B], { id: small, json: baseJson(small) }, Math.floor(Date.now() / 1000), w.deps);
    const s2 = await selectSolver([SOLVER_A, SOLVER_B], { id: large, json: baseJson(large, { amount: "0x" + LARGE.toString(16) }) }, Math.floor(Date.now() / 1000), w.deps);
    check("small -> A", s1.solver === SOLVER_A);
    check("small reason: smallest eligible tier cap", s1.reason === `selected ${SOLVER_A} (T2): smallest eligible tier cap`);
    check("large -> B", s2.solver === SOLVER_B);
    check("large: A excluded by its tier cap", !!s2.candidates.find((c) => c.solver === SOLVER_A)?.reasons.some((r) => r.startsWith("tier_cap_exceeded(T2")));
    check("candidate order does not change the outcome", (await selectSolver([SOLVER_B, SOLVER_A], { id: freshId(), json: baseJson(freshId()) }, Math.floor(Date.now() / 1000), routingWorld(chain, [SOLVER_B, SOLVER_A]).deps)).solver === SOLVER_A);
  }

  // ══════════════════ hard gates, each alone ══════════════════

  async function selectOnlyA(mutate: (chain: FakeChain, id: `0x${string}`) => void, jsonOverrides: Partial<ProofOutputJson> = {}, worldOpts: Parameters<typeof routingWorld>[2] = {}) {
    const chain = new FakeChain();
    chain.fund(SOLVER_A, PLENTY);
    const id = freshId();
    chain.open(id);
    mutate(chain, id);
    const w = routingWorld(chain, [SOLVER_A], worldOpts);
    const result = await selectSolver([SOLVER_A], { id, json: baseJson(id, jsonOverrides) }, Math.floor(Date.now() / 1000), w.deps);
    return { result, reasons: result.candidates[0]?.reasons ?? [], w };
  }

  console.log("[gate-test] 3) hard gates: control (nothing wrong) -> A selected");
  {
    const { result } = await selectOnlyA(() => {});
    check("A selected", result.solver === SOLVER_A);
  }

  console.log("[gate-test] 3a) hard gate: not approved on-chain right now -> excluded");
  {
    const { result, reasons } = await selectOnlyA((c) => c.approvals.set(SOLVER_A.toLowerCase(), false));
    check("null", result.solver === null);
    check("reason exactly [not_approved]", JSON.stringify(reasons) === JSON.stringify(["not_approved"]));
  }

  console.log("[gate-test] 3b) hard gate: insufficient AVAILABLE capital — balance covers it, but an existing reservation doesn't leave enough");
  {
    const chain = new FakeChain();
    chain.fund(SOLVER_A, RESERVE_SMALL + 1n); // enough for exactly one small intent
    const w = routingWorld(chain, [SOLVER_A]);
    w.book.reserve(SOLVER_A, freshId(), 2n); // tiny existing reservation -> 1 wei short
    const id = freshId();
    chain.open(id);
    const result = await selectSolver([SOLVER_A], { id, json: baseJson(id) }, Math.floor(Date.now() / 1000), w.deps);
    check("null", result.solver === null);
    check("reason is insufficient_available_capital with the numbers", result.candidates[0]?.reasons.length === 1 && result.candidates[0].reasons[0] === `insufficient_available_capital(available=${RESERVE_SMALL - 1n},required=${RESERVE_SMALL})`);
  }

  console.log("[gate-test] 3c) hard gate: too close to expiry (same DELIVERY_MARGIN_SEC as evaluateArbitrumGate) -> excluded");
  {
    const { result, reasons } = await selectOnlyA(() => {}, { expiry: Math.floor(Date.now() / 1000) + DELIVERY_MARGIN_SEC - 1 });
    check("null", result.solver === null);
    check("reason exactly [too_close_to_expiry]", JSON.stringify(reasons) === JSON.stringify(["too_close_to_expiry"]));
  }

  console.log("[gate-test] 3d) hard gate: intent already has a solver on-chain -> excluded");
  {
    const { result, reasons } = await selectOnlyA((c, id) => (c.intents.get(hexOf(id))!.solver = SOLVER_B));
    check("null", result.solver === null);
    check("reason names status and the on-chain solver", reasons.length === 1 && reasons[0] === `intent_not_open_onchain(status=0,solver=${SOLVER_B})`);
  }

  console.log("[gate-test] 3e) fail safe (L5): any gate read that throws excludes rather than assumes");
  {
    const approval = await selectOnlyA(() => {}, {}, { overrides: { isApproved: async () => { throw new Error("rpc down"); } } });
    check("approval read throws -> approval_read_failed", approval.result.solver === null && approval.reasons.includes("approval_read_failed"));
    const balance = await selectOnlyA(() => {}, {}, { overrides: { getBalanceWei: async () => { throw new Error("rpc down"); } } });
    check("balance read throws -> balance_read_failed", balance.result.solver === null && balance.reasons.includes("balance_read_failed"));
    const intent = await selectOnlyA(() => {}, {}, { overrides: { readIntent: async () => { throw new Error("rpc down"); } } });
    check("intent read throws -> intent_read_failed", intent.result.solver === null && intent.reasons.includes("intent_read_failed"));
    const stats = await selectOnlyA(() => {}, {}, { overrides: { getSolverRecords: async () => { throw new Error("stats down"); } } });
    check("track record throws -> track_record_unavailable", stats.result.solver === null && stats.reasons.includes("track_record_unavailable"));
  }

  // ══════════════════ tier filter ══════════════════

  console.log("[gate-test] 4) tier filter: a candidate whose CURRENT tier cap is below the amount is excluded");
  {
    const t3 = await selectOnlyA(() => {}, {}, { overrides: { getOnboardingTier: () => 3 } });
    check("onboarding T3 (cap 0.0005 ETH) vs 0.001 ETH -> tier_cap_exceeded(T3", t3.result.solver === null && t3.reasons.some((r) => r.startsWith("tier_cap_exceeded(T3")));
    const demoted = await selectOnlyA(() => {}, {}, { stats: records({ [SOLVER_A]: recordWith(2, 1) }) });
    check("A demoted T2 -> T3 by its record (2/3 < 0.80 at 3 resolved) -> excluded", demoted.result.solver === null && demoted.reasons.some((r) => r.startsWith("tier_cap_exceeded(T3")));
    const promoted = await selectOnlyA(() => {}, { amount: "0x" + LARGE.toString(16) }, { stats: records({ [SOLVER_A]: recordWith(10, 0) }) });
    check("A promoted T2 -> T1 by a clean 10-resolved record -> 0.005 ETH now fits", promoted.result.solver === SOLVER_A && promoted.result.tier === 1);
    const incomplete = await selectOnlyA(() => {}, { amount: "0x" + LARGE.toString(16) }, { stats: records({ [SOLVER_A]: recordWith(10, 0) }, false) });
    check("same record but complete=false -> no promotion -> excluded at T2", incomplete.result.solver === null && incomplete.reasons.some((r) => r.startsWith("tier_cap_exceeded(T2")));
  }

  // ══════════════════ no eligible candidate ══════════════════

  console.log("[gate-test] 5) no eligible candidate -> null, reason lists EVERY candidate's exclusion; dispatch posts nothing and records why");
  {
    const chain = new FakeChain();
    chain.fund(SOLVER_A, PLENTY, false); // unapproved
    chain.fund(SOLVER_B, SMALL); // under-capitalized
    const id = freshId();
    chain.open(id);
    writeFakeProof(id);
    const w = routingWorld(chain, [SOLVER_A, SOLVER_B]);
    const selection = await dispatchArbitrumSettlement(w.deps, id, baseJson(id));
    check("solver null", selection?.solver === null);
    check("reason names A and not_approved", !!selection?.reason.includes(`${SOLVER_A}: not_approved`));
    check("reason names B and insufficient_available_capital", !!selection?.reason.includes(`${SOLVER_B}: insufficient_available_capital`));
    check("no settlement-deps call at all (no collateral)", w.log.length === 0);
    const entry = getArbitrumLedgerEntry(id);
    check("ledger collateral_failed with selectedSolver null + the full reason", entry?.stage === "collateral_failed" && entry.selectedSolver === null && entry.routingReason === selection?.reason);
    check("alert says routing REFUSED and points at cancelIntent", !!readState(id)?.alertReason?.includes("routing REFUSED") && !!readState(id)?.alertReason?.includes("cancelIntent"));
    check("no reservation left behind", w.book.reservedWei(SOLVER_A) === 0n && w.book.reservedWei(SOLVER_B) === 0n);
  }

  // ══════════════════ tie-breaks ══════════════════

  console.log("[gate-test] 6) tie-breaks: success rate, then available capital, then lowest address — deterministic regardless of candidate order");
  {
    const now = Math.floor(Date.now() / 1000);
    const setup = (balA: bigint, balC: bigint) => {
      const chain = new FakeChain();
      chain.fund(SOLVER_A, balA);
      chain.fund(SOLVER_C, balC);
      return chain;
    };
    const pick = async (chain: FakeChain, order: `0x${string}`[], stats?: ReadSolverRecordResult) => {
      const id = freshId();
      chain.open(id);
      return selectSolver(order, { id, json: baseJson(id) }, now, routingWorld(chain, order, { stats }).deps);
    };

    const rate = await pick(setup(PLENTY, PLENTY), [SOLVER_C, SOLVER_A], records({ [SOLVER_A]: recordWith(9, 0), [SOLVER_C]: recordWith(8, 1) }));
    check("same tier: higher success rate wins (A 1.0 over C 0.89)", rate.solver === SOLVER_A && rate.reason.endsWith("higher success rate"));

    const capital = await pick(setup(PLENTY, PLENTY * 2n), [SOLVER_A, SOLVER_C]);
    check("same tier, same rate: more available capital wins (C)", capital.solver === SOLVER_C && capital.reason.endsWith("more available capital"));

    const tieAC = await pick(setup(PLENTY, PLENTY), [SOLVER_A, SOLVER_C]);
    const tieCA = await pick(setup(PLENTY, PLENTY), [SOLVER_C, SOLVER_A]);
    check("everything equal: lowest address wins (C = 0x00..c3 < A = 0xe3..)", tieAC.solver === SOLVER_C && tieAC.reason.endsWith("lowest-address tie-break"));
    check("...and the same winner with the candidate order reversed", tieCA.solver === SOLVER_C);
  }

  // ══════════════════ reservations ══════════════════

  console.log("[gate-test] 7a) reservations: two selections racing (Promise.all, slow reads) over ONE solver with room for only one -> exactly one gets it, the other gets null for capital");
  {
    const chain = new FakeChain();
    chain.fund(SOLVER_A, RESERVE_SMALL + RESERVE_SMALL / 2n);
    const w = routingWorld(chain, [SOLVER_A], {
      overrides: {
        isApproved: async () => {
          await new Promise((r) => setTimeout(r, 20)); // widen the window a non-atomic implementation would lose in
          return true;
        },
      },
    });
    const [id1, id2] = [freshId(), freshId()];
    chain.open(id1);
    chain.open(id2);
    const now = Math.floor(Date.now() / 1000);
    const [r1, r2] = await Promise.all([selectSolver([SOLVER_A], { id: id1, json: baseJson(id1) }, now, w.deps), selectSolver([SOLVER_A], { id: id2, json: baseJson(id2) }, now, w.deps)]);
    check("exactly one got Solver A", [r1.solver, r2.solver].filter((s) => s === SOLVER_A).length === 1);
    const loser = r1.solver ? r2 : r1;
    check("the other got null because of available capital", loser.solver === null && loser.candidates[0]!.reasons[0]!.startsWith("insufficient_available_capital"));
    check("exactly one reservation is held", w.book.reservedWei(SOLVER_A) === RESERVE_SMALL);
  }

  console.log("[gate-test] 7b) reservations: the same race with A and B each having room for one -> one goes to A, the other is routed to B");
  {
    const chain = new FakeChain();
    chain.fund(SOLVER_A, RESERVE_SMALL + 1n);
    chain.fund(SOLVER_B, RESERVE_SMALL + 1n);
    const w = routingWorld(chain, [SOLVER_A, SOLVER_B], { overrides: { isApproved: async () => (await new Promise((r) => setTimeout(r, 20)), true) } });
    const [id1, id2] = [freshId(), freshId()];
    chain.open(id1);
    chain.open(id2);
    const now = Math.floor(Date.now() / 1000);
    const results = await Promise.all([selectSolver([SOLVER_A, SOLVER_B], { id: id1, json: baseJson(id1) }, now, w.deps), selectSolver([SOLVER_A, SOLVER_B], { id: id2, json: baseJson(id2) }, now, w.deps)]);
    const winners = results.map((r) => r.solver).sort();
    check("one to A, one to B — never both to A", JSON.stringify(winners) === JSON.stringify([SOLVER_A, SOLVER_B].sort()));
  }

  console.log("[gate-test] 7c) reservations: success path — reserved before postCollateral is called, routing fields written BEFORE broadcast, held for RESERVATION_HOLD_SEC after confirmation, then lapses");
  {
    const chain = new FakeChain();
    chain.fund(SOLVER_A, PLENTY);
    const id = freshId();
    chain.open(id);
    writeFakeProof(id);
    let reservedAtPost = -1n;
    let entryAtSigning: ArbitrumLedgerEntry | undefined;
    const w = routingWorld(chain, [SOLVER_A], {
      onPostSigned: (postedId) => {
        entryAtSigning = { ...getArbitrumLedgerEntry(postedId)! };
        reservedAtPost = w.book.reservedWei(SOLVER_A);
      },
    });
    await dispatchArbitrumSettlement(w.deps, id, baseJson(id));
    check("reservation already in place when postCollateral ran", reservedAtPost === RESERVE_SMALL);
    check("at signing (before broadcast) the ledger entry is posting_collateral with solver + all routing fields", entryAtSigning?.stage === "posting_collateral" && entryAtSigning.solver === SOLVER_A && entryAtSigning.selectedSolver === SOLVER_A && entryAtSigning.tierAtSelection === 2 && entryAtSigning.routingReason === `selected ${SOLVER_A} (T2): only eligible solver` && entryAtSigning.collateralWei === ((SMALL * 150n) / 100n).toString());
    check("sequence completed (confirmed)", getArbitrumLedgerEntry(id)?.stage === "confirmed");
    check("still reserved right after (hold window)", w.book.reservedWei(SOLVER_A) === RESERVE_SMALL);
    w.clock.ms += 29_999;
    check("still reserved at 29.999s", w.book.reservedWei(SOLVER_A) === RESERVE_SMALL);
    w.clock.ms += 1;
    check("released at exactly RESERVATION_HOLD_SEC (30s)", w.book.reservedWei(SOLVER_A) === 0n);
  }

  console.log("[gate-test] 7d) reservations: postCollateral reverts (e.g. approval flipped between selection and broadcast) -> existing collateral_failed path, reservation released immediately");
  {
    const chain = new FakeChain();
    chain.fund(SOLVER_A, PLENTY);
    const id = freshId();
    chain.open(id);
    const w = routingWorld(chain, [SOLVER_A], { revertPost: true });
    await dispatchArbitrumSettlement(w.deps, id, baseJson(id));
    check("ledger collateral_failed (today's path), routing fields kept", getArbitrumLedgerEntry(id)?.stage === "collateral_failed" && getArbitrumLedgerEntry(id)?.selectedSolver === SOLVER_A);
    check("reservation released with no hold", w.book.reservedWei(SOLVER_A) === 0n);
  }

  console.log("[gate-test] 7e) reservations: the sequence's own final gate refuses after selection (clock moved past the margin) -> no collateral, reservation released");
  {
    const chain = new FakeChain();
    chain.fund(SOLVER_A, PLENTY);
    const id = freshId();
    chain.open(id);
    const json = baseJson(id);
    const w = routingWorld(chain, [SOLVER_A], { nowSec: () => json.expiry }); // routing sees "now", the sequence sees expiry
    await dispatchArbitrumSettlement(w.deps, id, json);
    check("no postCollateral", !w.log.some((l) => l.startsWith("postCollateral")));
    check("collateral_failed via today's settle-gate text, still carrying the routing decision", getArbitrumLedgerEntry(id)?.stage === "collateral_failed" && !!readState(id)?.alertReason?.includes("settle gate REFUSED") && getArbitrumLedgerEntry(id)?.selectedSolver === SOLVER_A);
    check("reservation released", w.book.reservedWei(SOLVER_A) === 0n);
  }

  console.log("[gate-test] 7f) reservations: a crash right after signing postCollateral -> propagates, releases the in-memory reservation; the ledger still carries the in-flight collateral, which a RESTARTED process (empty book) counts against A");
  {
    const chain = new FakeChain();
    chain.fund(SOLVER_A, RESERVE_SMALL * 2n);
    const id = freshId();
    chain.open(id);
    const w = routingWorld(chain, [SOLVER_A], { throwAfterSign: true });
    let threw = false;
    try {
      await dispatchArbitrumSettlement(w.deps, id, baseJson(id));
    } catch {
      threw = true;
    }
    check("the crash propagates (not swallowed)", threw);
    check("in-memory reservation released", w.book.reservedWei(SOLVER_A) === 0n);
    check("ledger: posting_collateral with collateralWei, recorded before the crash", getArbitrumLedgerEntry(id)?.stage === "posting_collateral" && getArbitrumLedgerEntry(id)?.collateralWei === ((SMALL * 150n) / 100n).toString());

    const restarted = routingWorld(chain, [SOLVER_A]); // fresh, empty ReservationBook
    const id2 = freshId();
    chain.open(id2);
    const s = await selectSolver([SOLVER_A], { id: id2, json: baseJson(id2) }, Math.floor(Date.now() / 1000), restarted.deps);
    check("restarted process: available = balance - in-flight ledger collateral - gas buffer", s.candidates[0]?.availableWei === RESERVE_SMALL * 2n - RESERVE_SMALL);
    check("...which still leaves room for exactly one more small intent", s.solver === SOLVER_A);
    const id3 = freshId();
    chain.open(id3);
    const s3 = await selectSolver([SOLVER_A], { id: id3, json: baseJson(id3) }, Math.floor(Date.now() / 1000), restarted.deps);
    check("...and not two", s3.solver === null);
    setArbitrumStage(id, "collateral_failed"); // tidy: stop this entry affecting later tests
  }

  console.log("[gate-test] 7g) reservations: release is exactly-once and never touches another intent's reservation");
  {
    const book = new ReservationBook();
    const [i1, i2] = [freshId(), freshId()];
    book.reserve(SOLVER_A, i1, 5n);
    book.reserve(SOLVER_A, i2, 7n);
    check("first release removes it", book.release(SOLVER_A, i1) === true);
    check("second release is a no-op", book.release(SOLVER_A, i1) === false);
    check("the other intent's reservation is intact", book.reservedWei(SOLVER_A) === 7n);
  }

  // ══════════════════ dispatch guards ══════════════════

  console.log("[gate-test] 8) dispatch: an intent already mid/past the sequence is NOT re-routed — even when routing would find no solver (which would otherwise overwrite the live entry with collateral_failed)");
  {
    const chain = new FakeChain();
    chain.fund(SOLVER_A, PLENTY, false); // unapproved: routing, if it ran, would return null and refuse
    const id = freshId();
    setArbitrumStage(id, "confirmed", { confirmTxHash: "0x" + "ee".repeat(32), solver: SOLVER_A });
    const before = JSON.stringify(getArbitrumLedgerEntry(id));
    let routingReads = 0;
    const w = routingWorld(chain, [SOLVER_A], { overrides: { isApproved: async () => (routingReads++, false), getBalanceWei: async () => (routingReads++, PLENTY) } });
    const selection = await dispatchArbitrumSettlement(w.deps, id, baseJson(id));
    check("no selection ran", selection === null && routingReads === 0);
    check("ledger entry byte-identical", JSON.stringify(getArbitrumLedgerEntry(id)) === before);
    check("today's 'already in progress or done' alert", !!readState(id)?.alertReason?.includes("already in progress or done"));
    check("no money calls", w.log.filter((l) => MONEY.test(l)).length === 0);
  }

  console.log("[gate-test] 9) restart mid-selection (before any collateral tx): nothing recorded, nothing to reconcile, a fresh dispatch later works normally");
  {
    const chain = new FakeChain();
    chain.fund(SOLVER_A, PLENTY);
    const id = freshId();
    chain.open(id);
    writeFakeProof(id);
    // The "crashed" process: selection hangs forever mid-read and is abandoned.
    const crashed = routingWorld(chain, [SOLVER_A], { overrides: { isApproved: () => new Promise<boolean>(() => {}) } });
    void dispatchArbitrumSettlement(crashed.deps, id, baseJson(id));
    await new Promise((r) => setTimeout(r, 20));
    check("nothing on the ledger for this intent", getArbitrumLedgerEntry(id) === undefined);
    check("no posting_collateral entry anywhere for it", !getPostingCollateralEntries().some((e) => e.intentId === hexOf(id)));
    // The restarted process: a new book (the old one is gone with the process).
    const restarted = routingWorld(chain, [SOLVER_A]);
    await dispatchArbitrumSettlement(restarted.deps, id, baseJson(id));
    check("fresh dispatch selected A and completed", getArbitrumLedgerEntry(id)?.stage === "confirmed" && getArbitrumLedgerEntry(id)?.selectedSolver === SOLVER_A);
  }

  console.log("[gate-test] 10) onboarding tiers file: the committed file gives A T2 and B T1; unknown solver -> T3; missing file -> T3");
  {
    const tierOf = loadOnboardingTiers();
    check("A -> 2", tierOf(SOLVER_A) === 2);
    check("B -> 1", tierOf(SOLVER_B) === 1);
    check("case-insensitive", tierOf(SOLVER_A.toLowerCase()) === 2);
    const warn = console.warn;
    console.warn = () => {};
    try {
      check("unknown -> 3", tierOf(SOLVER_C) === 3);
      check("missing file -> 3", loadOnboardingTiers(path.join(process.env.ZK_DIR_PATH as string, "nope.json"))(SOLVER_A) === 3);
    } finally {
      console.warn = warn;
    }
  }

  // ══════════════════ L6: slash guard with two solvers ══════════════════

  console.log("[gate-test] 11) L6 with two solvers at different stages: A's awaiting_expiry_slash whose Solana sig DID land resumes confirmSettlement (no slash); B's collateral_posted entry and B's not-yet-expired awaiting_expiry_slash entry are untouched");
  {
    const now = Math.floor(Date.now() / 1000);
    const x = freshId(); // Solver A, expired, sig landed
    const y = freshId(); // Solver B, collateral_posted
    const z = freshId(); // Solver B, awaiting_expiry_slash, NOT yet expired
    const xJson = baseJson(x, { expiry: now - 10 });
    writeFakeProof(x, xJson);
    markSettling(x, "sig-x-landed");
    setArbitrumStage(x, "awaiting_expiry_slash", { expiry: now - 10, solver: SOLVER_A, selectedSolver: SOLVER_A, tierAtSelection: 2, routingReason: "r" });
    setArbitrumStage(y, "collateral_posted", { expiry: now + 3600, solver: SOLVER_B, collateralTxHash: "0x" + "12".repeat(32) });
    setArbitrumStage(z, "awaiting_expiry_slash", { expiry: now + 3600, solver: SOLVER_B });
    markSettling(z, "sig-z-never-landed");
    const yBefore = JSON.stringify(getArbitrumLedgerEntry(y));
    const zBefore = JSON.stringify(getArbitrumLedgerEntry(z));

    const chain = new FakeChain();
    chain.open(x);
    chain.intents.get(hexOf(x))!.solver = SOLVER_A;
    const slashed: string[] = [];
    const confirmed: string[] = [];
    const checkedSigs: string[] = [];
    const base = settlementDepsFor(chain, SOLVER_A, []);
    const deps: ArbitrumSettlementDeps = {
      ...base,
      nowSec: () => now,
      async slashSolver(id, onSigned) {
        slashed.push(id);
        return base.slashSolver(id, onSigned);
      },
      async confirmSettlement(id, zk, onSigned) {
        confirmed.push(id);
        return base.confirmSettlement(id, zk, onSigned);
      },
      async checkSolanaSignatureLanded(sig) {
        checkedSigs.push(sig);
        return sig === "sig-x-landed";
      },
    };
    await pollAwaitingSlash(deps);
    check("the landed signature was checked fresh", checkedSigs.includes("sig-x-landed"));
    check("no slash at all", slashed.length === 0);
    check("confirmSettlement resumed for A's intent only", confirmed.length === 1 && confirmed[0]!.toLowerCase() === x.toLowerCase());
    check("A's intent reached confirmed", getArbitrumLedgerEntry(x)?.stage === "confirmed");
    check("B's collateral_posted entry byte-identical", JSON.stringify(getArbitrumLedgerEntry(y)) === yBefore);
    check("B's not-yet-expired awaiting_expiry_slash entry byte-identical", JSON.stringify(getArbitrumLedgerEntry(z)) === zBefore);
    check("B's unexpired entry's signature was not even checked", !checkedSigs.includes("sig-z-never-landed"));
  }

  if (failures > 0) {
    console.error(`\n[gate-test] ${failures} check(s) FAILED`);
    process.exit(1);
  } else {
    console.log(`\n[gate-test] all checks passed`);
  }
}

main().catch((err) => {
  console.error("[gate-test] unexpected error:", err);
  process.exit(1);
});
