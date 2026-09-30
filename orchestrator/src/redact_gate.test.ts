// Gate test (Phase 7B addition): a secret-shaped string reaching alertReason
// or rejectReason — most concretely, an Alchemy-style RPC URL with its API
// key baked into the path, which is exactly what a reqwest/viem network
// error's message can embed — must come out redacted at EVERY sink this
// process controls: redact() itself, the alerts.log line (prover_pipeline.ts's
// alert()), and the per-intent state file (intent_state.ts's
// setAlert/recordAlertReason/setRejected). ma-at-web's own redact() on
// /api/proofs (lib/proofState.gate.test.ts) is the fourth sink, covered
// there — this file only covers what lives in this repo.
//
// No subprocess spawning here (unlike prover_pipeline_env_gate.test.ts) —
// fast, and MAAT_STATE_DIR/ALERT_LOG_PATH-scoped so it never touches real
// state. Run with:
//
//   MAAT_STATE_DIR=/tmp/gate-test-redact-state \
//   ALERT_LOG_PATH=/tmp/gate-test-redact-alerts.log \
//   npx ts-node src/redact_gate.test.ts
import * as fs from "fs";

for (const v of ["MAAT_STATE_DIR", "ALERT_LOG_PATH"]) {
  if (!process.env[v]) {
    console.error(`[gate-test] refusing to run without ${v} set (would touch real state)`);
    process.exit(1);
  }
}

// Imported after the env checks above — intent_state.ts reads MAAT_STATE_DIR
// and prover_pipeline.ts reads ALERT_LOG_PATH once, at module load.
import { redact, redactError } from "./redact";
import { readState, setAlert, recordAlertReason, setRejected } from "./intent_state";
import { alert } from "./prover_pipeline";

const FAKE_URL_WITH_KEY = "https://arb-sepolia.g.alchemy.com/v2/FAKEKEY123";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    console.error(`  FAIL ${name}`);
    failures++;
  }
}

console.log("[gate-test] 1) redact() strips the exact Alchemy-style URL+key");
{
  const out = redact(`request failed: ${FAKE_URL_WITH_KEY} timed out`);
  check("URL gone", !out.includes(FAKE_URL_WITH_KEY));
  check("key gone", !out.includes("FAKEKEY123"));
  check("placeholder present", out.includes("[redacted-url]"));
}

console.log("[gate-test] 2) alert() writes a redacted line to ALERT_LOG_PATH, not the raw URL");
{
  // 0x-prefixed hex, matching this codebase's own hash/ID convention (see
  // redact.ts's doc comment) — a hyphenated human-readable label would get
  // swept up by the long-opaque-token pass too, which is correct behavior,
  // not something to test around.
  const intentId = "0x" + "ee".repeat(32);
  alert(`intent ${intentId}: RPC error: ${FAKE_URL_WITH_KEY}`);
  const logContent = fs.readFileSync(process.env.ALERT_LOG_PATH as string, "utf8");
  check("alerts.log mentions this test's intent id", logContent.includes(intentId));
  check("alerts.log does NOT contain the raw URL", !logContent.includes(FAKE_URL_WITH_KEY));
  check("alerts.log does NOT contain the raw key", !logContent.includes("FAKEKEY123"));
  check("alerts.log contains the redaction placeholder", logContent.includes("[redacted-url]"));
}

console.log("[gate-test] 3) setAlert() persists a redacted alertReason to the state file");
{
  const intentId = "0x" + "aa".repeat(32);
  setAlert(intentId, `settlement spawn failed: ${FAKE_URL_WITH_KEY}`);
  const state = readState(intentId);
  check("state record exists", state !== null);
  check("alertReason does NOT contain the raw URL", !!state && !state.alertReason?.includes(FAKE_URL_WITH_KEY));
  check("alertReason does NOT contain the raw key", !!state && !state.alertReason?.includes("FAKEKEY123"));
  check("alertReason contains the redaction placeholder", !!state && !!state.alertReason?.includes("[redacted-url]"));
}

console.log("[gate-test] 4) recordAlertReason() persists a redacted alertReason without touching proofStatus");
{
  const intentId = "0x" + "bb".repeat(32);
  recordAlertReason(intentId, `failed to fetch canonical block: ${FAKE_URL_WITH_KEY}`);
  const state = readState(intentId);
  check("state record exists", state !== null);
  check("alertReason does NOT contain the raw URL", !!state && !state.alertReason?.includes(FAKE_URL_WITH_KEY));
  check("alertReason contains the redaction placeholder", !!state && !!state.alertReason?.includes("[redacted-url]"));
}

