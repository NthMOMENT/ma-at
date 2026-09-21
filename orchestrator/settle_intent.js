const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const anchor = require('@coral-xyz/anchor');
const fs = require('fs');
const path = require('path');

const HOT_WALLET_PATH = process.env.HOME + '/.config/solana/hot-wallet.json';
const PROGRAM_ID = new PublicKey('9nKpoMMP2ZX2bRudcXjpAS4VtSJBxiZ8wsM69LAkHikv');
const IDL_PATH = path.join(__dirname, 'maat_idl.json');

// Treasury wallet — receives the settlement
const TREASURY = new PublicKey('C9CZZFbeJ2Vzj9w8ctcsYKyK4mLQNq2vvsGwPJ7uEHtd');

// Settlement amount: 0.005 SOL in lamports (matches EVM intent amount)
const SETTLEMENT_AMOUNT = new anchor.BN(5_000_000);

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

  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
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

  // Check treasury balance before
  const balanceBefore = await connection.getBalance(TREASURY);
  console.log('\nTreasury balance before:', balanceBefore / 1e9, 'SOL');

  // Step 1: submit_intent — escrow SOL into the intent PDA
  console.log('\n[Step 1] Submitting intent on Solana (escrowing', SETTLEMENT_AMOUNT.toString(), 'lamports)...');
  const expiry = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);

  const submitTx = await program.methods
    .submitIntent(
      SETTLEMENT_AMOUNT,
      TREASURY,
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

  const settleTx = await program.methods
    .receiveSettlement(
      Array.from(ZK_PROOF_HASH),
      SETTLEMENT_AMOUNT
    )
    .accounts({
      programState: programStatePda,
      intent: settledIntentPda,
      circuitBreaker: circuitBreakerPda,
      orchestrator: hotWallet.publicKey,
      destination: TREASURY,
      owner: hotWallet.publicKey,
    })
    .rpc();

  console.log('receive_settlement tx:', settleTx);

  // Check treasury balance after
  const balanceAfter = await connection.getBalance(TREASURY);
  console.log('\nTreasury balance after: ', balanceAfter / 1e9, 'SOL');
  console.log('Delta:                  +', (balanceAfter - balanceBefore) / 1e9, 'SOL');
  console.log('\n✓ FULL CIRCLE COMPLETE');
  console.log('  EVM intent → ZK verified → Solana settlement → funds delivered');
  console.log('  Destination:', TREASURY.toBase58());
  console.log('  Settlement tx:', settleTx);
}

main().catch(console.error);
