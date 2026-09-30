// Gate test (Phase 5D-fix): weiToLamports' true-1:1 ETH:SOL mock-rate
// conversion. settle_intent.js guards all its side-effecting code (env var
// reads, hot wallet, Solana RPC) behind require.main === module, so this
// require() is side-effect-free — no env vars needed, no network, no
// filesystem access. Same "no test runner wired up yet" pattern as the
// other gate tests; run with:
//
//   node settle_intent.gate.test.js
const { weiToLamports, normalizeProofHashHex, pollForConfirmation, withTimeout } = require('./settle_intent.js');

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    console.error(`  FAIL ${name}`);
    failures++;
  }
}

console.log('[gate-test] 1) 500000000000000 wei -> 500000 lamports (the exact case from the reported discrepancy)');
{
  const result = weiToLamports('500000000000000');
  check('result is a BigInt', typeof result === 'bigint');
  check('result === 500000n', result === 500000n);
}

console.log('[gate-test] 2) accepts a 0x-prefixed hex string (prove.rs\'s actual ProofOutputJson.amount encoding)');
{
  const hexWei = '0x' + (500000000000000n).toString(16);
  check('hex input also -> 500000n', weiToLamports(hexWei) === 500000n);
}

console.log('[gate-test] 3) true 1:1 ETH:SOL — 1 full ETH (1e18 wei) -> 1 full SOL (1e9 lamports)');
{
  check('1e18 wei -> 1e9 lamports', weiToLamports((10n ** 18n).toString()) === 10n ** 9n);
}

console.log('[gate-test] 4) accepts a BigInt directly (not just a string)');
{
  check('BigInt input -> 500000n', weiToLamports(500000000000000n) === 500000n);
}

console.log('[gate-test] 5) sub-lamport dust truncates toward zero (integer division), never rounds up');
{
  // 1 wei short of 1 lamport's worth — must truncate to 0, not round to 1.
  check('999999999 wei -> 0 lamports', weiToLamports('999999999') === 0n);
}

console.log('[gate-test] 6) normalizeProofHashHex: a valid 0x-prefixed 32-byte hash is parsed and lowercased');
{
  const hash = '0xFE2C841C8FF64727AA87EA2290FC07FBBC81449B94F0F32B505190B903CFBCD5';
  check('parsed to the lowercase, unprefixed 64-char form', normalizeProofHashHex(hash) === 'fe2c841c8ff64727aa87ea2290fc07fbbc81449b94f0f32b505190b903cfbcd5');
}

console.log('[gate-test] 7) normalizeProofHashHex: the same hash without an 0x prefix parses identically');
{
  const withPrefix = normalizeProofHashHex('0x' + 'ab'.repeat(32));
  const without = normalizeProofHashHex('ab'.repeat(32));
  check('both forms agree', withPrefix === without && withPrefix === 'ab'.repeat(32));
}

console.log('[gate-test] 8) normalizeProofHashHex: missing/invalid input rejected (returns null, never a guess)');
{
  check('undefined rejected', normalizeProofHashHex(undefined) === null);
  check('empty string rejected', normalizeProofHashHex('') === null);
  check('too short rejected', normalizeProofHashHex('0x' + 'ab'.repeat(31)) === null);
  check('too long rejected', normalizeProofHashHex('0x' + 'ab'.repeat(33)) === null);
  check('non-hex characters rejected', normalizeProofHashHex('zz'.repeat(32)) === null);
  // The exact retired-vkey literal this fix removes from settle_intent.js is
  // (was) syntactically valid 32-byte hex, same as any real proof hash — this
  // function has no way to know it's "the old wrong one" by shape alone, and
  // shouldn't try to. The actual fix is that it's no longer hardcoded
  // anywhere in this file at all (see the grep-clean assertion below) — a
  // caller would have to go out of its way to pass it in as PROOF_HASH_HEX.
  check(
    'the old literal parses fine as ordinary hex (this function can\'t and shouldn\'t special-case it — the fix is that nothing hardcodes it anymore)',
    normalizeProofHashHex('007500eb44bf57ff9ed9585585e438b3f57e4285c578b61df832eb9fd4fd32e3') === '007500eb44bf57ff9ed9585585e438b3f57e4285c578b61df832eb9fd4fd32e3'
  );
}

console.log('[gate-test] 8b) grep-clean: the retired vkey literal is no longer hardcoded anywhere in settle_intent.js');
{
  const fs = require('fs');
  const source = fs.readFileSync(__dirname + '/settle_intent.js', 'utf8');
  check('literal absent from source', !source.includes('007500eb44bf57ff9ed9585585e438b3f57e4285c578b61df832eb9fd4fd32e3'));
}

