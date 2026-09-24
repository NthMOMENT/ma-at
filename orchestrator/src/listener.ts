import { createPublicClient, http, fallback, parseAbiItem, type Log, type Chain } from "viem";
import { arbitrumSepolia } from "viem/chains";
import * as dotenv from "dotenv";
import { spawn } from "child_process";
import * as path from "path";
import { createHash } from "crypto";
import { PublicKey } from "@solana/web3.js";

dotenv.config();

// ─── Config ──────────────────────────────────────────────────────────────────

// Each chain has its own IntentManager deployment — never share one address
// across chains here, since the two are deployed independently.
const ARBITRUM_INTENT_MANAGER_ADDRESS = (process.env.ARBITRUM_INTENT_MANAGER_ADDRESS ??
  "0x9D1bd7119E9FefF6Baa3968272811323B354B16f") as `0x${string}`;
const ROBINHOOD_INTENT_MANAGER_ADDRESS = (process.env.ROBINHOOD_INTENT_MANAGER_ADDRESS ??
  "0xcA6bf2D574209D49515a9Eeb61E27924edE28860") as `0x${string}`;

const ALCHEMY_RPC_URL_1 = process.env.ALCHEMY_RPC_URL_1;
const ALCHEMY_RPC_URL_2 = process.env.ALCHEMY_RPC_URL_2;
const ROBINHOOD_RPC_URL = process.env.ROBINHOOD_RPC_URL ?? "https://rpc.testnet.chain.robinhood.com";

// Path to the compiled SP1 prover binary
const PROVER_BINARY = process.env.PROVER_BINARY_PATH ?? path.resolve(__dirname, "../../zk/target/release/prove");
const SETTLE_SCRIPT = process.env.SETTLE_SCRIPT_PATH ?? path.resolve(__dirname, "../settle_intent.js");

if (!ALCHEMY_RPC_URL_1 || !ALCHEMY_RPC_URL_2) {
  console.error("[FATAL] ALCHEMY_RPC_URL_1 and ALCHEMY_RPC_URL_2 must both be set in .env");
  process.exit(1);
}

// ─── Chain definitions ───────────────────────────────────────────────────────

const robinhoodTestnet: Chain = {
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [ROBINHOOD_RPC_URL] },
  },
};

// ─── ABI ─────────────────────────────────────────────────────────────────────

const INTENT_CREATED_EVENT = parseAbiItem(
  "event IntentCreated(bytes32 indexed intentId, address indexed sender, uint256 amount, address tokenAddress, bytes32 destinationWallet, uint64 destinationChainId, uint64 expiry, uint16 slippageBps)"
);

// Chain IDs that use a non-EVM VM — destinationWallet is decoded differently for these.
const SOLANA_CHAIN_ID = 1399811149n;
// Matches ma-at-web/lib/chains.ts's onChainId for TRON Nile — the value the
// frontend actually submits as destinationChainId, not the value named in
// the original TRON-support task spec (2494104990), which doesn't match.
const TRON_NILE_CHAIN_ID = 3448148188n;

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58CheckEncode(hex: string): string {
  const buf = Buffer.from(hex, "hex");
  const checksum = createHash("sha256").update(createHash("sha256").update(buf).digest()).digest().subarray(0, 4);
  const bytes = Buffer.concat([buf, checksum]);

  let value = BigInt("0x" + bytes.toString("hex"));
  let result = "";
  while (value > 0n) {
    const mod = value % 58n;
    result = BASE58_ALPHABET[Number(mod)] + result;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte === 0) result = "1" + result;
    else break;
  }
  return result;
}

/// Decodes an IntentCreated `destinationWallet` (bytes32) per the encoding
/// convention documented on IntentManager.sol's Intent struct:
///   - Solana: the raw 32-byte public key.
///   - TRON: the raw 21-byte address (1-byte prefix + 20 address bytes),
///     right-padded with zeros — checksum is recomputed on encode.
///   - EVM (anything else): left-padded address, in the low 20 bytes.
function decodeDestinationWallet(destinationWallet: `0x${string}`, destinationChainId: bigint): string {
  const bytes = Buffer.from(destinationWallet.slice(2), "hex");

  if (destinationChainId === SOLANA_CHAIN_ID) {
    return new PublicKey(bytes).toBase58();
  }

  if (destinationChainId === TRON_NILE_CHAIN_ID) {
    const payload = bytes.subarray(0, 21);
    return base58CheckEncode(payload.toString("hex"));
  }

  return `0x${bytes.subarray(12).toString("hex")}`;
}

