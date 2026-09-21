const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const anchor = require('@coral-xyz/anchor');
const fs = require('fs');
const path = require('path');

const HOT_WALLET_PATH = process.env.HOME + '/.config/solana/hot-wallet.json';
const PROGRAM_ID = new PublicKey('9nKpoMMP2ZX2bRudcXjpAS4VtSJBxiZ8wsM69LAkHikv');
const IDL_PATH = path.join(__dirname, 'maat_idl.json');

// Arbitrum Sepolia chain ID as used in our intents
// From fire_intent.sh: destinationChainId = 1399811149 (Solana)
// The source_chain_id in the Solana intent = Arbitrum Sepolia = 421614
const ARBITRUM_SEPOLIA_CHAIN_ID = new anchor.BN(421614);

async function main() {
  const keypairData = JSON.parse(fs.readFileSync(HOT_WALLET_PATH));
  const hotWallet = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  console.log('Hot wallet:', hotWallet.publicKey.toBase58());

  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
  const wallet = new anchor.Wallet(hotWallet);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  anchor.setProvider(provider);

  const idl = JSON.parse(fs.readFileSync(IDL_PATH));
  const program = new anchor.Program(idl, provider);

  const [programStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from('program_state')],
    PROGRAM_ID
  );

  const chainIdBytes = Buffer.alloc(8);
  chainIdBytes.writeBigUInt64LE(BigInt(421614));

  const [circuitBreakerPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('cb'), chainIdBytes],
    PROGRAM_ID
  );
  console.log('Circuit breaker PDA:', circuitBreakerPda.toBase58());

  console.log('Setting circuit breaker for Arbitrum Sepolia (421614)...');
  const tx = await program.methods
    .setCircuitBreaker(ARBITRUM_SEPOLIA_CHAIN_ID, false)
    .accounts({
      programState: programStatePda,
      circuitBreaker: circuitBreakerPda,
      admin: hotWallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();

  console.log('Circuit breaker tx:', tx);
  console.log('Channel 421614 (Arbitrum Sepolia) — halted: false');
}

main().catch(console.error);