console.log("[gate-test] 5) setRejected() persists a redacted rejectReason to the state file");
{
  const intentId = "0x" + "cc".repeat(32);
  setRejected(intentId, `semantic reject: upstream said ${FAKE_URL_WITH_KEY}`);
  const state = readState(intentId);
  check("state record exists", state !== null);
  check("rejectReason does NOT contain the raw URL", !!state && !state.rejectReason?.includes(FAKE_URL_WITH_KEY));
  check("rejectReason contains the redaction placeholder", !!state && !!state.rejectReason?.includes("[redacted-url]"));
}

console.log("[gate-test] 6) redact() does NOT over-redact an env var NAME or an 0x-prefixed id (regression guard)");
{
  const envName = redact("ARBITRUM_INTENT_MANAGER_ADDRESS is not set");
  check("env var name survives", envName.includes("ARBITRUM_INTENT_MANAGER_ADDRESS"));
  const idText = "intent 0x" + "dd".repeat(32) + ": ok";
  check("0x-prefixed id survives", redact(idText) === idText);
}

console.log("[gate-test] 7) redactError(): a viem-shaped Error whose message embeds a fake Alchemy URL comes out clean — this is what listener.ts's logError() (every watchContractEvent onError, every RPC catch) now passes every console.error through");
{
  // Mirrors the actual shape of a real viem HttpRequestError message: the
  // full request URL embedded, API key and all.
  const viemStyleError = new Error(
    `HTTP request failed.\n\nURL: ${FAKE_URL_WITH_KEY}\nRequest body: {"method":"eth_getBlockByNumber"}\n\nDetails: Must be authenticated!`
  );
  const out = redactError(viemStyleError);
  check("raw URL gone", !out.includes(FAKE_URL_WITH_KEY));
  check("raw key gone", !out.includes("FAKEKEY123"));
  check("placeholder present", out.includes("[redacted-url]"));
  check("surrounding diagnostic text preserved", out.includes("Must be authenticated!"));
}

console.log("[gate-test] 8) redactError(): handles a non-Error thrown value too (unhandledRejection's `reason` can be anything)");
{
  const out = redactError(`connection reset while calling ${FAKE_URL_WITH_KEY}`);
  check("string-thrown value also redacted", !out.includes(FAKE_URL_WITH_KEY) && out.includes("[redacted-url]"));
}

console.log("[gate-test] 9) redact() does NOT redact lowercase snake_case reason codes (Phase 4 false positive)");
{
  for (const code of ["insufficient_available_capital", "track_record_unavailable", "amount_exceeds_max_transfer"]) {
    check(`${code} survives alone`, redact(code) === code);
  }
  const reason =
    "no eligible solver — 0xb1cc4DB8EC2430E60aaf1b1B8e564b8364383637: insufficient_available_capital(available=100,required=200), track_record_unavailable, amount_exceeds_max_transfer";
  check("all three survive inside a real routing reason", redact(reason) === reason);
}

console.log("[gate-test] 10) the snake_case exemption does NOT let secret shapes through");
{
  const mustRedact: Array<[string, string]> = [
    ["mixed-case alphanumeric (Alchemy-style key)", "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY"],
    ["lowercase hex, no 0x (raw private key shape)", "11".repeat(32)],
    ["lowercase alphanumeric, no underscore", "k3j2h4g5f6d7s8a9q1w2e3r4t5y6"],
    ["prefixed key with digits (provider-key style)", "test_fixture_0000aaaa1111bbbb222"],
    ["prefixed key, mixed case", "test_fixture_0000AaAa1111BbBb222"],
    ["snake_case prefix with a secret glued on by a hyphen", "some_reason_code-aB3dE5fG7hJ9kL1mN3pQ"],
    ["snake_case prefix with a digit segment", "reason_code_a8f3k2x9q1w2e3r4t5"],
    ["base64url token with - and _", "dGhpc19pc19h-c2VjcmV0X3Rva2Vu_Zm9vYmFy"],
    ["leading-underscore token", "_abcdefghijklmnopqrstuvwxyz_abc"],
  ];
  for (const [label, secret] of mustRedact) {
    const out = redact(`auth failed: ${secret} rejected`);
    check(`${label} redacted`, !out.includes(secret) && out.includes("[redacted]"));
  }
}

if (failures > 0) {
  console.error(`\n[gate-test] ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log(`\n[gate-test] all checks passed`);
}
