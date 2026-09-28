// Gate test (Week 3 design, Phase 1, operator-visibility round): proves the
// three new boot-time log lines in arbitrum_settlement.ts — the "loaded N
// solver key(s)" summary, the orphaned-numbered-var WARNING, and the
// legacy-vs-_1 NOTE — actually appear in the REAL boot path, with the right
// content, and that no private key value ever reaches stdout/stderr in any
// of the three scenarios. Same spawn-the-compiled-dist approach as
// dotenv_order.gate.test.js (not importing TS source, not pre-setting
// process.env — a fresh child process whose cwd holds a throwaway .env).
//
// Requires `npm run build` first (dist/listener.js must exist and be
// current). Run with:
//
//   npm run build && node src/solver_key_boot.gate.test.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { privateKeyToAccount } = require('viem/accounts');

const DIST_ENTRY = path.resolve(__dirname, '../dist/listener.js');

if (!fs.existsSync(DIST_ENTRY)) {
  console.error(`[gate-test] refusing to run — ${DIST_ENTRY} doesn't exist. Run \`npm run build\` first.`);
  process.exit(1);
}

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    console.error(`  FAIL ${name}`);
    failures++;
  }
}

// Fake-but-syntactically-valid, obviously-synthetic values (repeated single
// hex digits, same convention as the other gate tests' fixtures) — never
// real secrets.
const KEY_1 = '0x1111111111111111111111111111111111111111111111111111111111111111';
const KEY_2 = '0x3333333333333333333333333333333333333333333333333333333333333333';
const KEY_3 = '0x4444444444444444444444444444444444444444444444444444444444444444';
const ORCH_KEY = '0x2222222222222222222222222222222222222222222222222222222222222222';
const ADDR_1 = privateKeyToAccount(KEY_1).address;
const ADDR_2 = privateKeyToAccount(KEY_2).address;
const ADDR_3 = privateKeyToAccount(KEY_3).address;

function baseEnvLines(extra) {
  return [
    'ALCHEMY_RPC_URL_1=https://arb-sepolia.g.alchemy.com/v2/faketestkey123456789',
    'ARBITRUM_INTENT_MANAGER_ADDRESS=0xa3d4B948593334E55F0caC52DE406381e7052eAa',
    `ARBITRUM_ORCHESTRATOR_PRIVATE_KEY=${ORCH_KEY}`,
    `MAAT_STATE_DIR=${path.join(os.tmpdir(), 'maat-solver-key-boot-test-state')}`,
    `SETTLED_LEDGER_PATH=${path.join(os.tmpdir(), 'maat-solver-key-boot-test-ledger.json')}`,
    `ALERT_LOG_PATH=${path.join(os.tmpdir(), 'maat-solver-key-boot-test-alerts.log')}`,
    `ARBITRUM_LEDGER_PATH=${path.join(os.tmpdir(), 'maat-solver-key-boot-test-arbledger.json')}`,
    ...extra,
  ].join('\n') + '\n';
}

async function runScenario(envLines) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maat-solver-key-boot-'));
  fs.writeFileSync(path.join(tmpDir, '.env'), envLines);

  const child = spawn('node', [DIST_ENTRY], {
    cwd: tmpDir,
    env: { PATH: process.env.PATH }, // deliberately minimal — everything must come from .env
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const closed = new Promise((resolve) => child.on('close', resolve));

  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5000))]);
  child.kill('SIGKILL');
  await closed;

  fs.rmSync(tmpDir, { recursive: true, force: true });
  return { stdout, stderr };
}

function checkNoKeyValueLeaked(output, label) {
  for (const [name, key] of [['KEY_1', KEY_1], ['KEY_2', KEY_2], ['KEY_3', KEY_3], ['ORCH_KEY', ORCH_KEY]]) {
    check(`${label}: ${name}'s raw value never appears in stdout`, !output.stdout.includes(key));
    check(`${label}: ${name}'s raw value never appears in stderr`, !output.stderr.includes(key));
  }
}

