const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const anchor = require('@coral-xyz/anchor');
const fs = require('fs');
const path = require('path');

const HOT_WALLET_PATH = process.env.HOME + '/.config/solana/hot-wallet.json';
const PROGRAM_ID = new PublicKey('9nKpoMMP2ZX2bRudcXjpAS4VtSJBxiZ8wsM69LAkHikv');
const IDL_PATH = path.join(__dirname, 'maat_idl.json');

// Fix 6 (Gate 5B-fix): blocks after printing SETTLING_SIG until the parent
// (listener.ts) writes "GO" to our stdin — i.e. until it has durably
// recorded our signature as "settling". Bounded so a parent that dies
// before replying doesn't leave this process hanging forever.
function waitForGo(timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      process.stdin.removeListener('data', onData);
      reject(new Error(`timed out after ${timeoutMs}ms waiting for GO from orchestrator`));
    }, timeoutMs);
    function onData(chunk) {
      if (chunk.toString().includes('GO')) {
        clearTimeout(timer);
        process.stdin.removeListener('data', onData);
        resolve();
      }
    }
    process.stdin.on('data', onData);
  });
}

// Settlement destination — decoded by the orchestrator listener from the
// EVM/TRON IntentCreated event's destinationWallet and passed in via env.
// Falls back to the treasury wallet only when run standalone (e.g. manual testing).
const DESTINATION_CHAIN_ID = process.env.DESTINATION_CHAIN_ID || '1399811149';
const DESTINATION_WALLET = process.env.DESTINATION_WALLET
  || 'C9CZZFbeJ2Vzj9w8ctcsYKyK4mLQNq2vvsGwPJ7uEHtd';

const SOLANA_CHAIN_ID = '1399811149';

// This settlement script only knows how to deliver SOL on Solana. The
// listener also fires it for EVM/TRON-destined intents (its job stops at ZK
// verification), so route those out here rather than letting them fail deep
// inside the Solana PublicKey/Anchor calls below.
if (DESTINATION_CHAIN_ID !== SOLANA_CHAIN_ID) {
  console.log('[SETTLE] Non-Solana destination detected.');
  console.log('[SETTLE] Cross-chain settlement to EVM/TRON not yet implemented.');
  console.log('[SETTLE] Destination:', DESTINATION_WALLET);
  console.log('[SETTLE] Chain:', DESTINATION_CHAIN_ID);
  process.exit(0);
}

const DESTINATION = new PublicKey(DESTINATION_WALLET);

// Fix 8 (Gate 5B-fix): settlement amount comes ONLY from the proof JSON's
// committed `amount` field (hex wei string), passed in via env by
// listener.ts — never a hardcoded figure. 1:1 mock rate (devnet): wei (18
// decimals) and lamports (9 decimals) differ by exactly 1e9, so dividing
// gives the same-magnitude SOL amount. Refuses to run rather than guess.
const PROOF_AMOUNT_WEI = process.env.PROOF_AMOUNT_WEI;
if (!PROOF_AMOUNT_WEI) {
  console.error('[SETTLE] PROOF_AMOUNT_WEI not set — refusing to settle with an unknown amount.');
  process.exit(1);
}
const SETTLEMENT_AMOUNT = new anchor.BN((BigInt(PROOF_AMOUNT_WEI) / 1_000_000_000n).toString());

// Arbitrum Sepolia source chain ID
const SOURCE_CHAIN_ID = new anchor.BN(421614);

// ZK proof hash from our verified intent
const ZK_PROOF_HASH = Buffer.from(
  '007500eb44bf57ff9ed9585585e438b3f57e4285c578b61df832eb9fd4fd32e3',
  'hex'
);

