// Ad-hoc verification of the Gate 5C per-intent state store — atomic
// read/write round-tripping, every stage-transition setter, and the
// finality comparison logic — using fixture data only, no network calls and
// no real orchestrator process. Same "no test runner wired up yet" pattern
// as prover_pipeline.gate.test.ts; run with:
//
//   MAAT_STATE_DIR=/tmp/gate-test-state npx ts-node src/intent_state.gate.test.ts
//
// The MAAT_STATE_DIR override is required — without it this would read and
// write the real orchestrator/state/intents directory.
import * as fs from "fs";

if (!process.env.MAAT_STATE_DIR) {
  console.error("[gate-test] refusing to run without MAAT_STATE_DIR set (would touch the real state dir)");
  process.exit(1);
}

// Imported after the env check above, since intent_state.ts reads
// MAAT_STATE_DIR once at module load to compute STATE_DIR.
import {
  STATE_DIR,
  recordIntentCreated,
  setProving,
  setRetrying,
  setVerified,
  setRejected,
  setAlert,
  recordAlertReason,
  setSettling,
  setSettled,
  setUnconfirmedNeedsReview,
  readState,
  listPendingFinality,
  isBlockFinal,
  setFinal,
} from "./intent_state";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    console.error(`  FAIL ${name}`);
    failures++;
  }
}

function baseFields(intentId: string, overrides: Partial<Parameters<typeof recordIntentCreated>[0]> = {}) {
  return {
    intentId,
    sourceChain: "Arbitrum Sepolia",
    sourceTxHash: "0x" + "aa".repeat(32),
    blockNumber: 100,
    blockHash: "0x" + "bb".repeat(32),
    amountWei: "1000000000000000000",
    tokenAddress: "0x" + "0".repeat(40),
    destinationChainId: "1399811149",
    destinationWallet: "C9CZZFbeJ2Vzj9w8ctcsYKyK4mLQNq2vvsGwPJ7uEHtd",
    ...overrides,
  };
}

console.log("[gate-test] 1) queued -> proving -> retrying -> verified, timestamps accumulate");
{
  const id = "0x" + "01".repeat(32);
  recordIntentCreated(baseFields(id), { kind: "queued" });
  let s = readState(id)!;
  check("proofStatus queued", s.proofStatus.kind === "queued");
  check("queuedAt set", !!s.timestamps.queuedAt);

  setProving(id);
  s = readState(id)!;
  check("proofStatus proving", s.proofStatus.kind === "proving");
  check("provingStartedAt set", !!s.timestamps.provingStartedAt);

  setRetrying(id, 2, 3);
  s = readState(id)!;
  check("proofStatus retrying", s.proofStatus.kind === "retrying");
  check("attempt/maxAttempts recorded", s.proofStatus.attempt === 2 && s.proofStatus.maxAttempts === 3);
  check("provingStartedAt preserved across retry", !!s.timestamps.provingStartedAt);

  setVerified(id, "0xVKEY");
  s = readState(id)!;
  check("proofStatus verified", s.proofStatus.kind === "verified");
  check("vkey recorded", s.vkey === "0xVKEY");
  check("verifiedAt set", !!s.timestamps.verifiedAt);
  check("queuedAt still present (never cleared)", !!s.timestamps.queuedAt);
}

console.log("[gate-test] 2) rejected and alert set reason text without clobbering base fields");
{
  const id = "0x" + "02".repeat(32);
  recordIntentCreated(baseFields(id), { kind: "queued" });
  setRejected(id, "semantic reject (exit 2)");
  let s = readState(id)!;
  check("proofStatus rejected", s.proofStatus.kind === "rejected");
  check("rejectReason recorded", s.rejectReason === "semantic reject (exit 2)");
  check("sourceChain untouched", s.sourceChain === "Arbitrum Sepolia");

  const id2 = "0x" + "03".repeat(32);
  recordIntentCreated(baseFields(id2), { kind: "queued" });
  setVerified(id2, "0xVKEY");
  recordAlertReason(id2, "settle gate REFUSED (failed: block_hash) — not settling");
  s = readState(id2)!;
  check("proofStatus stays verified after a post-verify alert", s.proofStatus.kind === "verified");
  check("alertReason recorded independently of proofStatus", s.alertReason === "settle gate REFUSED (failed: block_hash) — not settling");
}