async function main() {
  console.log('[gate-test] 1) two clean numbered keys (_1, _2) -> "loaded 2 solver key(s)" line with both correct addresses, no WARNING/NOTE, no key value leaked');
  {
    const out = await runScenario(baseEnvLines([
      `ARBITRUM_SOLVER_PRIVATE_KEY_1=${KEY_1}`,
      `ARBITRUM_SOLVER_PRIVATE_KEY_2=${KEY_2}`,
    ]));
    check('the summary line appears', out.stdout.includes('[ARB-SETTLE] loaded 2 solver key(s):'));
    check('names both addresses, in order, comma-separated', out.stdout.includes(`[ARB-SETTLE] loaded 2 solver key(s): ${ADDR_1}, ${ADDR_2}`));
    check('no orphan WARNING (nothing orphaned here)', !out.stdout.includes('WARNING') && !out.stderr.includes('WARNING'));
    check('no legacy NOTE (no legacy var set)', !out.stdout.includes('[ARB-SETTLE] NOTE'));
    checkNoKeyValueLeaked(out, 'scenario 1');
  }

  console.log('[gate-test] 2) numbering gap (_1 set, _2 missing, _3 set) -> WARNING naming _3 and _2, NOT fatal, only _1 counted as loaded, no key value leaked');
  {
    const out = await runScenario(baseEnvLines([
      `ARBITRUM_SOLVER_PRIVATE_KEY_1=${KEY_1}`,
      `ARBITRUM_SOLVER_PRIVATE_KEY_3=${KEY_3}`,
    ]));
    check(
      'WARNING line matches the exact requested phrasing (console.warn -> stderr)',
      out.stderr.includes('[ARB-SETTLE] WARNING: ARBITRUM_SOLVER_PRIVATE_KEY_3 is set but _2 is missing - ignoring it')
    );
    check('only 1 key counted as loaded (the orphan was NOT loaded)', out.stdout.includes('[ARB-SETTLE] loaded 1 solver key(s):'));
    check('the loaded key is _1\'s address, not _3\'s', out.stdout.includes(`[ARB-SETTLE] loaded 1 solver key(s): ${ADDR_1}`) && !out.stdout.includes(ADDR_3));
    check('not fatal — no "[FATAL]" from the key-loading path', !out.stderr.includes('[FATAL] ARBITRUM_SOLVER_PRIVATE_KEY') && !out.stderr.includes('[FATAL] duplicate solver address'));
    check('process still reached past key loading (orchestrator address line present)', out.stdout.includes('[ARB-SETTLE] orchestrator address:'));
    checkNoKeyValueLeaked(out, 'scenario 2');
  }

  console.log('[gate-test] 3) legacy var AND _1 both set -> NOTE naming both vars, _1 wins (2-key loading unaffected by legacy), no key value leaked');
  {
    const out = await runScenario(baseEnvLines([
      `ARBITRUM_SOLVER_PRIVATE_KEY=${KEY_2}`, // legacy — must be ignored
      `ARBITRUM_SOLVER_PRIVATE_KEY_1=${KEY_1}`,
    ]));
    check(
      'NOTE line matches the exact requested content',
      out.stdout.includes(
        '[ARB-SETTLE] NOTE: ARBITRUM_SOLVER_PRIVATE_KEY (legacy) is also set but is ignored because ARBITRUM_SOLVER_PRIVATE_KEY_1 is present'
      )
    );
    check('only 1 key loaded (numbered path, not legacy)', out.stdout.includes('[ARB-SETTLE] loaded 1 solver key(s):'));
    check('the loaded key is _1\'s address (legacy\'s KEY_2 address never used)', out.stdout.includes(`[ARB-SETTLE] loaded 1 solver key(s): ${ADDR_1}`) && !out.stdout.includes(ADDR_2));
    check('not fatal', !out.stderr.includes('[FATAL] ARBITRUM_SOLVER_PRIVATE_KEY') && !out.stderr.includes('[FATAL] duplicate solver address'));
    checkNoKeyValueLeaked(out, 'scenario 3');
  }

  if (failures > 0) {
    console.error(`\n[gate-test] ${failures} check(s) FAILED`);
    process.exit(1);
  } else {
    console.log('\n[gate-test] all checks passed');
  }
}

main().catch((err) => {
  console.error('[gate-test] unexpected error:', err);
  process.exit(1);
});
