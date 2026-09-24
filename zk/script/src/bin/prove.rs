// Host-side driver for the Phase 2 zkVM program: fetches a real Arbitrum
// Sepolia IntentCreated tx, builds the header RLP + receipt inclusion proof
// exactly as validated in header_check.rs (Phase 1), and feeds it to the
// program via SP1's execute/prove modes.
//
// --tamper=<kind> corrupts one field of an otherwise-real, otherwise-valid
// input for Phase 3's negative tests — every kind must make the program
// panic (non-zero exit), never silently produce a "verified: false" output.
use anyhow::{anyhow, Result};
use dotenv::dotenv;
use eth_trie::{EthTrie, MemoryDB, Trie};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sp1_sdk::{include_elf, Elf, HashableKey, Prover, ProveRequest, ProverClient, ProvingKey, SP1Stdin};
use std::env;
use std::sync::Arc;

const TARGET_CONTRACT: &str = "0x9D1bd7119E9FefF6Baa3968272811323B354B16f";
// Robinhood Chain testnet IntentManager — same Solidity source, same
// IntentCreated signature/topic0, different address. Used for the
// --tamper=different-contract negative test.
const OTHER_REAL_CONTRACT: &str = "0xcA6bf2D574209D49515a9Eeb61E27924edE28860";
const INTENT_CREATED_TOPIC0: &str = "0x1633e7e54ae0b855365938679d6532826f20b065ed71f076c885b24249decd99";

const MAAT_ZK_ELF: Elf = include_elf!("maat-zk-program");

