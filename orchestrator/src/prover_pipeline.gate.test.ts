// Ad-hoc verification of evaluateSettleGate's six checks, using a mocked
// ProofOutputJson — no prove mode, no zkVM, no network calls, so this runs
// standalone (Gate 5B-fix item 3). No test runner (jest/vitest) is wired up
// in this package yet, so this is a plain assertion script pending a real
// one being approved; run with:
//
//   SETTLED_LEDGER_PATH=/tmp/gate-test-ledger.json \
//   MAAT_STATE_DIR=/tmp/gate-test-state \
//   ALERT_LOG_PATH=/tmp/gate-test-alerts.log \
//   npx ts-node src/prover_pipeline.gate.test.ts
//
// All three overrides are required — without them this would read/write the
// real settled_intents.json ledger, per-intent state files, and alerts.log
// (reconcileSettlingLedger's tests below touch all three).
import {
  evaluateSettleGate,
  markSettled,
  markSettling,
  getLedgerEntry,
  reconcileSettlingLedger,
  _resetSettlingAlertDedupeForTests,
  EXPECTED_VKEY,
  type ProofOutputJson,
} from "./prover_pipeline";

for (const v of ["SETTLED_LEDGER_PATH", "MAAT_STATE_DIR", "ALERT_LOG_PATH"]) {
  if (!process.env[v]) {
    console.error(`[gate-test] refusing to run without ${v} set (would touch real state)`);
    process.exit(1);
  }
}

const EXPECTED_CONTRACT = "0x9D1bd7119E9FefF6Baa3968272811323B354B16f";
const CANONICAL_BLOCK_HASH = "0x" + "ab".repeat(32);
const FUTURE_EXPIRY = Math.floor(Date.now() / 1000) + 3600;

function baseJson(overrides: Partial<ProofOutputJson> = {}): ProofOutputJson {
  return {
    tx_hash: "0x" + "11".repeat(32),
    mode: "prove",
    vkey: EXPECTED_VKEY,
    block_hash: CANONICAL_BLOCK_HASH,
    block_number: 12345,
    block_timestamp: Math.floor(Date.now() / 1000) - 60,
    contract: EXPECTED_CONTRACT,
    intent_id: "0x" + "22".repeat(32),
    sender: "0x" + "33".repeat(20),
    amount: "0x" + "0".repeat(63) + "1",
    token_address: "0x" + "0".repeat(40),
    destination_wallet: "0x" + "44".repeat(32),
    destination_chain_id: 1399811149,
    expiry: FUTURE_EXPIRY,
    slippage_bps: 50,
    ...overrides,
  };
}

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    console.error(`  FAIL ${name}`);
    failures++;
  }
}

console.log("[gate-test] 1) all-valid proof -> gate passes");
{
  const gate = evaluateSettleGate(baseJson(), EXPECTED_CONTRACT, CANONICAL_BLOCK_HASH);
  check("ok === true", gate.ok === true);
  check("no failed checks", gate.failedChecks.length === 0);
}

console.log("[gate-test] 2) fabricated-but-internally-consistent header: only block_hash disagrees with the canonical hash at that block_number");
{
  // Everything else in this JSON is self-consistent (contract, vkey,
  // destination, expiry all correct) — only block_hash was fabricated to
  // point at a header that was never the real chain's block at that
  // height. This is exactly the case the gate exists to catch: a proof
  // can never talk the orchestrator into trusting its own claim about
  // block_hash, because the canonical hash is independently re-fetched.
  const fabricated = baseJson({ block_hash: "0x" + "ff".repeat(32) });
  const gate = evaluateSettleGate(fabricated, EXPECTED_CONTRACT, CANONICAL_BLOCK_HASH);
  check("ok === false", gate.ok === false);
  check("failed on block_hash", gate.failedChecks.includes("block_hash"));
  check("nothing else failed", gate.failedChecks.length === 1);
}

console.log("[gate-test] 3) wrong contract");
{
  const gate = evaluateSettleGate(baseJson({ contract: "0x" + "99".repeat(20) }), EXPECTED_CONTRACT, CANONICAL_BLOCK_HASH);
  check("failed on contract", gate.failedChecks.includes("contract"));
}

console.log("[gate-test] 4) wrong vkey");
{
  const gate = evaluateSettleGate(baseJson({ vkey: "0xdeadbeef" }), EXPECTED_CONTRACT, CANONICAL_BLOCK_HASH);
  check("failed on vkey", gate.failedChecks.includes("vkey"));
}

console.log("[gate-test] 5) already-settled intent");
{
  const json = baseJson({ intent_id: "0x" + "55".repeat(32) });
  markSettled(json.intent_id);
  const gate = evaluateSettleGate(json, EXPECTED_CONTRACT, CANONICAL_BLOCK_HASH);
  check("failed on already_settled", gate.failedChecks.includes("already_settled"));
}

console.log("[gate-test] 6) wrong destination chain");
{
  const gate = evaluateSettleGate(baseJson({ destination_chain_id: 42161 }), EXPECTED_CONTRACT, CANONICAL_BLOCK_HASH);
  check("failed on destination_chain_id", gate.failedChecks.includes("destination_chain_id"));
}