console.log("[gate-test] 3) skipped chain never touches proofStatus verified/rejected");
{
  const id = "0x" + "04".repeat(32);
  recordIntentCreated(baseFields(id, { sourceChain: "TRON Nile Testnet" }), { kind: "skipped", chain: "TRON Nile Testnet" });
  const s = readState(id)!;
  check("proofStatus skipped", s.proofStatus.kind === "skipped");
  check("chain recorded on skip", s.proofStatus.chain === "TRON Nile Testnet");
  check("no queuedAt for a skipped intent", !s.timestamps.queuedAt);
}

console.log("[gate-test] 4) settlement mirrors settling -> settled, and the unconfirmed-needs-review path");
{
  const id = "0x" + "05".repeat(32);
  recordIntentCreated(baseFields(id), { kind: "queued" });
  setVerified(id, "0xVKEY");
  setSettling(id, "SIG1");
  let s = readState(id)!;
  check("settlement settling with sig", s.settlement.kind === "settling" && s.settlement.sig === "SIG1");
  check("settlingAt set", !!s.timestamps.settlingAt);

  setSettled(id, "SIG1");
  s = readState(id)!;
  check("settlement settled", s.settlement.kind === "settled" && s.settlement.sig === "SIG1");
  check("settledAt set", !!s.timestamps.settledAt);

  const id2 = "0x" + "06".repeat(32);
  recordIntentCreated(baseFields(id2), { kind: "queued" });
  setVerified(id2, "0xVKEY");
  setSettling(id2, "SIG2");
  setUnconfirmedNeedsReview(id2, "SIG2");
  s = readState(id2)!;
  check("settlement unconfirmed-needs-review", s.settlement.kind === "unconfirmed-needs-review" && s.settlement.sig === "SIG2");
}

console.log('[gate-test] 5) finality: the known test intent (block 311887667, already L1-final) flips pending -> final');
{
  // Identifiers as given in the Gate 5C brief (abbreviated there); the
  // fixture only needs a unique key and the real block number to exercise
  // the actual comparison this test is about.
  const id = "0x184227b2" + "00".repeat(24) + "4788313c";
  recordIntentCreated(
    baseFields(id, {
      sourceChain: "Arbitrum Sepolia",
      sourceTxHash: "0x3983931f" + "00".repeat(24) + "889ce363",
      blockNumber: 311887667,
    }),
    { kind: "queued" }
  );
  setVerified(id, "0xVKEY");

  let pending = listPendingFinality("Arbitrum Sepolia").map((s) => s.intentId);
  check("intent appears in pending-finality list before the poll", pending.includes(id));

  // "already L1-final": the chain's current finalized tip is past this block.
  const finalizedBlockNumber = 311887667 + 1000;
  check("isBlockFinal(311887667, tip) === true", isBlockFinal(311887667, finalizedBlockNumber));

  for (const s of listPendingFinality("Arbitrum Sepolia")) {
    if (s.blockNumber != null && isBlockFinal(s.blockNumber, finalizedBlockNumber)) setFinal(s.intentId);
  }

  const s = readState(id)!;
  check("finality final", s.finality === "final");
  check("finalAt set", !!s.timestamps.finalAt);

  pending = listPendingFinality("Arbitrum Sepolia").map((st) => st.intentId);
  check("intent no longer pending finality after marking final", !pending.includes(id));
}

console.log("[gate-test] 6) atomic write: no .tmp files left behind, on-disk JSON round-trips exactly");
{
  const id = "0x" + "07".repeat(32);
  recordIntentCreated(baseFields(id), { kind: "queued" });
  const leftoverTmp = fs.readdirSync(STATE_DIR).filter((f) => f.endsWith(".tmp"));
  check("no leftover .tmp files in STATE_DIR", leftoverTmp.length === 0);

  const onDisk = JSON.parse(fs.readFileSync(`${STATE_DIR}/${id.replace(/^0x/, "")}.json`, "utf8"));
  check("on-disk file matches readState()", JSON.stringify(onDisk) === JSON.stringify(readState(id)));
}

if (failures > 0) {
  console.error(`\n[gate-test] ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log(`\n[gate-test] all checks passed`);
}