console.log('[gate-test] 9) runSettlement refuses to run without PROOF_HASH_HEX set (exit 1, clear message) — spawned end to end, no mocking');
{
  const { spawnSync } = require('child_process');
  const result = spawnSync('node', [__dirname + '/settle_intent.js'], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PROOF_AMOUNT_WEI: '500000000000000',
      // Deliberately no PROOF_HASH_HEX, no DESTINATION_CHAIN_ID override —
      // defaults to the Solana chain id, so it actually reaches the
      // PROOF_HASH_HEX check rather than short-circuiting on chain mismatch.
    },
    encoding: 'utf8',
  });
  check('exits non-zero', result.status !== 0);
  check('clear message naming PROOF_HASH_HEX', result.stderr.includes('PROOF_HASH_HEX'));
}

console.log('[gate-test] 10) runSettlement refuses to run with an invalid (wrong-length) PROOF_HASH_HEX too');
{
  const { spawnSync } = require('child_process');
  const result = spawnSync('node', [__dirname + '/settle_intent.js'], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PROOF_AMOUNT_WEI: '500000000000000',
      PROOF_HASH_HEX: '0xdeadbeef', // valid hex, wrong length
    },
    encoding: 'utf8',
  });
  check('exits non-zero', result.status !== 0);
  check('clear message naming PROOF_HASH_HEX', result.stderr.includes('PROOF_HASH_HEX'));
}

