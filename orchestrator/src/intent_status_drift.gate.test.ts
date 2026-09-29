// Gate test (Week 3 design, Phase 2 — purity follow-up): proves
// intent_status.ts's INTENT_STATUS_* constants exactly equal
// arbitrum_settlement.ts's own (unedited) constants. Deliberately kept OUT
// of solver_stats.gate.test.ts: this is the only place in the whole Phase 2
// test surface that needs a real arbitrum_settlement.ts (private keys, an
// RPC URL) — isolating it here is what lets solver_stats.gate.test.ts run
// with zero required env vars and prove solver_stats.ts's own purity (see
// that file's test 23).
//
// Same "no test runner wired up yet" pattern as the other *.gate.test.ts
// files. process.env is read by arbitrum_settlement.ts at IMPORT time (a
// module-level `require`), and a static `import` is hoisted above any other
// top-level code in this file regardless of source order (the same class of
// ordering hazard the codebase's own dotenv-order fix addresses) — so these
// vars cannot be set from inside this file; they must come from the caller,
// exactly like arbitrum_settlement.gate.test.ts's own required vars. Every
// path below is still generated fresh per run via mktemp/mktemp -d — never a
// fixed /tmp path. Run with:
//
//   MAAT_STATE_DIR=$(mktemp -d) \
//   SETTLED_LEDGER_PATH=$(mktemp -u) \
//   ALERT_LOG_PATH=$(mktemp -u) \
//   ARBITRUM_LEDGER_PATH=$(mktemp -u) \
//   ZK_DIR_PATH=$(mktemp -d) \
//   ALCHEMY_RPC_URL_1=https://example-placeholder.invalid/v2/test \
//   ARBITRUM_SOLVER_PRIVATE_KEY=0x1111111111111111111111111111111111111111111111111111111111111111 \
//   ARBITRUM_ORCHESTRATOR_PRIVATE_KEY=0x2222222222222222222222222222222222222222222222222222222222222222 \
//   npx ts-node src/intent_status_drift.gate.test.ts
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

// Imported after the env checks above — arbitrum_settlement.ts reads its
// config once, at load time.
import { INTENT_STATUS_PENDING, INTENT_STATUS_SETTLED, INTENT_STATUS_EXPIRED, INTENT_STATUS_SLASHED, INTENT_STATUS_REFUNDED } from "./intent_status";
import {
  INTENT_STATUS_PENDING as ARB_PENDING,
  INTENT_STATUS_SETTLED as ARB_SETTLED,
  INTENT_STATUS_EXPIRED as ARB_EXPIRED,
  INTENT_STATUS_SLASHED as ARB_SLASHED,
  INTENT_STATUS_REFUNDED as ARB_REFUNDED,
} from "./arbitrum_settlement";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    console.error(`  FAIL ${name}`);
    failures++;
  }
}

console.log("[gate-test] 1) drift guard: intent_status.ts's INTENT_STATUS_* constants exactly equal arbitrum_settlement.ts's own (unedited) constants");
check("PENDING matches", INTENT_STATUS_PENDING === ARB_PENDING);
check("SETTLED matches", INTENT_STATUS_SETTLED === ARB_SETTLED);
check("EXPIRED matches", INTENT_STATUS_EXPIRED === ARB_EXPIRED);
check("SLASHED matches", INTENT_STATUS_SLASHED === ARB_SLASHED);
check("REFUNDED matches", INTENT_STATUS_REFUNDED === ARB_REFUNDED);

if (failures > 0) {
  console.error(`\n[gate-test] ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log(`\n[gate-test] all checks passed`);
}
