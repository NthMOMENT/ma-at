// Gate test (Phase 5D-fix): weiToLamports' true-1:1 ETH:SOL mock-rate
// conversion. settle_intent.js guards all its side-effecting code (env var
// reads, hot wallet, Solana RPC) behind require.main === module, so this
// require() is side-effect-free — no env vars needed, no network, no
// filesystem access. Same "no test runner wired up yet" pattern as the
// other gate tests; run with:
//
//   node settle_intent.gate.test.js
const { weiToLamports } = require('./settle_intent.js');

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

if (failures > 0) {
  console.error(`\n[gate-test] ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log(`\n[gate-test] all checks passed`);
}
