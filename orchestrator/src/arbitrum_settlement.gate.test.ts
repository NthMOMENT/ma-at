// Gate test (Phase 7B): the Arbitrum settlement state machine —
// evaluateArbitrumGate (pure), runArbitrumSettlementSequence, pollAwaitingSlash,
// and reconcileArbitrumLedger — exercised entirely with MOCKED chain calls
// (an ArbitrumSettlementDeps built from in-memory stubs, and a fake
// PublicClient for reconciliation). No real RPC, no real signing, no real
// SP1 binary. Covers every branch: the extra gate checks, a postCollateral
// revert, the on-chain solver/status check after posting collateral, Solana
// payout retry-then-succeed and retry-until-expiry-then-slash, a
// confirmSettlement revert, refusing to restart an in-progress sequence, a
// "crash" (thrown exception) right after a tx is signed but before its
// outcome is known, and the slash poller / boot reconciliation paths.
//
// Same "no test runner wired up yet" pattern as the other *.gate.test.ts
// files. Run with (all four required — this would otherwise touch real
// state, and the two private keys must be present for the module to load,
// even though no real signing ever happens in this test):
//
//   MAAT_STATE_DIR=/tmp/gate-test-arb-state \
//   SETTLED_LEDGER_PATH=/tmp/gate-test-arb-ledger.json \
//   ALERT_LOG_PATH=/tmp/gate-test-arb-alerts.log \
//   ARBITRUM_LEDGER_PATH=/tmp/gate-test-arb-arbledger.json \
//   ZK_DIR_PATH=/tmp/gate-test-arb-zkdir \
//   ARBITRUM_SOLVER_PRIVATE_KEY=0x1111111111111111111111111111111111111111111111111111111111111 \
//   ARBITRUM_ORCHESTRATOR_PRIVATE_KEY=0x2222222222222222222222222222222222222222222222222222222222222 \
//   SOLANA_PAYOUT_RETRY_INTERVAL_MS=1000 \
//   CONFIRM_RETRY_BACKOFF_MS=200,200,200,200 \
//   npx ts-node src/arbitrum_settlement.gate.test.ts
//
// SOLANA_PAYOUT_RETRY_INTERVAL_MS and CONFIRM_RETRY_BACKOFF_MS are optional
// (default to the real 30s / 1-5-15-30min schedule) but strongly recommended
// here — several tests exercise a real retry sleep, and at the real
// defaults that's tens of minutes for one test run.
import * as fs from "fs";
import * as path from "path";

for (const v of [
  "MAAT_STATE_DIR",
  "SETTLED_LEDGER_PATH",
  "ALERT_LOG_PATH",
  "ARBITRUM_LEDGER_PATH",
  "ZK_DIR_PATH",
  "ARBITRUM_SOLVER_PRIVATE_KEY",
  "ARBITRUM_ORCHESTRATOR_PRIVATE_KEY",
]) {
  if (!process.env[v]) {
    console.error(`[gate-test] refusing to run without ${v} set (see this file's header comment)`);
    process.exit(1);
  }
}

// Imported after the env checks above — every module here reads its config
// once, at load time.
import {
  evaluateArbitrumGate,
  computeZkProofHash,
  runArbitrumSettlementSequence,
  confirmSettlementWithRetry,
  pollAwaitingSlash,
  reconcileArbitrumLedger,
  INTENT_STATUS_PENDING,
  INTENT_STATUS_SLASHED,
  INTENT_STATUS_SETTLED,
  INTENT_STATUS_REFUNDED,
  type ArbitrumSettlementDeps,
  type OnChainIntent,
  type TxOutcome,
} from "./arbitrum_settlement";
import { getArbitrumLedgerEntry, setArbitrumStage } from "./arbitrum_ledger";
import { readState } from "./intent_state";
import { markSettled, type ProofOutputJson } from "./prover_pipeline";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    console.error(`  FAIL ${name}`);
    failures++;
  }
}

const SOLVER = "0x00000000000000000000000000000000000501" as `0x${string}`;
const OTHER_SOLVER = "0x00000000000000000000000000000000000502" as `0x${string}`;
const ORCHESTRATOR = "0x00000000000000000000000000000000000601" as `0x${string}`;
const FAKE_ZK_PROOF_HASH = ("0x" + "77".repeat(32)) as `0x${string}`;

function baseJson(intentIdHex: string, overrides: Partial<ProofOutputJson> = {}): ProofOutputJson {
  return {
    tx_hash: "0x" + "11".repeat(32),
    mode: "prove",
    vkey: "0x" + "00".repeat(32),
    block_hash: "0x" + "ab".repeat(32),
    block_number: 12345,
    block_timestamp: Math.floor(Date.now() / 1000) - 60,
    contract: "0x9D1bd7119E9FefF6Baa3968272811323B354B16f",
    intent_id: "0x" + intentIdHex,
    sender: "0x" + "33".repeat(20),
    amount: "0x" + (1000000000000000n).toString(16), // 0.001 ETH — under the default 0.01 ETH cap
    token_address: "0x" + "0".repeat(40),
    destination_wallet: "0x" + "44".repeat(32),
    destination_chain_id: 1399811149,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    slippage_bps: 50,
    ...overrides,
  };
}