#[derive(Serialize, Deserialize)]
pub struct ProofInput {
    pub header_rlp: Vec<u8>,
    pub receipt_proof_nodes: Vec<Vec<u8>>,
    pub tx_index: u64,
    pub log_index: u64,
    pub expected_contract: [u8; 20],
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ProofOutput {
    pub block_hash: [u8; 32],
    pub block_number: u64,
    pub block_timestamp: u64,
    pub contract: [u8; 20],
    pub intent_id: [u8; 32],
    pub sender: [u8; 20],
    pub amount: [u8; 32],
    pub token_address: [u8; 20],
    pub destination_wallet: [u8; 32],
    pub destination_chain_id: u64,
    pub expiry: u64,
    pub slippage_bps: u16,
}

fn h2b(s: &str) -> Result<Vec<u8>> {
    let s = s.trim_start_matches("0x");
    let s = if s.len() % 2 == 1 { format!("0{s}") } else { s.to_string() };
    Ok(hex::decode(s)?)
}

fn h2b20(s: &str) -> Result<[u8; 20]> {
    let v = h2b(s)?;
    v.try_into().map_err(|v: Vec<u8>| anyhow!("expected 20 bytes, got {}", v.len()))
}

fn strip_leading_zeros(mut b: Vec<u8>) -> Vec<u8> {
    while b.first() == Some(&0) {
        b.remove(0);
    }
    b
}

fn rpc_urls() -> Result<Vec<String>> {
    let urls: Vec<String> = ["ALCHEMY_RPC_URL_1", "ALCHEMY_RPC_URL_2", "ALCHEMY_RPC_URL_3"]
        .iter()
        .filter_map(|k| env::var(k).ok())
        .filter(|v| !v.is_empty())
        .collect();
    if urls.is_empty() {
        return Err(anyhow!("no ALCHEMY_RPC_URL_1/2/3 set in .env"));
    }
    Ok(urls)
}

fn rpc_call_one(rpc_url: &str, method: &str, params: &Value) -> Result<Value> {
    let body = serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
    let resp = reqwest::blocking::Client::new().post(rpc_url).json(&body).send()?.json::<Value>()?;
    if let Some(err) = resp.get("error") {
        return Err(anyhow!("RPC error on {method}: {err}"));
    }
    resp.get("result").cloned().ok_or_else(|| anyhow!("no result for {method}: {resp}"))
}

fn rpc_call(urls: &[String], method: &str, params: Value) -> Result<Value> {
    let mut last_err = None;
    for (i, url) in urls.iter().enumerate() {
        match rpc_call_one(url, method, &params) {
            Ok(v) => return Ok(v),
            Err(e) => {
                eprintln!("[rpc] {method} failed on URL_{} ({e}); trying next", i + 1);
                last_err = Some(e);
            }
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow!("no RPC URLs configured")))
}

fn get_block_receipts(urls: &[String], block_number: &str, block: &Value) -> Result<Value> {
    if let Ok(v) = rpc_call(urls, "eth_getBlockReceipts", serde_json::json!([block_number])) {
        return Ok(v);
    }
    eprintln!("[rpc] eth_getBlockReceipts unsupported/failed — falling back to per-tx eth_getTransactionReceipt");
    let tx_hashes = block["transactions"].as_array().ok_or_else(|| anyhow!("block has no transactions array"))?;
    let mut receipts = Vec::with_capacity(tx_hashes.len());
    for h in tx_hashes {
        receipts.push(rpc_call(urls, "eth_getTransactionReceipt", serde_json::json!([h]))?);
    }
    Ok(Value::Array(receipts))
}

/// The 16 standard go-ethereum header fields, RLP-encoded in order. Same
/// field list validated against real Arbitrum Sepolia data in Phase 1.
fn header_rlp_bytes(block: &Value) -> Result<Vec<u8>> {
    let get = |k: &str| -> Result<&str> {
        block.get(k).and_then(Value::as_str).ok_or_else(|| anyhow!("missing header field {k}"))
    };
    let fields: Vec<Vec<u8>> = vec![
        h2b(get("parentHash")?)?,
        h2b(get("sha3Uncles")?)?,
        h2b(get("miner")?)?,
        h2b(get("stateRoot")?)?,
        h2b(get("transactionsRoot")?)?,
        h2b(get("receiptsRoot")?)?,
        h2b(get("logsBloom")?)?,
        strip_leading_zeros(h2b(get("difficulty")?)?),
        strip_leading_zeros(h2b(get("number")?)?),
        strip_leading_zeros(h2b(get("gasLimit")?)?),
        strip_leading_zeros(h2b(get("gasUsed")?)?),
        strip_leading_zeros(h2b(get("timestamp")?)?),
        h2b(get("extraData")?)?,
        h2b(get("mixHash")?)?,
        h2b(get("nonce")?)?,
        strip_leading_zeros(h2b(get("baseFeePerGas")?)?),
    ];
    let mut stream = rlp::RlpStream::new_list(fields.len());
    for f in &fields {
        stream.append(f);
    }
    Ok(stream.out().to_vec())
}

fn encode_receipt(receipt: &Value) -> Result<Vec<u8>> {
    let status = strip_leading_zeros(h2b(receipt["status"].as_str().ok_or_else(|| anyhow!("no status"))?)?);
    let cumulative_gas = strip_leading_zeros(h2b(receipt["cumulativeGasUsed"].as_str().ok_or_else(|| anyhow!("no cumulativeGasUsed"))?)?);
    let bloom = h2b(receipt["logsBloom"].as_str().ok_or_else(|| anyhow!("no logsBloom"))?)?;
    let logs = receipt["logs"].as_array().ok_or_else(|| anyhow!("no logs array"))?;

    let mut body = rlp::RlpStream::new_list(4);
    body.append(&status);
    body.append(&cumulative_gas);
    body.append(&bloom);
    body.begin_list(logs.len());
    for log in logs {
        let addr = h2b(log["address"].as_str().ok_or_else(|| anyhow!("no log address"))?)?;
        let topics = log["topics"].as_array().ok_or_else(|| anyhow!("no topics"))?;
        let data = h2b(log["data"].as_str().ok_or_else(|| anyhow!("no log data"))?)?;
        body.begin_list(3);
        body.append(&addr);
        body.begin_list(topics.len());
        for t in topics {
            body.append(&h2b(t.as_str().ok_or_else(|| anyhow!("bad topic"))?)?);
        }
        body.append(&data);
    }

    let typ = u64::from_str_radix(receipt["type"].as_str().ok_or_else(|| anyhow!("no type"))?.trim_start_matches("0x"), 16)?;
    let body_bytes = body.out().to_vec();
    if typ == 0 {
        Ok(body_bytes)
    } else {
        let mut out = vec![typ as u8];
        out.extend(body_bytes);
        Ok(out)
    }
}

/// Fetches everything needed for one tx and assembles the real, untampered
/// ProofInput — the single source of truth both normal runs and negative
/// tests start from.
fn build_real_input(urls: &[String], tx_hash: &str) -> Result<ProofInput> {
    let tx = rpc_call(urls, "eth_getTransactionByHash", serde_json::json!([tx_hash]))?;
    let to = tx["to"].as_str().unwrap_or("").to_lowercase();
    if to != TARGET_CONTRACT.to_lowercase() {
        return Err(anyhow!("tx.to ({to}) != target contract ({TARGET_CONTRACT})"));
    }
    let block_number = tx["blockNumber"].as_str().ok_or_else(|| anyhow!("no blockNumber"))?.to_string();
    let tx_index = u64::from_str_radix(
        tx["transactionIndex"].as_str().ok_or_else(|| anyhow!("no transactionIndex"))?.trim_start_matches("0x"),
        16,
    )?;

    let block = rpc_call(urls, "eth_getBlockByNumber", serde_json::json!([block_number, false]))?;
    let header_rlp = header_rlp_bytes(&block)?;

    let receipts = get_block_receipts(urls, &block_number, &block)?;
    let receipts_arr = receipts.as_array().ok_or_else(|| anyhow!("receipts not an array"))?;

    let memdb = Arc::new(MemoryDB::new(true));
    let mut trie = EthTrie::new(memdb);
    for r in receipts_arr {
        let idx = u64::from_str_radix(
            r["transactionIndex"].as_str().ok_or_else(|| anyhow!("no txIndex"))?.trim_start_matches("0x"),
            16,
        )?;
        trie.insert(&rlp::encode(&idx).to_vec(), &encode_receipt(r)?).map_err(|e| anyhow!("trie insert failed: {e:?}"))?;
    }

    let target_receipt = receipts_arr
        .iter()
        .find(|r| r["transactionIndex"].as_str().map(|s| s.trim_start_matches("0x")) == Some(format!("{tx_index:x}").as_str()))
        .ok_or_else(|| anyhow!("target receipt not found in block receipts"))?;

    let logs = target_receipt["logs"].as_array().ok_or_else(|| anyhow!("no logs on target receipt"))?;
    let log_index = logs
        .iter()
        .position(|l| {
            let addr_match = l["address"].as_str().map(|a| a.to_lowercase()) == Some(TARGET_CONTRACT.to_lowercase());
            let topic0_match = l["topics"].get(0).and_then(Value::as_str).map(|t| t.to_lowercase()) == Some(INTENT_CREATED_TOPIC0.to_lowercase());
            addr_match && topic0_match
        })
        .ok_or_else(|| anyhow!("no IntentCreated log found in target receipt"))? as u64;

    // eth_trie's get_proof() silently returns an incomplete/wrong proof if
    // called before the trie's in-memory node cache is flushed via
    // root_hash()/commit() — must call it first even though we don't need
    // the returned root itself here (receipts_root already came from the
    // header).
    trie.root_hash().map_err(|e| anyhow!("root_hash failed: {e:?}"))?;
    let key = rlp::encode(&tx_index).to_vec();
    let proof = trie.get_proof(&key).map_err(|e| anyhow!("get_proof failed: {e:?}"))?;

    Ok(ProofInput {
        header_rlp,
        receipt_proof_nodes: proof,
        tx_index,
        log_index,
        expected_contract: h2b20(TARGET_CONTRACT)?,
    })
}

/// Applies one negative-test corruption to an otherwise-real, otherwise-valid
/// input. Every kind must make the zkVM program panic.
fn apply_tamper(mut input: ProofInput, kind: &str) -> Result<ProofInput> {
    match kind {
        // Flips a byte inside the receipt data region of the leaf proof node
        // (where the IntentCreated log's `amount` word lives) without
        // recomputing any parent hash — breaks the hash chain, same as any
        // other tamper to committed data.
        "amount" => {
            let last = input.receipt_proof_nodes.last_mut().ok_or_else(|| anyhow!("no proof nodes to tamper"))?;
            let n = last.len();
            last[n / 2] ^= 0xff;
        }
        // Generic wrong contract address (doesn't match the log's real address).
        "contract" => {
            input.expected_contract[0] ^= 0xff;
        }
        // A DIFFERENT real, deployed IntentManager (Robinhood testnet) —
        // same Solidity source, same IntentCreated signature/topic0, but not
        // the address this log actually came from.
        "different-contract" => {
            input.expected_contract = h2b20(OTHER_REAL_CONTRACT)?;
        }
        // Flips a byte in the header RLP — corrupts the receiptsRoot the
        // trie-proof walk starts from, since the proof nodes were built
        // against the real, untampered root.
        // Flips a byte specifically inside the receiptsRoot field (index 5)
        // — NOT an arbitrary offset. A byte flipped in e.g. logsBloom would
        // be structurally harmless since the program never reads that field,
        // silently passing this "negative" test for the wrong reason.
        "header" => {
            let receipts_root_data = {
                let header = rlp::Rlp::new(&input.header_rlp);
                header.at(5).map_err(|e| anyhow!("bad header RLP: {e:?}"))?.data().map_err(|e| anyhow!("bad header RLP: {e:?}"))?.as_ptr() as usize
            };
            let base = input.header_rlp.as_ptr() as usize;
            let offset = receipts_root_data - base;
            input.header_rlp[offset] ^= 0xff;
        }
        // Corrupts a byte anywhere in the leaf node generically — "proof for
        // a different receipt" in effect, since the leaf value no longer
        // matches what any real receipt would encode to.
        "receipt" => {
            let last = input.receipt_proof_nodes.last_mut().ok_or_else(|| anyhow!("no proof nodes to tamper"))?;
            let n = last.len();
            last[n - 3] ^= 0xff;
        }
        other => return Err(anyhow!("unknown tamper kind: {other}")),
    }
    Ok(input)
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenv().ok();
    sp1_sdk::utils::setup_logger();

    let mode = env::args().nth(1).unwrap_or_else(|| "execute".to_string());
    let tx_hash = env::args().nth(2).ok_or_else(|| anyhow!("usage: prove <execute|prove> <tx_hash> [--tamper=<kind>]"))?;
    let tamper = env::args().find(|a| a.starts_with("--tamper=")).map(|a| a.trim_start_matches("--tamper=").to_string());

    let urls = rpc_urls()?;
    println!("[maat-zk] Building input from tx {tx_hash}...");
    let mut input = build_real_input(&urls, &tx_hash)?;
    if let Some(kind) = &tamper {
        println!("[maat-zk] Applying tamper: {kind}");
        input = apply_tamper(input, kind)?;
    }

    let mut stdin = SP1Stdin::new();
    stdin.write(&input);

    let client = ProverClient::builder().cpu().build().await;
    let pk = client.setup(MAAT_ZK_ELF).await.map_err(|e| anyhow!("Setup failed: {:?}", e))?;
    println!("[maat-zk] Verification key: {}", pk.verifying_key().bytes32());

    if mode == "execute" {
        println!("[maat-zk] MODE: execute (no proof)");
        match client.execute(MAAT_ZK_ELF, stdin).await {
            // A guest panic (any failed assert!/unwrap/expect in main.rs) still
            // halts "successfully" from the executor's point of view — it's
            // reported via report.exit_code, not as an Err here. Must check
            // this BEFORE touching public_values: on panic nothing was
            // committed, and reading an empty buffer as ProofOutput panics
            // this host process too (bincode EOF), not a clean error.
            Ok((_, report)) if report.exit_code != 0 => {
                println!("[maat-zk] EXECUTION PANICKED (guest exit_code={})", report.exit_code);
                if tamper.is_some() {
                    println!("[maat-zk] negative test PASSED (execution correctly rejected tampered input)");
                    return Ok(());
                }
                std::process::exit(2);
            }
            Ok((mut public_values, report)) => {
                let output: ProofOutput = public_values.read::<ProofOutput>();
                println!("[maat-zk] EXECUTION SUCCEEDED.");
                println!("  cycles:            {}", report.total_instruction_count());
                println!("  block_hash:        0x{}", hex::encode(output.block_hash));
                println!("  block_number:      {}", output.block_number);
                println!("  block_timestamp:   {}", output.block_timestamp);
                println!("  contract:          0x{}", hex::encode(output.contract));
                println!("  intentId:          0x{}", hex::encode(output.intent_id));
                println!("  sender:            0x{}", hex::encode(output.sender));
                println!("  amount:            0x{}", hex::encode(output.amount));
                println!("  tokenAddress:      0x{}", hex::encode(output.token_address));
                println!("  destinationWallet: 0x{}", hex::encode(output.destination_wallet));
                println!("  destinationChainId:{}", output.destination_chain_id);
                println!("  expiry:            {}", output.expiry);
                println!("  slippageBps:       {}", output.slippage_bps);
                if tamper.is_some() {
                    eprintln!("[maat-zk] WARNING: tampered input executed successfully — negative test FAILED");
                    std::process::exit(3);
                }
            }
            Err(e) => {
                println!("[maat-zk] EXECUTION PANICKED: {e}");
                if tamper.is_some() {
                    println!("[maat-zk] negative test PASSED (execution correctly rejected tampered input)");
                    return Ok(());
                }
                std::process::exit(2);
            }
        }
    } else {
        println!("[maat-zk] MODE: prove (10-30min on CPU)");
        let proof = client
            .prove(&pk, stdin)
            .mode(sp1_sdk::SP1ProofMode::Compressed)
            .await
            .map_err(|e| anyhow!("Proving failed: {:?}", e))?;
        let mut pv = proof.public_values.clone();
        let output: ProofOutput = pv.read::<ProofOutput>();
        println!("[maat-zk] PROOF GENERATED.");
        println!("  intentId: 0x{}", hex::encode(output.intent_id));
        println!("  vkey:     {}", pk.verifying_key().bytes32());

        match client.verify(&proof, pk.verifying_key(), None) {
            Ok(()) => println!("[maat-zk] PROOF VERIFIED"),
            Err(e) => {
                eprintln!("[maat-zk] PROOF VERIFICATION FAILED: {e}");
                std::process::exit(4);
            }
        }

        proof.save("proof_output.bin")?;
        println!("[maat-zk] Proof saved to: proof_output.bin");
    }

    Ok(())
}
