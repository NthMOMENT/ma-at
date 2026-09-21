const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const anchor = require('@coral-xyz/anchor');
const fs = require('fs');
const path = require('path');

const HOT_WALLET_PATH = process.env.HOME + '/.config/solana/hot-wallet.json';
const PROGRAM_ID = new PublicKey('9nKpoMMP2ZX2bRudcXjpAS4VtSJBxiZ8wsM69LAkHikv');
const IDL_PATH = path.join(__dirname, 'maat_idl.json');

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
  console.log('program_state PDA:', programStatePda.toBase58());

  const info = await connection.getAccountInfo(programStatePda);
  if (info) {
    console.log('Already initialized. Skipping.');
    return;
  }

  console.log('Initializing program...');
  const tx = await program.methods
    .initialize(hotWallet.publicKey, hotWallet.publicKey)
    .accounts({
      programState: programStatePda,
      deployer: hotWallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();

  console.log('Initialize tx:', tx);
  console.log('Program initialized. Admin:', hotWallet.publicKey.toBase58());
  console.log('Orchestrator:', hotWallet.publicKey.toBase58());
}

main().catch(console.error);