function mockOnChainIntent(overrides: Partial<OnChainIntent> = {}): OnChainIntent {
  return { owner: "0x" + "99".repeat(20) as `0x${string}`, amount: 1000000000000000n, tokenAddress: "0x0000000000000000000000000000000000000000", status: INTENT_STATUS_PENDING, solver: SOLVER, collateralPosted: 1500000000000000n, ...overrides };
}

function baseDeps(overrides: Partial<ArbitrumSettlementDeps> = {}): ArbitrumSettlementDeps {
  return {
    solverAddress: SOLVER,
    orchestratorAddress: ORCHESTRATOR,
    async getSolverBalanceWei() {
      return 10_000_000_000_000_000_000n; // 10 ETH — plenty
    },
    async readIntent() {
      return mockOnChainIntent();
    },
    async postCollateral(_id, _value, onSigned) {
      onSigned(("0x" + "aa".repeat(32)) as `0x${string}`);
      return { ok: true, txHash: ("0x" + "aa".repeat(32)) as `0x${string}` };
    },
    async confirmSettlement(_id, _hash, onSigned) {
      onSigned(("0x" + "bb".repeat(32)) as `0x${string}`);
      return { ok: true, txHash: ("0x" + "bb".repeat(32)) as `0x${string}` };
    },
    async slashSolver(_id, onSigned) {
      onSigned(("0x" + "cc".repeat(32)) as `0x${string}`);
      return { ok: true, txHash: ("0x" + "cc".repeat(32)) as `0x${string}` };
    },
    async runSolanaPayout() {
      return { ok: true, sig: "solana-sig-1" };
    },
    nowSec: () => Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function writeFakeProofBin(intentIdHex: string): void {
  fs.mkdirSync(process.env.ZK_DIR_PATH as string, { recursive: true });
  fs.writeFileSync(path.join(process.env.ZK_DIR_PATH as string, `proof_${intentIdHex}.bin`), Buffer.from("fake-proof-bytes"));
}

async function main(): Promise<void> {
  // ══════════════════ evaluateArbitrumGate (pure) ══════════════════
  console.log("[gate-test] 1) evaluateArbitrumGate: all-valid -> passes");
  {
    const json = baseJson("01".repeat(32));
    const gate = evaluateArbitrumGate(json, { maxTransferWei: 10_000_000_000_000_000n, solverBalanceWei: 10_000_000_000_000_000_000n, gasBufferWei: 1_000_000_000_000_000n, nowSec: Math.floor(Date.now() / 1000), deliveryMarginSec: 600 });
    check("ok === true", gate.ok === true);
  }

  console.log("[gate-test] 2) evaluateArbitrumGate: non-native token fails");
  {
    const json = baseJson("02".repeat(32), { token_address: "0x" + "ab".repeat(20) });
    const gate = evaluateArbitrumGate(json, { maxTransferWei: 10_000_000_000_000_000n, solverBalanceWei: 10_000_000_000_000_000_000n, gasBufferWei: 0n, nowSec: Math.floor(Date.now() / 1000), deliveryMarginSec: 600 });
    check("failed on token_not_native", gate.failedChecks.includes("token_not_native"));
  }

  console.log("[gate-test] 3) evaluateArbitrumGate: amount over MAX_TRANSFER fails");
  {
    const json = baseJson("03".repeat(32), { amount: "0x" + (20_000_000_000_000_000n).toString(16) }); // 0.02 ETH
    const gate = evaluateArbitrumGate(json, { maxTransferWei: 10_000_000_000_000_000n, solverBalanceWei: 10_000_000_000_000_000_000n, gasBufferWei: 0n, nowSec: Math.floor(Date.now() / 1000), deliveryMarginSec: 600 });
    check("failed on amount_exceeds_max_transfer", gate.failedChecks.includes("amount_exceeds_max_transfer"));
  }

  console.log("[gate-test] 4) evaluateArbitrumGate: insufficient solver balance fails");
  {
    const json = baseJson("04".repeat(32)); // amount 0.001 ETH -> needs 0.0015 ETH collateral
    const gate = evaluateArbitrumGate(json, { maxTransferWei: 10_000_000_000_000_000n, solverBalanceWei: 1_000_000_000_000_000n /* 0.001 ETH, less than required collateral */, gasBufferWei: 1_000_000_000_000_000n, nowSec: Math.floor(Date.now() / 1000), deliveryMarginSec: 600 });
    check("failed on insufficient_solver_balance", gate.failedChecks.includes("insufficient_solver_balance"));
  }

  console.log("[gate-test] 5) evaluateArbitrumGate: too close to expiry fails");
  {
    const now = Math.floor(Date.now() / 1000);
    const json = baseJson("05".repeat(32), { expiry: now + 100 }); // margin 600 > 100 remaining
    const gate = evaluateArbitrumGate(json, { maxTransferWei: 10_000_000_000_000_000n, solverBalanceWei: 10_000_000_000_000_000_000n, gasBufferWei: 0n, nowSec: now, deliveryMarginSec: 600 });
    check("failed on too_close_to_expiry", gate.failedChecks.includes("too_close_to_expiry"));
  }

  // ══════════════════ runArbitrumSettlementSequence ══════════════════

  console.log("[gate-test] 6) sequence: gate failure -> no collateral posted, state explains why");
  {
    const intentIdHex = "06".repeat(32);
    const intentId = ("0x" + intentIdHex) as `0x${string}`;
    const json = baseJson(intentIdHex, { expiry: Math.floor(Date.now() / 1000) + 100 }); // too close to expiry
    let postCollateralCalled = false;
    const deps = baseDeps({ postCollateral: async () => { postCollateralCalled = true; return { ok: true }; } });
    await runArbitrumSettlementSequence(deps, intentId, json);
    check("postCollateral never called", !postCollateralCalled);
    check("ledger stage is collateral_failed", getArbitrumLedgerEntry(intentId)?.stage === "collateral_failed");
    check("state alertReason mentions reclaim via cancelIntent", !!readState(intentId)?.alertReason?.includes("cancelIntent"));
  }

  console.log("[gate-test] 7) sequence: postCollateral reverts -> collateral_failed, txHash still recorded, no Solana payout attempted");
  {
    const intentIdHex = "07".repeat(32);
    const intentId = ("0x" + intentIdHex) as `0x${string}`;
    const json = baseJson(intentIdHex);
    let solanaPayoutCalled = false;
    const deps = baseDeps({
      postCollateral: async (_id, _v, onSigned) => {
        onSigned(("0x" + "dd".repeat(32)) as `0x${string}`);
        return { ok: false, txHash: ("0x" + "dd".repeat(32)) as `0x${string}`, error: "reverted" };
      },
      runSolanaPayout: async () => { solanaPayoutCalled = true; return { ok: true }; },
    });
    await runArbitrumSettlementSequence(deps, intentId, json);
    check("solana payout never attempted", !solanaPayoutCalled);
    const entry = getArbitrumLedgerEntry(intentId);
    check("ledger stage is collateral_failed", entry?.stage === "collateral_failed");
    check("collateral txHash still recorded despite the revert", entry?.collateralTxHash === "0x" + "dd".repeat(32));
  }

  console.log("[gate-test] 8) sequence: on-chain solver mismatch after postCollateral -> stop, never pay on Solana");
  {
    const intentIdHex = "08".repeat(32);
    const intentId = ("0x" + intentIdHex) as `0x${string}`;
    const json = baseJson(intentIdHex);
    let solanaPayoutCalled = false;
    const deps = baseDeps({
      readIntent: async () => mockOnChainIntent({ solver: OTHER_SOLVER }),
      runSolanaPayout: async () => { solanaPayoutCalled = true; return { ok: true }; },
    });
    await runArbitrumSettlementSequence(deps, intentId, json);
    check("solana payout never attempted", !solanaPayoutCalled);
    check("ledger stays at collateral_posted (never reached confirming/confirmed)", getArbitrumLedgerEntry(intentId)?.stage === "collateral_posted");
    check("state alertReason recorded", !!readState(intentId)?.alertReason);
  }

  console.log("[gate-test] 9) sequence: happy path end to end -> confirmed");
  {
    const intentIdHex = "09".repeat(32);
    const intentId = ("0x" + intentIdHex) as `0x${string}`;
    const json = baseJson(intentIdHex);
    writeFakeProofBin(intentIdHex);
    const deps = baseDeps();
    await runArbitrumSettlementSequence(deps, intentId, json);
    const entry = getArbitrumLedgerEntry(intentId);
    check("ledger stage is confirmed", entry?.stage === "confirmed");
    check("collateral txHash recorded", entry?.collateralTxHash === "0x" + "aa".repeat(32));
    check("confirm txHash recorded", entry?.confirmTxHash === "0x" + "bb".repeat(32));
    check("display mirror shows confirmed", readState(intentId)?.arbitrumSettlement.stage === "confirmed");
  }

  console.log("[gate-test] 10) sequence: Solana payout fails once, then succeeds on retry -> still reaches confirmed");
  {
    const intentIdHex = "0a".repeat(32);
    const intentId = ("0x" + intentIdHex) as `0x${string}`;
    const json = baseJson(intentIdHex);
    writeFakeProofBin(intentIdHex);
    let attempts = 0;
    const deps = baseDeps({
      runSolanaPayout: async () => {
        attempts++;
        if (attempts === 1) return { ok: false, error: "transient RPC failure" };
        return { ok: true, sig: "solana-sig-retry" };
      },
    });
    const start = Date.now();
    await runArbitrumSettlementSequence(deps, intentId, json);
    check("retried exactly once before succeeding", attempts === 2);
    check("ledger stage is confirmed", getArbitrumLedgerEntry(intentId)?.stage === "confirmed");
    check("a real backoff elapsed (SOLANA_PAYOUT_RETRY_INTERVAL_MS)", Date.now() - start >= 500);
  }

  console.log("[gate-test] 11) sequence: Solana payout keeps failing while the clock advances past expiry-margin -> awaiting_expiry_slash");
  {
    const intentIdHex = "0b".repeat(32);
    const intentId = ("0x" + intentIdHex) as `0x${string}`;
    writeFakeProofBin(intentIdHex); // computeZkProofHash now runs before Step 3, same as Step 4
    const fakeNow = Math.floor(Date.now() / 1000);
    // deadline = expiry - margin = fakeNow + 700 - 600 = fakeNow + 100.
    const json = baseJson(intentIdHex, { expiry: fakeNow + 700 });
    // A stateful clock: comfortably before the deadline for the initial gate
    // check and the first retry-loop check, then jumps past it — simulating
    // real time actually elapsing across retries, which is the only way
    // this branch is reachable (the initial gate re-checks the identical
    // deadline, so "already past it" would be rejected before step 1 ever
    // ran — see test 6).
    let clockCalls = 0;
    const nowSec = () => {
      clockCalls++;
      return clockCalls <= 2 ? fakeNow : fakeNow + 200;
    };
    let attempts = 0;
    const deps = baseDeps({
      runSolanaPayout: async () => { attempts++; return { ok: false, error: "solana down" }; },
      nowSec,
    });
    await runArbitrumSettlementSequence(deps, intentId, json);
    check("retried at least once before giving up", attempts >= 2);
    check("ledger stage is awaiting_expiry_slash", getArbitrumLedgerEntry(intentId)?.stage === "awaiting_expiry_slash");
    check("expiry recorded on the ledger for the slash poller", getArbitrumLedgerEntry(intentId)?.expiry === json.expiry);
  }

  console.log("[gate-test] 12) sequence: confirmSettlement always reverts -> retries until the deadline, then stuck at confirming, flagged for review");
  {
    const intentIdHex = "0c".repeat(32);
    const intentId = ("0x" + intentIdHex) as `0x${string}`;
    const json = baseJson(intentIdHex);
    writeFakeProofBin(intentIdHex);
    // A stateful clock: comfortably before confirmSettlementWithRetry's
    // deadline (expiry + CONFIRM_RETRY_MAX_SEC_AFTER_EXPIRY) for the first
    // deadline check, then past it — same reasoning as test 11's clock
    // (nowSec is only consulted AFTER a failed attempt, so this forces
    // exactly two attempts before giving up).
    // clockCalls 1: the initial evaluateArbitrumGate check, at the top of
    // runArbitrumSettlementSequence (before postCollateral/Solana/confirm are
    // ever reached). clockCalls 2: confirmSettlementWithRetry's deadline
    // check after attempt 1 fails — early, so it retries. clockCalls 3: the
    // deadline check after attempt 2 fails — late, so it gives up.
    let clockCalls = 0;
    const nowSec = () => {
      clockCalls++;
      return clockCalls <= 2 ? Math.floor(Date.now() / 1000) : json.expiry + 999_999;
    };
    let attempts = 0;
    const deps = baseDeps({
      confirmSettlement: async (_id, _hash, onSigned) => {
        attempts++;
        onSigned(("0x" + "ee".repeat(32)) as `0x${string}`);
        return { ok: false, txHash: ("0x" + "ee".repeat(32)) as `0x${string}`, error: "reverted" };
      },
      nowSec,
    });
    await runArbitrumSettlementSequence(deps, intentId, json);
    const entry = getArbitrumLedgerEntry(intentId);
    check("retried at least once before giving up", attempts >= 2);
    check("ledger stage stays confirming (not confirmed)", entry?.stage === "confirming");
    check("confirm txHash recorded despite the revert", entry?.confirmTxHash === "0x" + "ee".repeat(32));
    check("state alertReason flags it as stuck / needing review", !!readState(intentId)?.alertReason?.includes("STUCK"));
  }

  console.log("[gate-test] 12b) confirmSettlementWithRetry: reverts once, then succeeds on retry -> confirmed");
  {
    const intentIdHex = "16".repeat(32);
    const intentId = ("0x" + intentIdHex) as `0x${string}`;
    const json = baseJson(intentIdHex);
    writeFakeProofBin(intentIdHex);
    let attempts = 0;
    const deps = baseDeps({
      confirmSettlement: async (_id, _hash, onSigned) => {
        attempts++;
        if (attempts === 1) {
          onSigned(("0x" + "aa".repeat(32)) as `0x${string}`);
          return { ok: false, txHash: ("0x" + "aa".repeat(32)) as `0x${string}`, error: "reverted" };
        }
        onSigned(("0x" + "bb".repeat(32)) as `0x${string}`);
        return { ok: true, txHash: ("0x" + "bb".repeat(32)) as `0x${string}` };
      },
    });
    await confirmSettlementWithRetry(deps, intentId, json, FAKE_ZK_PROOF_HASH);
    check("retried exactly once before succeeding", attempts === 2);
    const entry = getArbitrumLedgerEntry(intentId);
    check("ledger stage is confirmed", entry?.stage === "confirmed");
    check("final confirmTxHash is from the successful attempt", entry?.confirmTxHash === "0x" + "bb".repeat(32));
  }

  console.log("[gate-test] 12c) confirmSettlementWithRetry: on-chain becomes Settled mid-retry -> stop, mark confirmed, never re-send");
  {
    const intentIdHex = "17".repeat(32);
    const intentId = ("0x" + intentIdHex) as `0x${string}`;
    const json = baseJson(intentIdHex);
    writeFakeProofBin(intentIdHex);
    let readIntentCalls = 0;
    let confirmCalls = 0;
    const deps = baseDeps({
      readIntent: async () => {
        readIntentCalls++;
        // 1st check (before the 1st attempt): still Pending, so it attempts
        // confirmSettlement. That attempt "reverts" here — but per the spec,
        // the NEXT loop iteration re-checks on-chain status BEFORE
        // re-attempting, and finds it Settled (e.g. the first attempt
        // actually landed despite reporting failure, or something else
        // confirmed it) — must stop there, never send a 2nd confirmSettlement.
        return mockOnChainIntent({ status: readIntentCalls === 1 ? INTENT_STATUS_PENDING : INTENT_STATUS_SETTLED });
      },
      confirmSettlement: async (_id, _hash, onSigned) => {
        confirmCalls++;
        onSigned(("0x" + "cc".repeat(32)) as `0x${string}`);
        return { ok: false, txHash: ("0x" + "cc".repeat(32)) as `0x${string}`, error: "reverted" };
      },
    });
    await confirmSettlementWithRetry(deps, intentId, json, FAKE_ZK_PROOF_HASH);
    check("confirmSettlement attempted exactly once (stopped before a 2nd attempt)", confirmCalls === 1);
    check("ledger stage marked confirmed from the on-chain check, not a successful tx", getArbitrumLedgerEntry(intentId)?.stage === "confirmed");
  }

  console.log("[gate-test] 12d) confirmSettlementWithRetry: on-chain becomes Slashed/Refunded mid-retry -> stop and alert, never re-send");
  {
    const intentIdHex = "18".repeat(32);
    const intentId = ("0x" + intentIdHex) as `0x${string}`;
    const json = baseJson(intentIdHex);
    writeFakeProofBin(intentIdHex);
    let readIntentCalls = 0;
    let confirmCalls = 0;
    const deps = baseDeps({
      readIntent: async () => {
        readIntentCalls++;
        return mockOnChainIntent({ status: readIntentCalls === 1 ? INTENT_STATUS_PENDING : INTENT_STATUS_REFUNDED });
      },
      confirmSettlement: async (_id, _hash, onSigned) => {
        confirmCalls++;
        onSigned(("0x" + "dd".repeat(32)) as `0x${string}`);
        return { ok: false, txHash: ("0x" + "dd".repeat(32)) as `0x${string}`, error: "reverted" };
      },
    });
    await confirmSettlementWithRetry(deps, intentId, json, FAKE_ZK_PROOF_HASH);
    check("confirmSettlement attempted exactly once (stopped before a 2nd attempt)", confirmCalls === 1);
    check("ledger did not get marked confirmed (Refunded, not Settled)", getArbitrumLedgerEntry(intentId)?.stage !== "confirmed");
    check("state alertReason set", !!readState(intentId)?.alertReason?.includes("Refunded"));
  }

  console.log("[gate-test] 13) sequence: an intent already mid-sequence refuses to restart (no double postCollateral)");
  {
    const intentIdHex = "0d".repeat(32);
    const intentId = ("0x" + intentIdHex) as `0x${string}`;
    const json = baseJson(intentIdHex);
    setArbitrumStage(intentId, "collateral_posted", { collateralTxHash: "0x" + "ff".repeat(32) });
    let postCollateralCalled = false;
    const deps = baseDeps({ postCollateral: async () => { postCollateralCalled = true; return { ok: true }; } });
    await runArbitrumSettlementSequence(deps, intentId, json);
    check("postCollateral never called again", !postCollateralCalled);
    check("ledger entry unchanged", getArbitrumLedgerEntry(intentId)?.collateralTxHash === "0x" + "ff".repeat(32));
  }

  console.log("[gate-test] 14) sequence: crash right after signing postCollateral (thrown after onSigned) — ledger still durable");
  {
    const intentIdHex = "0e".repeat(32);
    const intentId = ("0x" + intentIdHex) as `0x${string}`;
    const json = baseJson(intentIdHex);
    const deps = baseDeps({
      postCollateral: async (_id, _v, onSigned) => {
        onSigned(("0x" + "11".repeat(32)) as `0x${string}`);
        throw new Error("simulated crash mid-broadcast");
      },
    });
    let threw = false;
    try {
      await runArbitrumSettlementSequence(deps, intentId, json);
    } catch {
      threw = true;
    }
    check("the crash propagates (mirrors a real process crash, not silently swallowed)", threw);
    const entry = getArbitrumLedgerEntry(intentId);
    check("ledger already recorded posting_collateral with the signed txHash BEFORE the crash", entry?.stage === "posting_collateral" && entry?.collateralTxHash === "0x" + "11".repeat(32));
  }

  // ══════════════════ pollAwaitingSlash ══════════════════

  console.log("[gate-test] 15) pollAwaitingSlash: not yet expired -> slashSolver not called");
  {
    const intentIdHex = "0f".repeat(32);
    const intentId = ("0x" + intentIdHex) as `0x${string}`;
    const fakeNow = Math.floor(Date.now() / 1000);
    setArbitrumStage(intentId, "awaiting_expiry_slash", { expiry: fakeNow + 1000 });
    let slashCalled = false;
    const deps = baseDeps({ slashSolver: async (_id, onSigned) => { slashCalled = true; onSigned(("0x" + "22".repeat(32)) as `0x${string}`); return { ok: true, txHash: ("0x" + "22".repeat(32)) as `0x${string}` }; }, nowSec: () => fakeNow });
    await pollAwaitingSlash(deps);
    check("slashSolver not called before expiry", !slashCalled);
  }

  console.log("[gate-test] 16) pollAwaitingSlash: past expiry -> slashSolver called, marked slashed");
  {
    const intentIdHex = "10".repeat(32);
    const intentId = ("0x" + intentIdHex) as `0x${string}`;
    const fakeNow = Math.floor(Date.now() / 1000);
    setArbitrumStage(intentId, "awaiting_expiry_slash", { expiry: fakeNow - 10 });
    const deps = baseDeps({ nowSec: () => fakeNow });
    await pollAwaitingSlash(deps);
    check("ledger stage is slashed", getArbitrumLedgerEntry(intentId)?.stage === "slashed");
    check("slash txHash recorded", getArbitrumLedgerEntry(intentId)?.slashTxHash === "0x" + "cc".repeat(32));
  }

  console.log("[gate-test] 17) pollAwaitingSlash: slashSolver reverts -> stays slashing, reason recorded");
  {
    const intentIdHex = "11".repeat(32);
    const intentId = ("0x" + intentIdHex) as `0x${string}`;
    const fakeNow = Math.floor(Date.now() / 1000);
    setArbitrumStage(intentId, "awaiting_expiry_slash", { expiry: fakeNow - 10 });
    const deps = baseDeps({
      slashSolver: async (_id, onSigned) => {
        onSigned(("0x" + "33".repeat(32)) as `0x${string}`);
        return { ok: false, txHash: ("0x" + "33".repeat(32)) as `0x${string}`, error: "reverted" };
      },
      nowSec: () => fakeNow,
    });
    await pollAwaitingSlash(deps);
    const entry = getArbitrumLedgerEntry(intentId);
    check("ledger stage stays slashing", entry?.stage === "slashing");
    check("slash txHash recorded despite the revert", entry?.slashTxHash === "0x" + "33".repeat(32));
  }

  // ══════════════════ reconcileArbitrumLedger (boot reconciliation) ══════════════════

  console.log("[gate-test] 18) reconciliation: posting_collateral tx landed (receipt success) -> collateral_posted");
  {
    const intentIdHex = "12".repeat(32);
    const intentId = ("0x" + intentIdHex) as `0x${string}`;
    setArbitrumStage(intentId, "posting_collateral", { collateralTxHash: "0x" + "44".repeat(32) });
    const fakePublicClient = { getTransactionReceipt: async () => ({ status: "success" }) } as unknown as Parameters<typeof reconcileArbitrumLedger>[1];
    const deps = baseDeps({ readIntent: async () => mockOnChainIntent({ status: INTENT_STATUS_PENDING }) });
    await reconcileArbitrumLedger(deps, fakePublicClient);
    check("ledger stage is collateral_posted", getArbitrumLedgerEntry(intentId)?.stage === "collateral_posted");
  }

  console.log("[gate-test] 19) reconciliation: posting_collateral tx reverted -> collateral_failed");
  {
    const intentIdHex = "13".repeat(32);
    const intentId = ("0x" + intentIdHex) as `0x${string}`;
    setArbitrumStage(intentId, "posting_collateral", { collateralTxHash: "0x" + "55".repeat(32) });
    const fakePublicClient = { getTransactionReceipt: async () => ({ status: "reverted" }) } as unknown as Parameters<typeof reconcileArbitrumLedger>[1];
    const deps = baseDeps({ readIntent: async () => mockOnChainIntent({ status: INTENT_STATUS_PENDING, solver: "0x0000000000000000000000000000000000000000" as `0x${string}` }) });
    await reconcileArbitrumLedger(deps, fakePublicClient);
    check("ledger stage is collateral_failed", getArbitrumLedgerEntry(intentId)?.stage === "collateral_failed");
  }

  console.log("[gate-test] 20) reconciliation: on-chain status already Settled -> marked confirmed regardless of ledger stage");
  {
    const intentIdHex = "14".repeat(32);
    const intentId = ("0x" + intentIdHex) as `0x${string}`;
    setArbitrumStage(intentId, "confirming", { confirmTxHash: "0x" + "66".repeat(32) });
    const fakePublicClient = { getTransactionReceipt: async () => { throw new Error("not found"); } } as unknown as Parameters<typeof reconcileArbitrumLedger>[1];
    const deps = baseDeps({ readIntent: async () => mockOnChainIntent({ status: INTENT_STATUS_SETTLED }) });
    await reconcileArbitrumLedger(deps, fakePublicClient);
    check("ledger stage is confirmed (chain is the source of truth)", getArbitrumLedgerEntry(intentId)?.stage === "confirmed");
  }

  console.log("[gate-test] 21) reconciliation: on-chain status already Slashed -> marked slashed regardless of ledger stage");
  {
    const intentIdHex = "15".repeat(32);
    const intentId = ("0x" + intentIdHex) as `0x${string}`;
    setArbitrumStage(intentId, "slashing", { slashTxHash: "0x" + "77".repeat(32) });
    const fakePublicClient = { getTransactionReceipt: async () => { throw new Error("not found"); } } as unknown as Parameters<typeof reconcileArbitrumLedger>[1];
    const deps = baseDeps({ readIntent: async () => mockOnChainIntent({ status: INTENT_STATUS_SLASHED }) });
    await reconcileArbitrumLedger(deps, fakePublicClient);
    check("ledger stage is slashed", getArbitrumLedgerEntry(intentId)?.stage === "slashed");
  }

  console.log("[gate-test] 22) runArbitrumSettlementSequence: the SAME zkProofHash (computeZkProofHash's output on the real fixture proof file) reaches BOTH the Solana leg and confirmSettlement — Gate 5D-vkey's one-source-of-truth requirement");
  {
    const intentIdHex = "19".repeat(32);
    const intentId = ("0x" + intentIdHex) as `0x${string}`;
    const json = baseJson(intentIdHex);
    writeFakeProofBin(intentIdHex);
    const expectedHash = computeZkProofHash(intentIdHex);

    let solanaLegHash: `0x${string}` | undefined;
    let confirmLegHash: `0x${string}` | undefined;
    const deps = baseDeps({
      runSolanaPayout: async (zkProofHash) => {
        solanaLegHash = zkProofHash;
        return { ok: true, sig: "solana-sig-1" };
      },
      confirmSettlement: async (_id, zkProofHash, onSigned) => {
        confirmLegHash = zkProofHash;
        onSigned(("0x" + "88".repeat(32)) as `0x${string}`);
        return { ok: true, txHash: ("0x" + "88".repeat(32)) as `0x${string}` };
      },
    });
    await runArbitrumSettlementSequence(deps, intentId, json);
    check("Solana leg received computeZkProofHash's real output", solanaLegHash === expectedHash);
    check("confirmSettlement leg received the SAME computeZkProofHash output", confirmLegHash === expectedHash);
    check("both legs received an identical hash (never independently derived)", solanaLegHash === confirmLegHash);
  }

  console.log("[gate-test] 23) reconciliation: collateral_posted + isAlreadySettled -> confirmSettlement is invoked directly, not just alerted (Gate 5D-resume-fix)");
  {
    const intentIdHex = "1a".repeat(32);
    const intentId = ("0x" + intentIdHex) as `0x${string}`;
    const json = baseJson(intentIdHex);
    writeFakeProofBin(intentIdHex);
    fs.writeFileSync(path.join(process.env.ZK_DIR_PATH as string, `proof_${intentIdHex}.json`), JSON.stringify(json));
    markSettled(intentId); // Solana leg already succeeded per the local ledger
    setArbitrumStage(intentId, "collateral_posted", { collateralTxHash: "0x" + "aa".repeat(32), expiry: json.expiry });

    let confirmCalls = 0;
    const deps = baseDeps({
      confirmSettlement: async (_id, _hash, onSigned) => {
        confirmCalls++;
        onSigned(("0x" + "ee".repeat(32)) as `0x${string}`);
        return { ok: true, txHash: ("0x" + "ee".repeat(32)) as `0x${string}` };
      },
    });
    const fakePublicClient = { getTransactionReceipt: async () => { throw new Error("not found"); } } as unknown as Parameters<typeof reconcileArbitrumLedger>[1];
    await reconcileArbitrumLedger(deps, fakePublicClient);
    check("confirmSettlement was invoked directly on reconciliation, not just alerted", confirmCalls === 1);
    check("ledger stage advanced to confirmed", getArbitrumLedgerEntry(intentId)?.stage === "confirmed");
    check("no alert was recorded for this intent (resumed automatically instead)", !readState(intentId)?.alertReason);
  }

  console.log("[gate-test] 24) reconciliation: collateral_posted + isAlreadySettled but proof JSON missing -> still only alerts (genuine unhandled case)");
  {
    const intentIdHex = "1b".repeat(32);
    const intentId = ("0x" + intentIdHex) as `0x${string}`;
    markSettled(intentId); // Solana leg already succeeded, but no proof_<id>.json/.bin ever written for this id
    setArbitrumStage(intentId, "collateral_posted", { collateralTxHash: "0x" + "bb".repeat(32) });

    let confirmCalls = 0;
    const deps = baseDeps({
      confirmSettlement: async (_id, _hash, onSigned) => {
        confirmCalls++;
        onSigned(("0x" + "ff".repeat(32)) as `0x${string}`);
        return { ok: true, txHash: ("0x" + "ff".repeat(32)) as `0x${string}` };
      },
    });
    const fakePublicClient = { getTransactionReceipt: async () => { throw new Error("not found"); } } as unknown as Parameters<typeof reconcileArbitrumLedger>[1];
    await reconcileArbitrumLedger(deps, fakePublicClient);
    check("confirmSettlement NOT invoked without a readable proof JSON", confirmCalls === 0);
    check("ledger stage stays collateral_posted (not silently advanced)", getArbitrumLedgerEntry(intentId)?.stage === "collateral_posted");
    check("alert recorded instead", !!readState(intentId)?.alertReason?.includes("needs manual review"));
  }

  console.log("[gate-test] 25) reconciliation: one collateral_posted entry throwing unexpectedly does NOT block the next entry's recovery (Gate 5D-resume-fix-2)");
  {
    const throwingIdHex = "1c".repeat(32);
    const throwingId = ("0x" + throwingIdHex) as `0x${string}`;
    const okIdHex = "1d".repeat(32);
    const okId = ("0x" + okIdHex) as `0x${string}`;

    const throwingJson = baseJson(throwingIdHex);
    const okJson = baseJson(okIdHex);
    writeFakeProofBin(throwingIdHex);
    writeFakeProofBin(okIdHex);
    fs.writeFileSync(path.join(process.env.ZK_DIR_PATH as string, `proof_${throwingIdHex}.json`), JSON.stringify(throwingJson));
    fs.writeFileSync(path.join(process.env.ZK_DIR_PATH as string, `proof_${okIdHex}.json`), JSON.stringify(okJson));

    markSettled(throwingId);
    markSettled(okId);
    setArbitrumStage(throwingId, "collateral_posted", { collateralTxHash: "0x" + "cc".repeat(32), expiry: throwingJson.expiry });
    setArbitrumStage(okId, "collateral_posted", { collateralTxHash: "0x" + "dd".repeat(32), expiry: okJson.expiry });

    let confirmCalls = 0;
    const deps = baseDeps({
      readIntent: async (id) => {
        if (id.toLowerCase() === throwingId.toLowerCase()) {
          throw new Error("simulated RPC failure reading intent state");
        }
        return mockOnChainIntent();
      },
      confirmSettlement: async (_id, _hash, onSigned) => {
        confirmCalls++;
        onSigned(("0x" + "01".repeat(32)) as `0x${string}`);
        return { ok: true, txHash: ("0x" + "01".repeat(32)) as `0x${string}` };
      },
    });
    const fakePublicClient = { getTransactionReceipt: async () => { throw new Error("not found"); } } as unknown as Parameters<typeof reconcileArbitrumLedger>[1];

    let threw = false;
    try {
      await reconcileArbitrumLedger(deps, fakePublicClient);
    } catch {
      threw = true;
    }
    check("reconcileArbitrumLedger itself did not throw", !threw);
    check("the throwing entry got an alert, not a crash", !!readState(throwingId)?.alertReason?.includes("threw unexpectedly"));
    check("the throwing entry's ledger stage stays collateral_posted (not silently advanced)", getArbitrumLedgerEntry(throwingId)?.stage === "collateral_posted");
    check("the NEXT entry was still processed (confirmSettlement invoked despite the first entry's throw)", confirmCalls === 1);
    check("the next entry's ledger reached confirmed", getArbitrumLedgerEntry(okId)?.stage === "confirmed");
  }

  if (failures > 0) {
    console.error(`\n[gate-test] ${failures} check(s) FAILED`);
    process.exit(1);
  } else {
    console.log(`\n[gate-test] all checks passed`);
  }
}

main();