const COLLATERAL_POSTED_EVENT = parseAbiItem(
  "event CollateralPosted(bytes32 indexed intentId, address indexed solver, uint256 collateralAmount)"
);

const INTENT_SETTLED_EVENT = parseAbiItem(
  "event IntentSettled(bytes32 indexed intentId, address indexed solver, uint256 amount, bytes32 zkProofHash)"
);

const INTENT_MANAGER_ABI = [INTENT_CREATED_EVENT, COLLATERAL_POSTED_EVENT, INTENT_SETTLED_EVENT] as const;

// ─── Clients ─────────────────────────────────────────────────────────────────

const arbClient = createPublicClient({
  chain: arbitrumSepolia,
  transport: fallback([http(ALCHEMY_RPC_URL_1), http(ALCHEMY_RPC_URL_2)]),
});

const rhClient = createPublicClient({
  chain: robinhoodTestnet,
  transport: http(ROBINHOOD_RPC_URL),
});

// ─── Formatting helpers ───────────────────────────────────────────────────────

function formatEther(wei: bigint): string {
  return (Number(wei) / 1e18).toFixed(6);
}

function divider(): void {
  console.log("─".repeat(64));
}

// ─── ZK Proof Trigger ────────────────────────────────────────────────────────
// Spawns the SP1 prover binary in execute mode (instant, no GPU needed).
// Parses stdout for verified status and cycle count.
// Called automatically on every IntentCreated event.

function triggerZKVerification(
  intentId: string,
  blockNumber: string,
  destinationWallet: string,
  destinationChainId: bigint
): void {
  console.log(`[ZK] Spawning prover for intentId: ${intentId}`);
  console.log(`[ZK] Binary: ${PROVER_BINARY}`);
  console.log(`[ZK] Mode: execute (instant verification)`);

  const env = {
    ...process.env,
    SP1_PROVER: "cpu",
  };

  const prover = spawn(PROVER_BINARY, ["execute"], { env });

  let stdout = "";
  let stderr = "";

  prover.stdout.on("data", (data: Buffer) => {
    stdout += data.toString();
  });

  prover.stderr.on("data", (data: Buffer) => {
    stderr += data.toString();
  });

  prover.on("close", (code: number) => {
    if (code !== 0) {
      console.error(`[ZK] Prover exited with code ${code}`);
      if (stderr) console.error(`[ZK] stderr: ${stderr.trim()}`);
      return;
    }

    // Parse verified status
    const verifiedMatch = stdout.match(/verified:\s*(true|false)/);
    const cyclesMatch = stdout.match(/cycles:\s*(\d+)/);
    const vkeyMatch = stdout.match(/Verification key:\s*(0x[a-fA-F0-9]+)/);

    const verified = verifiedMatch ? verifiedMatch[1] : "unknown";
    const cycles = cyclesMatch ? cyclesMatch[1] : "unknown";
    const vkey = vkeyMatch ? vkeyMatch[1] : "unknown";

    divider();
    console.log(`[ZK] ─── PROOF VERIFICATION COMPLETE ───`);
    console.log(`[ZK]   intentId:  ${intentId}`);
    console.log(`[ZK]   blockNum:  ${blockNumber}`);
    console.log(`[ZK]   verified:  ${verified}`);
    console.log(`[ZK]   cycles:    ${cycles}`);
    console.log(`[ZK]   vkey:      ${vkey}`);
    console.log(`[ZK]   status:    ${verified === "true" ? "VALID — ready for settlement" : "INVALID — intent rejected"}`);
    divider();

    // ── Trigger Solana settlement if verified ──
    if (verified === "true") {
      console.log(`[SETTLE] ZK verified — triggering Solana settlement...`);
      const settleEnv = {
        ...process.env,
        DESTINATION_WALLET: destinationWallet,
        DESTINATION_CHAIN_ID: destinationChainId.toString(),
      };
      const settler = spawn("node", [SETTLE_SCRIPT], { env: settleEnv });
      let settleOut = "";
      let settleErr = "";
      settler.stdout.on("data", (d: Buffer) => { settleOut += d.toString(); });
      settler.stderr.on("data", (d: Buffer) => { settleErr += d.toString(); });
      settler.on("close", (code: number) => {
        if (code !== 0) {
          console.error(`[SETTLE] Settlement failed (code ${code})`);
          if (settleErr) console.error(`[SETTLE] ${settleErr.trim()}`);
          return;
        }
        const settleTxMatch = settleOut.match(/receive_settlement tx:\s*(\S+)/);
        const deltaMatch = settleOut.match(/Delta:\s*\+\s*([\d.]+)/);
        const settleTx = settleTxMatch ? settleTxMatch[1] : "unknown";
        const delta = deltaMatch ? deltaMatch[1] : "unknown";
        divider();
        console.log(`[SETTLE] ─── SOLANA SETTLEMENT COMPLETE ───`);
        console.log(`[SETTLE]   intentId:   ${intentId}`);
        console.log(`[SETTLE]   settleTx:   ${settleTx}`);
        console.log(`[SETTLE]   delivered:  ${delta} SOL`);
        console.log(`[SETTLE]   destination: C9CZZFbeJ2Vzj9w8ctcsYKyK4mLQNq2vvsGwPJ7uEHtd`);
        console.log(`[SETTLE]   note: 1:1 mock rate (devnet). Pyth oracle + Jupiter routing at mainnet.`);
        divider();
      });
      settler.on("error", (err: Error) => {
        console.error(`[SETTLE] Failed to spawn settler:`, err.message);
      });
    }
  });

  prover.on("error", (err: Error) => {
    console.error(`[ZK] Failed to spawn prover:`, err.message);
    console.error(`[ZK] Is the binary at ${PROVER_BINARY}?`);
  });
}