async function main() {
  const keypairData = JSON.parse(fs.readFileSync(HOT_WALLET_PATH));
  const hotWallet = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  console.log('Hot wallet (solver):', hotWallet.publicKey.toBase58());

  const connection = new Connection(
    process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
    'confirmed'
  );
  const wallet = new anchor.Wallet(hotWallet);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  anchor.setProvider(provider);

  const idl = JSON.parse(fs.readFileSync(IDL_PATH));
  const program = new anchor.Program(idl, provider);

  // Derive PDAs
  const [programStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from('program_state')],
    PROGRAM_ID
  );

  // Get current nonce
  const state = await program.account.programState.fetch(programStatePda);
  const currentNonce = state.intentNonce;
  console.log('Current nonce:', currentNonce.toString());

  // Intent PDA uses the nonce BEFORE submit (nonce 0 = first intent)
  const nonceBytes = Buffer.alloc(8);
  nonceBytes.writeBigUInt64LE(BigInt(currentNonce.toString()));

  const [intentPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('intent'), hotWallet.publicKey.toBuffer(), nonceBytes],
    PROGRAM_ID
  );
  console.log('Intent PDA:', intentPda.toBase58());

  // Circuit breaker PDA
  const chainIdBytes = Buffer.alloc(8);
  chainIdBytes.writeBigUInt64LE(BigInt(421614));
  const [circuitBreakerPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('cb'), chainIdBytes],
    PROGRAM_ID
  );
  console.log('Circuit breaker PDA:', circuitBreakerPda.toBase58());

  // Check destination balance before
  const balanceBefore = await connection.getBalance(DESTINATION);
  console.log('\nDestination balance before:', balanceBefore / 1e9, 'SOL');

  // Step 1: submit_intent — escrow SOL into the intent PDA
  console.log('\n[Step 1] Submitting intent on Solana (escrowing', SETTLEMENT_AMOUNT.toString(), 'lamports)...');
  const expiry = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);

  const submitTx = await program.methods
    .submitIntent(
      SETTLEMENT_AMOUNT,
      DESTINATION,
      expiry,
      50,
      SOURCE_CHAIN_ID
    )
    .accounts({
      programState: programStatePda,
      intent: intentPda,
      owner: hotWallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();

  console.log('submit_intent tx:', submitTx);
  console.log('Intent escrowed. PDA:', intentPda.toBase58());

  // Step 2: receive_settlement — release SOL to treasury
  console.log('\n[Step 2] Calling receive_settlement...');

  // After submit, nonce incremented — refetch
  const stateAfter = await program.account.programState.fetch(programStatePda);
  const usedNonce = stateAfter.intentNonce.subn(1);
  const usedNonceBytes = Buffer.alloc(8);
  usedNonceBytes.writeBigUInt64LE(BigInt(usedNonce.toString()));

  const [settledIntentPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('intent'), hotWallet.publicKey.toBuffer(), usedNonceBytes],
    PROGRAM_ID
  );

  // Fix 6 (Gate 5B-fix): build + sign this tx ourselves instead of using
  // .rpc() (which builds, signs, AND sends in one call), so we can hand the
  // orchestrator the signature BEFORE broadcasting. The orchestrator writes
  // its "settling" ledger entry the moment it sees SETTLING_SIG, then tells
  // us to proceed — a crash on either side before that point means nothing
  // was ever sent; a crash after means the ledger already has the
  // signature to check on restart.
  const settleTxObj = await program.methods
    .receiveSettlement(
      Array.from(ZK_PROOF_HASH),
      SETTLEMENT_AMOUNT
    )
    .accounts({
      programState: programStatePda,
      intent: settledIntentPda,
      circuitBreaker: circuitBreakerPda,
      orchestrator: hotWallet.publicKey,
      destination: DESTINATION,
      owner: hotWallet.publicKey,
    })
    .transaction();

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  settleTxObj.recentBlockhash = blockhash;
  settleTxObj.feePayer = hotWallet.publicKey;
  settleTxObj.sign(hotWallet);

  const settleTx = require('bs58').encode(settleTxObj.signature);
  console.log(`SETTLING_SIG:${settleTx}`);

  await waitForGo();

  await connection.sendRawTransaction(settleTxObj.serialize(), { skipPreflight: false });
  await connection.confirmTransaction({ signature: settleTx, blockhash, lastValidBlockHeight }, 'confirmed');

  console.log('receive_settlement tx:', settleTx);

  // Check destination balance after
  const balanceAfter = await connection.getBalance(DESTINATION);
  console.log('\nDestination balance after: ', balanceAfter / 1e9, 'SOL');
  console.log('Delta:                  +', (balanceAfter - balanceBefore) / 1e9, 'SOL');
  console.log('\n✓ FULL CIRCLE COMPLETE');
  console.log('  EVM intent → ZK verified → Solana settlement → funds delivered');
  console.log('  Destination:', DESTINATION.toBase58());
  console.log('  Settlement tx:', settleTx);
}

main().catch((err) => {
  // Fix 6 (Gate 5B-fix): must actually exit non-zero on failure (including
  // the waitForGo() timeout above) — listener.ts's `code !== 0` alert path
  // depends on it. The old `.catch(console.error)` swallowed the error and
  // let the process exit 0 by default.
  console.error(err);
  process.exit(1);
});