// Gate 5D-hang: pollForConfirmation replaces a bare confirmTransaction()
// await that had no timeout of its own (see settle_intent.js). `connection`
// is duck-typed (only getSignatureStatus/getBlockHeight are called), so it's
// mocked here directly — no real Solana RPC, no real delay: timeoutMs/
// pollIntervalMs are passed short so these run in well under a second
// instead of waiting the real 90s production ceiling.
async function runAsyncChecks() {
  console.log('[gate-test] 11) pollForConfirmation: resolves as soon as the signature shows confirmed');
  {
    let calls = 0;
    const fakeConnection = {
      async getSignatureStatus() {
        calls++;
        return { value: { err: null, confirmationStatus: 'confirmed' } };
      },
      async getBlockHeight() {
        throw new Error('should not be reached once confirmed');
      },
    };
    let threw = false;
    try {
      await pollForConfirmation(fakeConnection, 'fakeSig123', 1000, { pollIntervalMs: 10, timeoutMs: 200 });
    } catch {
      threw = true;
    }
    check('resolves without throwing', !threw);
    check('checked the signature at least once', calls >= 1);
  }

  console.log('[gate-test] 12) pollForConfirmation: an on-chain error in value.err throws immediately, no polling loop');
  {
    let calls = 0;
    const fakeConnection = {
      async getSignatureStatus() {
        calls++;
        return { value: { err: { InstructionError: [0, 'Custom'] } } };
      },
      async getBlockHeight() {
        throw new Error('should not be reached — err should throw before any height check');
      },
    };
    let error = null;
    try {
      await pollForConfirmation(fakeConnection, 'fakeSigErr', 1000, { pollIntervalMs: 10, timeoutMs: 200 });
    } catch (err) {
      error = err;
    }
    check('threw an error', error !== null);
    check('threw on the first check (no retrying a failed tx)', calls === 1);
    check('error message names the signature', error !== null && error.message.includes('fakeSigErr'));
  }

  console.log('[gate-test] 13) pollForConfirmation: never confirms -> times out at the configured ceiling and throws (short ceiling, not the real 90s)');
  {
    let calls = 0;
    const start = Date.now();
    const fakeConnection = {
      async getSignatureStatus() {
        calls++;
        return { value: { err: null, confirmationStatus: 'processed' } }; // never confirmed/finalized
      },
      async getBlockHeight() {
        return 1; // well under lastValidBlockHeight — never triggers the blockhash-expiry path
      },
    };
    let error = null;
    try {
      await pollForConfirmation(fakeConnection, 'fakeSigHang', 1_000_000, { pollIntervalMs: 20, timeoutMs: 100 });
    } catch (err) {
      error = err;
    }
    const elapsed = Date.now() - start;
    check('threw a timeout error', error !== null && /timed out/.test(error.message));
    check('polled more than once before giving up', calls > 1);
    check('gave up at roughly the configured ceiling, not instantly and not 90s', elapsed >= 90 && elapsed < 5000);
  }

  // Gate 5D-hang-3: getSignatureStatus mocked to hang forever (a promise that
  // never resolves, simulating a stalled network call) — pollForConfirmation
  // must still throw within its rpcTimeoutMs bound instead of hanging for
  // the full 90s ceiling (or forever).
  console.log('[gate-test] 14) pollForConfirmation: a getSignatureStatus call that never resolves throws within rpcTimeoutMs, doesn\'t hang');
  {
    let calls = 0;
    const fakeConnection = {
      async getSignatureStatus() {
        calls++;
        return new Promise(() => {}); // never resolves — simulates a stalled RPC call
      },
      async getBlockHeight() {
        throw new Error('should not be reached — the stalled getSignatureStatus call should throw first');
      },
    };
    const start = Date.now();
    let error = null;
    try {
      await pollForConfirmation(fakeConnection, 'fakeSigStall', 1000, {
        pollIntervalMs: 10,
        timeoutMs: 5_000, // outer ceiling well above rpcTimeoutMs, so a pass here proves the per-call timeout fired, not the outer one
        rpcTimeoutMs: 50,
      });
    } catch (err) {
      error = err;
    }
    const elapsed = Date.now() - start;
    check('threw an error', error !== null);
    check('error names the stalled call', error !== null && /getSignatureStatus/.test(error.message));
    check('threw on the first call (no retry inside pollForConfirmation itself)', calls === 1);
    check('threw at roughly rpcTimeoutMs, not the 5s outer ceiling', elapsed >= 50 && elapsed < 4000);
  }

  console.log('[gate-test] 15) withTimeout: resolves normally when the wrapped promise settles first');
  {
    const result = await withTimeout(Promise.resolve('ok'), 1000, 'quick call');
    check('result passed through', result === 'ok');
  }

  console.log('[gate-test] 16) withTimeout: rejects with a labeled error when the wrapped promise never settles');
  {
    let error = null;
    try {
      await withTimeout(new Promise(() => {}), 30, 'stalled call');
    } catch (err) {
      error = err;
    }
    check('threw', error !== null);
    check('error message includes the label and timeout', error !== null && /stalled call timed out after 30ms/.test(error.message));
  }

  // Gate p3-hang: the live incident. The child finished its work but never
  // exited, because waitForGo() left stdin flowing and the parent kept its
  // end of the pipe open. These spawn a real child that uses the real
  // waitForGo/runAsScript, with the parent writing GO via write(), NOT end(),
  // exactly as listener.ts did, so the pipe stays open throughout.
  const { spawn } = require('child_process');
  function runChild(body, { killAfterMs }) {
    return new Promise((resolve) => {
      const start = Date.now();
      const src = `const { waitForGo, runAsScript } = require(${JSON.stringify(__dirname + '/settle_intent.js')});\n${body}`;
      const child = spawn('node', ['-e', src], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let killed = false;
      child.stdout.on('data', (d) => {
        out += d.toString();
        if (d.toString().includes('SETTLING_SIG:')) child.stdin.write('GO\n');
      });
      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, killAfterMs);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, killed, elapsed: Date.now() - start, out });
      });
    });
  }

  console.log('[gate-test] 17) control: the OLD shape (no explicit exit) never exits while the parent holds stdin open — reproduces the incident');
  {
    const r = await runChild(
      `(async () => { console.log('SETTLING_SIG:x'); await waitForGo(); console.log('DONE'); })();`,
      { killAfterMs: 1500 }
    );
    check('child reached the end of its work', r.out.includes('DONE'));
    check('child did NOT exit on its own (had to be killed)', r.killed);
  }

  console.log('[gate-test] 18) runAsScript: success exits 0 promptly even though the parent never closes stdin');
  {
    const r = await runChild(
      `runAsScript(async () => { console.log('SETTLING_SIG:x'); await waitForGo(); console.log('DONE'); });`,
      { killAfterMs: 5000 }
    );
    check('child reached the end of its work', r.out.includes('DONE'));
    check('exited on its own (not killed)', !r.killed);
    check('exit code 0', r.code === 0);
    check('exited well before the 5s kill ceiling', r.elapsed < 4000);
  }

  console.log('[gate-test] 19) runAsScript: a failure after GO still exits 1 (listener.ts\'s code !== 0 path)');
  {
    const r = await runChild(
      `runAsScript(async () => { console.log('SETTLING_SIG:x'); await waitForGo(); throw new Error('boom'); });`,
      { killAfterMs: 5000 }
    );
    check('exited on its own (not killed)', !r.killed);
    check('exit code 1', r.code === 1);
  }
}

runAsyncChecks().then(() => {
  if (failures > 0) {
    console.error(`\n[gate-test] ${failures} check(s) FAILED`);
    process.exit(1);
  } else {
    console.log(`\n[gate-test] all checks passed`);
  }
});