// ─── Event handlers ────────────────────────────────────────────────────────────

function logIntentCreated(log: Log, chainLabel: string): void {
  try {
    const args = (log as unknown as {
      args: {
        intentId: `0x${string}`;
        sender: `0x${string}`;
        amount: bigint;
        tokenAddress: `0x${string}`;
        destinationWallet: `0x${string}`;
        destinationChainId: bigint;
        expiry: bigint;
        slippageBps: number;
      };
    }).args;

    const expiryDate = new Date(Number(args.expiry) * 1000).toISOString();
    const isNative = args.tokenAddress === "0x0000000000000000000000000000000000000000";

    divider();
    console.log(`[IntentCreated] Chain: ${chainLabel}`);
    console.log(`  intentId:           ${args.intentId}`);
    console.log(`  sender:             ${args.sender}`);
    console.log(`  amount:             ${formatEther(args.amount)} ETH (${args.amount.toString()} wei)`);
    console.log(`  tokenAddress:       ${args.tokenAddress}${isNative ? " (native)" : " (ERC20)"}`);
    const decodedDestination = decodeDestinationWallet(args.destinationWallet, args.destinationChainId);
    console.log(`  destinationWallet:  ${args.destinationWallet} (decoded: ${decodedDestination})`);
    console.log(`  destinationChainId: ${args.destinationChainId.toString()}`);
    console.log(`  expiry:             ${expiryDate} (${args.expiry.toString()})`);
    console.log(`  slippageBps:        ${args.slippageBps} (${(args.slippageBps / 100).toFixed(2)}%)`);
    console.log(`  txHash:             ${log.transactionHash}`);
    console.log(`  blockNumber:        ${log.blockNumber?.toString()}`);
    divider();

    // ── Automatically trigger ZK verification ──
    console.log(`[ZK] IntentCreated detected — triggering ZK verification...`);
    triggerZKVerification(
      args.intentId,
      log.blockNumber?.toString() ?? "unknown",
      decodedDestination,
      args.destinationChainId
    );

  } catch (err) {
    console.error(`[ERROR] Failed to process IntentCreated log on ${chainLabel}:`, err);
  }
}

function logCollateralPosted(log: Log, chainLabel: string): void {
  try {
    const args = (log as unknown as {
      args: {
        intentId: `0x${string}`;
        solver: `0x${string}`;
        collateralAmount: bigint;
      };
    }).args;

    divider();
    console.log(`[CollateralPosted] Chain: ${chainLabel}`);
    console.log(`  intentId:         ${args.intentId}`);
    console.log(`  solver:           ${args.solver}`);
    console.log(`  collateralAmount: ${formatEther(args.collateralAmount)} ETH (${args.collateralAmount.toString()} wei)`);
    console.log(`  txHash:           ${log.transactionHash}`);
    console.log(`  blockNumber:      ${log.blockNumber?.toString()}`);
    divider();
  } catch (err) {
    console.error(`[ERROR] Failed to process CollateralPosted log on ${chainLabel}:`, err);
  }
}

