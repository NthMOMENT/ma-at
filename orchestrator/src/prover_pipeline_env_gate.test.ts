// Gate test (Phase 7 follow-up, Gate 7B-confirm item 3): when
// ARBITRUM_INTENT_MANAGER_ADDRESS is unset, prove.rs fails fast with a clear
// message before ever touching the zkVM (see intent_manager_address() in
// zk/script/src/bin/prove.rs). This test confirms that message survives all
// the way through the orchestrator's real spawn chain — flock + systemd-run
// --scope, exactly as production invokes it, no mocking of that layer — and
// lands as a CLEAR reason on the final alert, not a silent retry loop that
// only ever says "exit 1".
//
// Uses a tiny fake "prover" binary (PROVER_BINARY_PATH) that reproduces
// prove.rs's own fail-fast message/exit code exactly, so this exercises the
// real spawn/env-propagation path without paying for the real ~7min/14GB SP1
// binary. Recreate it with:
//
//   cat > /tmp/maat-gate-fake-prover.sh <<'EOF'
//   #!/bin/sh
//   if [ -z "$ARBITRUM_INTENT_MANAGER_ADDRESS" ]; then
//     echo "[maat-zk] PRE-CHECK FAILED (infra): ARBITRUM_INTENT_MANAGER_ADDRESS is not set — refusing to guess a contract address" >&2
//     exit 1
//   fi
//   echo "[maat-zk] unexpected: ARBITRUM_INTENT_MANAGER_ADDRESS was set in the fake-prover gate test" >&2
//   exit 1
//   EOF
//   chmod +x /tmp/maat-gate-fake-prover.sh
//
// Then run with (all five required — this would otherwise touch real state):
//
//   SETTLED_LEDGER_PATH=/tmp/gate-test-env-ledger.json \
//   ALERT_LOG_PATH=/tmp/gate-test-env-alerts.log \
//   PROVER_LOCK_FILE=/tmp/gate-test-env-prover.lock \
//   PROVER_BINARY_PATH=/tmp/maat-gate-fake-prover.sh \
//   MAAT_STATE_DIR=/tmp/gate-test-env-state \
//   npx ts-node src/prover_pipeline_env_gate.test.ts
//
// Takes ~20s: MAX_PROVER_RETRIES=3 means two real backoff sleeps
// (5s + 15s) before the pipeline gives up — deliberately not mocked away,
// since the backoff schedule itself is part of what's under test.
import * as fs from "fs";

for (const v of ["SETTLED_LEDGER_PATH", "ALERT_LOG_PATH", "PROVER_LOCK_FILE", "PROVER_BINARY_PATH", "MAAT_STATE_DIR"]) {
  if (!process.env[v]) {
    console.error(`[gate-test] refusing to run without ${v} set (see this file's header comment)`);
    process.exit(1);
  }
}

import { proveIntent } from "./prover_pipeline";

// The condition under test — deliberately absent for this whole process, so
// it's absent for runProverProcess's spawn (which inherits process.env).
delete process.env.ARBITRUM_INTENT_MANAGER_ADDRESS;

const FAKE_TX_HASH = "0x" + "aa".repeat(32);
const FAKE_INTENT_ID_HEX = "bb".repeat(32);

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    console.error(`  FAIL ${name}`);
    failures++;
  }
}

async function main(): Promise<void> {
  console.log("[gate-test] proveIntent() with ARBITRUM_INTENT_MANAGER_ADDRESS unset (expect: 3 infra retries, then a clear alert)...");
  const start = Date.now();
  const outcome = await proveIntent(FAKE_TX_HASH, FAKE_INTENT_ID_HEX);
  const elapsedMs = Date.now() - start;

  check("outcome.status === 'alert' (not a silent hang, not settle-check, not rejected)", outcome.status === "alert");
  check("took at least one real backoff (>= 5000ms) — retries actually happened, not short-circuited", elapsedMs >= 5000);

  const alertLog = fs.readFileSync(process.env.ALERT_LOG_PATH as string, "utf8");
  check("alert log mentions the intent id", alertLog.includes(FAKE_INTENT_ID_HEX));
  check(
    "alert log names the REAL cause (ARBITRUM_INTENT_MANAGER_ADDRESS), not just an opaque exit code",
    alertLog.includes("ARBITRUM_INTENT_MANAGER_ADDRESS is not set")
  );
  check("alert log records the retry count that was actually spent", alertLog.includes("3/3 attempts"));
  check("alert log still names the raw exit code too (exit 1)", alertLog.includes("last exit 1"));

  if (failures > 0) {
    console.error(`\n[gate-test] ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log(`\n[gate-test] all checks passed (${elapsedMs}ms elapsed)`);
}

main();