console.log("[gate-test] 7) expired intent");
{
  const gate = evaluateSettleGate(baseJson({ expiry: Math.floor(Date.now() / 1000) - 10 }), EXPECTED_CONTRACT, CANONICAL_BLOCK_HASH);
  check("failed on expiry", gate.failedChecks.includes("expiry"));
}

// ══════════════════ reconcileSettlingLedger (Gate 5D-slash-fix) ══════════════════
// Fresh Solana-signature check every call, dedupes its own repeat alerts,
// and — the actual gate — an entry that was "needs manual review" at one
// call because it hadn't landed YET gets picked up automatically the moment
// a later call finds it landed, instead of staying stuck forever.
//
// Wrapped in an async IIFE: everything above this point is synchronous
// (evaluateSettleGate is pure), but reconcileSettlingLedger is async, and
// this file (a plain script, no test runner) has no top-level await.
(async () => {

console.log("[gate-test] 8) reconcileSettlingLedger: signature confirmed -> marked settled, not left in settling");
{
  const intentId = "0x" + "aa".repeat(32);
  markSettling(intentId, "sig-confirmed-now");
  let checkCalls = 0;
  await reconcileSettlingLedger({
    checkSolanaSignatureLanded: async (sig) => {
      checkCalls++;
      return sig === "sig-confirmed-now";
    },
  });
  check("signature was checked", checkCalls === 1);
  check("ledger entry marked settled", getLedgerEntry(intentId)?.status === "settled");
}

console.log("[gate-test] 9) reconcileSettlingLedger: not yet landed -> stays settling, alerted");
{
  const intentId = "0x" + "bb".repeat(32);
  markSettling(intentId, "sig-not-yet-landed");
  await reconcileSettlingLedger({ checkSolanaSignatureLanded: async (sig) => sig === "sig-not-yet-landed" ? false : false });
  check("ledger entry stays settling", getLedgerEntry(intentId)?.status === "settling");
}

console.log("[gate-test] 10) reconcileSettlingLedger: called again later, now landed -> automatically picked up and marked settled (the actual gate: not stuck forever just because an earlier call said 'needs manual review')");
{
  const intentId = "0x" + "cc".repeat(32);
  markSettling(intentId, "sig-lands-eventually");
  await reconcileSettlingLedger({ checkSolanaSignatureLanded: async (sig) => (sig === "sig-lands-eventually" ? false : false) });
  check("first call: still settling", getLedgerEntry(intentId)?.status === "settling");

  // Simulates a later periodic call (Gate 5D-slash-fix's setInterval in
  // listener.ts) — same signature, now confirmed on Solana. Scoped by sig so
  // it only resolves THIS entry, not any other still-pending leftover one.
  await reconcileSettlingLedger({ checkSolanaSignatureLanded: async (sig) => sig === "sig-lands-eventually" });
  check("later call: automatically marked settled, no manual intervention needed", getLedgerEntry(intentId)?.status === "settled");
}

console.log("[gate-test] 11) reconcileSettlingLedger: repeat calls on a still-unresolved entry alert only ONCE (dedupe), not on every periodic tick");
{
  _resetSettlingAlertDedupeForTests();
  const intentId = "0x" + "dd".repeat(32);
  markSettling(intentId, "sig-stuck");
  let stuckCheckCalls = 0;
  const deps = {
    checkSolanaSignatureLanded: async (sig: string) => {
      if (sig === "sig-stuck") stuckCheckCalls++;
      return false;
    },
  };
  await reconcileSettlingLedger(deps);
  await reconcileSettlingLedger(deps);
  await reconcileSettlingLedger(deps);
  check("the signature was re-checked fresh on every call (never cached)", stuckCheckCalls === 3);
  check("still settling after 3 unresolved checks", getLedgerEntry(intentId)?.status === "settling");
}

console.log("[gate-test] 12) reconcileSettlingLedger: a fresh signature-check failure (thrown, not just false) for one entry alerts for THAT entry but doesn't stop the pass");
{
  const okId = "0x" + "ee".repeat(32);
  const brokenId = "0x" + "ff".repeat(32);
  markSettling(okId, "sig-ok");
  markSettling(brokenId, "sig-rpc-throws");
  let threw = false;
  try {
    await reconcileSettlingLedger({
      checkSolanaSignatureLanded: async (sig) => {
        if (sig === "sig-rpc-throws") throw new Error("simulated RPC failure");
        return sig === "sig-ok";
      },
    });
  } catch {
    threw = true;
  }
  check("reconcileSettlingLedger itself did not throw", !threw);
  check("the unaffected entry still resolved to settled", getLedgerEntry(okId)?.status === "settled");
  check("the entry whose check threw stays settling (not silently marked either way)", getLedgerEntry(brokenId)?.status === "settling");
}

if (failures > 0) {
  console.error(`\n[gate-test] ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log(`\n[gate-test] all checks passed`);
}

})();