function logIntentSettled(log: Log, chainLabel: string): void {
  try {
    const args = (log as unknown as {
      args: {
        intentId: `0x${string}`;
        solver: `0x${string}`;
        amount: bigint;
        zkProofHash: `0x${string}`;
      };
    }).args;

    divider();
    console.log(`[IntentSettled] Chain: ${chainLabel}`);
    console.log(`  intentId:    ${args.intentId}`);
    console.log(`  solver:      ${args.solver}`);
    console.log(`  amount:      ${formatEther(args.amount)} ETH (${args.amount.toString()} wei)`);
    console.log(`  zkProofHash: ${args.zkProofHash}`);
    console.log(`  txHash:      ${log.transactionHash}`);
    console.log(`  blockNumber: ${log.blockNumber?.toString()}`);
    divider();
  } catch (err) {
    console.error(`[ERROR] Failed to process IntentSettled log on ${chainLabel}:`, err);
  }
}

// ─── Watchers ────────────────────────────────────────────────────────────────

function watchChain(
  client: typeof arbClient | typeof rhClient,
  chainLabel: string,
  intentManagerAddress: `0x${string}`
): void {
  console.log(`[${chainLabel}] Watching IntentManager at ${intentManagerAddress}`);

  client.watchContractEvent({
    address: intentManagerAddress,
    abi: INTENT_MANAGER_ABI,
    eventName: "IntentCreated",
    onLogs: (logs) => logs.forEach((log) => logIntentCreated(log, chainLabel)),
    onError: (err) => console.error(`[${chainLabel}] IntentCreated watcher error:`, err.message),
  });

  client.watchContractEvent({
    address: intentManagerAddress,
    abi: INTENT_MANAGER_ABI,
    eventName: "CollateralPosted",
    onLogs: (logs) => logs.forEach((log) => logCollateralPosted(log, chainLabel)),
    onError: (err) => console.error(`[${chainLabel}] CollateralPosted watcher error:`, err.message),
  });

  client.watchContractEvent({
    address: intentManagerAddress,
    abi: INTENT_MANAGER_ABI,
    eventName: "IntentSettled",
    onLogs: (logs) => logs.forEach((log) => logIntentSettled(log, chainLabel)),
    onError: (err) => console.error(`[${chainLabel}] IntentSettled watcher error:`, err.message),
  });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═".repeat(64));
  console.log("  Maat Orchestrator — Intent Listener + ZK Verifier");
  console.log(`  Started: ${new Date().toISOString()}`);
  console.log(`  Prover:  ${PROVER_BINARY}`);
  console.log("═".repeat(64) + "\n");

  try {
    const arbBlock = await arbClient.getBlockNumber();
    console.log(`[Arbitrum Sepolia] Connected. Latest block: ${arbBlock}`);
  } catch (err) {
    console.error("[FATAL] Cannot connect to Arbitrum Sepolia RPC:", (err as Error).message);
    process.exit(1);
  }

  let robinhoodAvailable = true;
  try {
    const rhBlock = await rhClient.getBlockNumber();
    console.log(`[Robinhood Testnet] Connected. Latest block: ${rhBlock}`);
  } catch (err) {
    robinhoodAvailable = false;
    console.warn("[WARN] Cannot connect to Robinhood Testnet RPC. Skipping its watcher.");
    console.warn(`  Error: ${(err as Error).message}`);
  }

  console.log("");
  watchChain(arbClient, "Arbitrum Sepolia", ARBITRUM_INTENT_MANAGER_ADDRESS);
  if (robinhoodAvailable) {
    watchChain(rhClient, "Robinhood Testnet", ROBINHOOD_INTENT_MANAGER_ADDRESS);
  }

  console.log("\n[Orchestrator] Listening. Waiting for intents...\n");
}

process.on("unhandledRejection", (reason) => {
  console.error("[ERROR] Unhandled rejection (continuing):", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[ERROR] Uncaught exception (continuing):", err);
});

main().catch((err) => {
  console.error("[FATAL] Unhandled error during boot:", err);
  process.exit(1);
});
