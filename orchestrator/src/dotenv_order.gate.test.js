// Gate test (Phase 5D-fix, items 1 and 2): proves both fixes hold in the
// REAL boot path by actually spawning the COMPILED dist entry (`node
// dist/listener.js`) — not importing TS source, not pre-setting
// process.env — in a fresh child process whose cwd holds a throwaway .env
// file, exactly how PM2 runs it in production.
//
// Item 1: before the fix, prover_pipeline.ts/intent_state.ts/
// arbitrum_settlement.ts's module-level `process.env.X` reads (require()'d
// before dotenv.config() ever ran) saw an empty environment regardless of
// what .env actually contained — surfacing as a FATAL
// "ARBITRUM_SOLVER_PRIVATE_KEY must be set" despite it being right there in
// .env.
//
// Item 2: the fake ALCHEMY_RPC_URL_1 below is deliberately unauthenticated,
// so main()'s real connection attempt against it fails with a viem error
// whose message embeds the URL (API key and all) — proving logError()'s
// redactError() wrapping actually reaches this real console.error call, not
// just the isolated redactError() unit tests in redact_gate.test.ts.
//
// This test fails loudly if either regresses.
//
// Requires `npm run build` first (dist/listener.js must exist and be
// current). Run with:
//
//   npm run build && node src/dotenv_order.gate.test.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

// Fake-but-syntactically-valid values for every var the module-load path
// reads before any real network call — real enough to get PAST every
// fail-fast check (proving dotenv ran first for ALL of them, not just the
// one that happened to crash loudly), never real secrets.
const FAKE_ENV_FILE = [
  'ALCHEMY_RPC_URL_1=https://arb-sepolia.g.alchemy.com/v2/faketestkey123456789',
  'ARBITRUM_INTENT_MANAGER_ADDRESS=0xa3d4B948593334E55F0caC52DE406381e7052eAa',
  'ARBITRUM_SOLVER_PRIVATE_KEY=0x1111111111111111111111111111111111111111111111111111111111111111',
  'ARBITRUM_ORCHESTRATOR_PRIVATE_KEY=0x2222222222222222222222222222222222222222222222222222222222222222',
  // Keeps this run from touching real state/logs even though we don't
  // expect it to get that far before we kill it.
  `MAAT_STATE_DIR=${path.join(os.tmpdir(), 'maat-dotenv-order-test-state')}`,
  `SETTLED_LEDGER_PATH=${path.join(os.tmpdir(), 'maat-dotenv-order-test-ledger.json')}`,
  `ALERT_LOG_PATH=${path.join(os.tmpdir(), 'maat-dotenv-order-test-alerts.log')}`,
  `ARBITRUM_LEDGER_PATH=${path.join(os.tmpdir(), 'maat-dotenv-order-test-arbledger.json')}`,
].join('\n') + '\n';

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maat-dotenv-order-'));
  fs.writeFileSync(path.join(tmpDir, '.env'), FAKE_ENV_FILE);

  console.log(`[gate-test] spawning node ${DIST_ENTRY} with cwd=${tmpDir} (its .env, nothing pre-set in process.env)...`);

  const child = spawn('node', [DIST_ENTRY], {
    cwd: tmpDir,
    // Deliberately minimal — no pre-set process.env for anything this
    // process reads. PATH is required for node's own module resolution
    // machinery on some platforms; everything else must come from .env.
    env: { PATH: process.env.PATH },
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  // Attached immediately, before any wait — 'close' fires only once, and in
  // practice this child exits on its own in under a second (it FATALs on
  // the fake RPC URL once past the env checks), well before a listener
  // attached only after a delay-then-kill would ever see it.
  const closed = new Promise((resolve) => child.on('close', resolve));

  // 5s is plenty to observe every module-load-time env check (private keys,
  // ALCHEMY_RPC_URLS, ARBITRUM_INTENT_MANAGER_ADDRESS) resolve; race it
  // against the child's own exit so this test isn't slower than it needs to be.
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5000))]);
  child.kill('SIGKILL');
  await closed;

  fs.rmSync(tmpDir, { recursive: true, force: true });

  check(
    'no FATAL "must be set" crash for any module-load-time env var',
    !stderr.includes('must be set') && !stdout.includes('must be set')
  );
  check(
    'arbitrum_settlement.ts read the private keys successfully from .env (solver address logged)',
    stdout.includes('[ARB-SETTLE] solver address:')
  );
  check(
    'arbitrum_settlement.ts read the private keys successfully from .env (orchestrator address logged)',
    stdout.includes('[ARB-SETTLE] orchestrator address:')
  );
  check(
    'got past listener.ts\'s own ALCHEMY_RPC_URLS / ARBITRUM_INTENT_MANAGER_ADDRESS checks too',
    !stderr.includes('[FATAL] at least one of ALCHEMY_RPC_URL_1/2/3') && !stderr.includes('[FATAL] ARBITRUM_INTENT_MANAGER_ADDRESS')
  );

  // Gate 5D-fix item 2: the fake ALCHEMY_RPC_URL_1 above is unauthenticated,
  // so connecting to it for real (arbClient.getBlockNumber() in main()) is
  // expected to fail — and that failure's message embeds the URL, API key
  // and all, exactly like a real Alchemy 401 would. Proves logError()'s
  // redactError() wrapping is actually wired into the real boot path, not
  // just unit-tested in isolation (see redact_gate.test.ts's own
  // redactError coverage for the isolated version).
  check(
    'the RPC connection failure this fake URL causes actually happened (proves the next two checks exercised something real)',
    stderr.includes('[FATAL] Cannot connect to Arbitrum Sepolia RPC')
  );
  check(
    'raw Alchemy URL/API key never appears in stdout or stderr',
    !stdout.includes('faketestkey123456789') && !stderr.includes('faketestkey123456789')
  );
  check(
    'the redaction placeholder appears in its place',
    stderr.includes('[redacted-url]')
  );

  if (failures > 0) {
    console.error(`\n[gate-test] ${failures} check(s) FAILED`);
    console.error('--- captured stdout ---');
    console.error(stdout);
    console.error('--- captured stderr ---');
    console.error(stderr);
    process.exit(1);
  } else {
    console.log('\n[gate-test] all checks passed');
  }
}

main().catch((err) => {
  console.error('[gate-test] unexpected error:', err);
  process.exit(1);
});
