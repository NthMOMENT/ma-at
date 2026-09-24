// Deploys IntentManager.sol to TRON Nile Testnet via tronweb.
// Compiles with solc (Node bindings) — no Foundry/forge/hardhat.
//
// Usage: node deploy_tron.js
// Requires TRON_PRIVATE_KEY in .env (hex string, no 0x prefix needed).

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const solc = require("solc");
const { TronWeb } = require("tronweb");

dotenv.config();

const CONTRACT_PATH = path.resolve(
  __dirname,
  "../contracts/evm/src/IntentManager.sol"
);
const CONTRACT_NAME = "IntentManager";
const TRON_FULL_HOST = process.env.TRON_API_BASE_URL || "https://nile.trongrid.io";
const FEE_LIMIT = 1_000_000_000; // 1000 TRX

function loadEnv() {
  const privateKey = process.env.TRON_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error(
      "TRON_PRIVATE_KEY is not set. Add it to orchestrator/.env before running this script."
    );
  }
  return privateKey;
}

// Resolves `import "@openzeppelin/contracts/..."` (and any other node_modules
// package import) against this package's node_modules for the solc compiler.
function findImports(importPath) {
  const candidates = [
    path.resolve(__dirname, "node_modules", importPath),
    path.resolve(path.dirname(CONTRACT_PATH), importPath),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { contents: fs.readFileSync(candidate, "utf8") };
    }
  }
  return { error: `File not found: ${importPath}` };
}

function compile() {
  const source = fs.readFileSync(CONTRACT_PATH, "utf8");
  const input = {
    language: "Solidity",
    sources: {
      [`${CONTRACT_NAME}.sol`]: { content: source },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object"],
        },
      },
    },
  };

  const output = JSON.parse(
    solc.compile(JSON.stringify(input), { import: findImports })
  );

  const errors = (output.errors || []).filter((e) => e.severity === "error");
  if (errors.length > 0) {
    for (const e of errors) console.error(e.formattedMessage);
    throw new Error("solc compilation failed");
  }
  if (output.errors) {
    for (const e of output.errors) console.warn(e.formattedMessage);
  }

  const contract = output.contracts[`${CONTRACT_NAME}.sol`][CONTRACT_NAME];
  return {
    abi: contract.abi,
    bytecode: contract.evm.bytecode.object,
  };
}

async function main() {
  const privateKey = loadEnv();

  console.log(`Compiling ${CONTRACT_PATH} ...`);
  const { abi, bytecode } = compile();
  console.log(`Compiled ${CONTRACT_NAME}: bytecode length ${bytecode.length / 2} bytes`);

  const tronWeb = new TronWeb({
    fullHost: TRON_FULL_HOST,
    privateKey,
  });

  const deployerAddress = tronWeb.address.fromPrivateKey(privateKey);
  console.log(`Deployer address (base58): ${deployerAddress}`);

  // All three constructor args set to the deployer for testnet.
  const constructorArgs = [deployerAddress, deployerAddress, deployerAddress];

  console.log("Deploying IntentManager to TRON Nile Testnet ...");
  const transaction = await tronWeb.transactionBuilder.createSmartContract(
    {
      abi,
      bytecode,
      feeLimit: FEE_LIMIT,
      callValue: 0,
      userFeePercentage: 100,
      originEnergyLimit: 10_000_000,
      parameters: constructorArgs,
    },
    deployerAddress
  );

  const signedTransaction = await tronWeb.trx.sign(transaction, privateKey);
  const broadcastResult = await tronWeb.trx.sendRawTransaction(signedTransaction);

  if (broadcastResult.code) {
    throw new Error(
      `Broadcast failed: ${broadcastResult.code} ${tronWeb.toUtf8(broadcastResult.message || "")}`
    );
  }

  const contractAddressHex = signedTransaction.contract_address;
  const contractAddressBase58 = tronWeb.address.fromHex(contractAddressHex);

  console.log("\nDeployment submitted.");
  console.log(`Transaction ID: ${signedTransaction.txID}`);
  console.log(`Contract address (base58): ${contractAddressBase58}`);
  console.log(
    `\nNote: allow a few seconds for the transaction to confirm before interacting with the contract.`
  );
}

main().catch((err) => {
  console.error("Deploy failed:", err);
  process.exit(1);
});
