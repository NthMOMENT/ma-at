// Gate test (Phase 5D-fix): weiToLamports' true-1:1 ETH:SOL mock-rate
// conversion. settle_intent.js guards all its side-effecting code (env var
// reads, hot wallet, Solana RPC) behind require.main === module, so this
// require() is side-effect-free — no env vars needed, no network, no
// filesystem access. Same "no test runner wired up yet" pattern as the
// other gate tests; run with:
//
//   node settle_intent.gate.test.js
const { weiToLamports, normalizeProofHashHex } = require('./settle_intent.js');

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

if (failures > 0) {
  console.error(`\n[gate-test] ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log(`\n[gate-test] all checks passed`);
}
