// Phase 1 feasibility test (see project plan): proves out, against a real
// Arbitrum Sepolia tx, that we can (1) rebuild a block header from RPC fields
// and reproduce its hash, (2) rebuild the receipts trie for that block and
// reproduce header.receiptsRoot, and (3) generate + verify an inclusion proof
// for one tx's receipt within that trie. This is throwaway feasibility code —
// the real zkVM-side verifier is written in Phase 2 once this is confirmed.
use alloy_primitives::B256;
use anyhow::{anyhow, Result};
use dotenv::dotenv;
use eth_trie::{EthTrie, MemoryDB, Trie};
use serde_json::Value;
use sha3::{Digest, Keccak256};
use std::env;
use std::sync::Arc;

const TARGET_CONTRACT: &str = "0x9D1bd7119E9FefF6Baa3968272811323B354B16f";

fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Keccak256::new();
    hasher.update(data);
    hasher.finalize().into()
}

fn h2b(s: &str) -> Result<Vec<u8>> {
    let s = s.trim_start_matches("0x");
    let s = if s.len() % 2 == 1 { format!("0{s}") } else { s.to_string() };
    Ok(hex::decode(s)?)
}

fn strip_leading_zeros(mut b: Vec<u8>) -> Vec<u8> {
    while b.first() == Some(&0) {
        b.remove(0);
    }
    b
}

/// Reads ALCHEMY_RPC_URL_1..3 from the environment, in that order, skipping
/// any that aren't set. Mirrors listener.ts's viem fallback() transport so a
/// single key hitting its monthly cap doesn't take the pipeline down.
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
    let body = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": method, "params": params
    });
    let resp = reqwest::blocking::Client::new()
        .post(rpc_url)
        .json(&body)
        .send()?
        .json::<Value>()?;
    if let Some(err) = resp.get("error") {
        return Err(anyhow!("RPC error on {method}: {err}"));
    }
    resp.get("result")
        .cloned()
        .ok_or_else(|| anyhow!("no result for {method}: {resp}"))
}

/// Tries each configured RPC URL in order, falling through to the next one
/// on any error (rate limit, timeout, etc.) instead of failing outright.
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

/// Encodes the 16 standard go-ethereum header fields in RLP order and hashes
/// them. Arbitrum Nitro headers pack ArbOS-specific data (sendRoot, sendCount,
/// l1BlockNumber, arbos version) into extraData/mixHash/nonce, but the header
/// shape itself — and therefore its hash — is the standard EIP-1559 layout.
fn header_hash(block: &Value) -> Result<[u8; 32]> {
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
    Ok(keccak256(&stream.out()))
}

/// EIP-2718 receipt encoding: legacy (type 0) receipts are the bare RLP list;
/// typed receipts (EIP-1559 = 0x02, and Arbitrum's internal tx = 0x6a) are
/// `type_byte || rlp([status, cumulativeGasUsed, logsBloom, logs])`.
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

    let typ = u64::from_str_radix(
        receipt["type"].as_str().ok_or_else(|| anyhow!("no type"))?.trim_start_matches("0x"),
        16,
    )?;

    let body_bytes = body.out().to_vec();
    if typ == 0 {
        Ok(body_bytes)
    } else {
        let mut out = vec![typ as u8];
        out.extend(body_bytes);
        Ok(out)
    }
}

/// eth_getBlockReceipts isn't universally supported (some providers only
/// expose the legacy per-tx eth_getTransactionReceipt). Try the bulk call
/// first, and fall back to looping the block's tx hashes if it's rejected.
fn get_block_receipts(urls: &[String], block_number: &str, block: &Value) -> Result<Value> {
    if let Ok(v) = rpc_call(urls, "eth_getBlockReceipts", serde_json::json!([block_number])) {
        return Ok(v);
    }
    eprintln!("[rpc] eth_getBlockReceipts unsupported/failed — falling back to per-tx eth_getTransactionReceipt");
    let tx_hashes = block["transactions"]
        .as_array()
        .ok_or_else(|| anyhow!("block has no transactions array"))?;
    let mut receipts = Vec::with_capacity(tx_hashes.len());
    for h in tx_hashes {
        let receipt = rpc_call(urls, "eth_getTransactionReceipt", serde_json::json!([h]))?;
        receipts.push(receipt);
    }
    Ok(Value::Array(receipts))
}

fn main() -> Result<()> {
    dotenv().ok();

    let urls = rpc_urls()?;
    println!("[header_check] {} RPC URL(s) configured for rotation", urls.len());

    let tx_hash = env::args()
        .nth(1)
        .ok_or_else(|| anyhow!("usage: header_check <tx_hash>"))?;

    println!("[header_check] tx: {tx_hash}");

    // ── Fetch the tx to find its block + index, and sanity-check it hit our contract ──
    let tx = rpc_call(&urls, "eth_getTransactionByHash", serde_json::json!([tx_hash]))?;
    let to = tx["to"].as_str().unwrap_or("").to_lowercase();
    if to != TARGET_CONTRACT.to_lowercase() {
        return Err(anyhow!("tx.to ({to}) != target contract ({TARGET_CONTRACT})"));
    }
    let block_number = tx["blockNumber"].as_str().ok_or_else(|| anyhow!("no blockNumber"))?.to_string();
    let tx_index = u64::from_str_radix(
        tx["transactionIndex"].as_str().ok_or_else(|| anyhow!("no transactionIndex"))?.trim_start_matches("0x"),
        16,
    )?;
    println!("[header_check] block: {block_number}  txIndex: {tx_index}");

    // ── CHECK 1: header hash ──
    let block = rpc_call(&urls, "eth_getBlockByNumber", serde_json::json!([block_number, false]))?;
    let expected_hash = h2b(block["hash"].as_str().ok_or_else(|| anyhow!("no block hash"))?)?;
    let computed_hash = header_hash(&block)?;
    let check1 = computed_hash.as_slice() == expected_hash.as_slice();
    println!(
        "[CHECK 1] keccak(rlp(header)) == block.hash: {} (computed 0x{}, expected 0x{})",
        if check1 { "PASS" } else { "FAIL" },
        hex::encode(computed_hash),
        hex::encode(&expected_hash)
    );

    // ── CHECK 2: receipts trie root ──
    let receipts = get_block_receipts(&urls, &block_number, &block)?;
    let receipts_arr = receipts.as_array().ok_or_else(|| anyhow!("receipts not an array"))?;

    let memdb = Arc::new(MemoryDB::new(true));
    let mut trie = EthTrie::new(memdb);
    for r in receipts_arr {
        let idx = u64::from_str_radix(
            r["transactionIndex"].as_str().ok_or_else(|| anyhow!("no txIndex in receipt"))?.trim_start_matches("0x"),
            16,
        )?;
        let key = rlp::encode(&idx).to_vec();
        let value = encode_receipt(r)?;
        trie.insert(&key, &value).map_err(|e| anyhow!("trie insert failed: {e:?}"))?;
    }
    let computed_root = trie.root_hash().map_err(|e| anyhow!("root_hash failed: {e:?}"))?;
    let expected_root = h2b(block["receiptsRoot"].as_str().ok_or_else(|| anyhow!("no receiptsRoot"))?)?;
    let check2 = computed_root.as_slice() == expected_root.as_slice();
    println!(
        "[CHECK 2] receipts_trie_root == header.receiptsRoot: {} (computed 0x{}, expected 0x{})",
        if check2 { "PASS" } else { "FAIL" },
        hex::encode(computed_root.as_slice()),
        hex::encode(&expected_root)
    );

    // ── CHECK 3: merkle proof for our tx's receipt ──
    let target_receipt = receipts_arr
        .iter()
        .find(|r| {
            r["transactionIndex"].as_str().map(|s| s.trim_start_matches("0x")) == Some(format!("{tx_index:x}").as_str())
        })
        .ok_or_else(|| anyhow!("target receipt not found in block receipts"))?;
    let target_key = rlp::encode(&tx_index).to_vec();
    let target_value = encode_receipt(target_receipt)?;

    let proof = trie
        .get_proof(&target_key)
        .map_err(|e| anyhow!("get_proof failed: {e:?}"))?;
    println!("[header_check] proof node count: {}", proof.len());

    let verified_value = trie
        .verify_proof(B256::from_slice(&expected_root), &target_key, proof)
        .map_err(|e| anyhow!("verify_proof failed: {e:?}"))?;

    let check3 = verified_value.as_deref() == Some(target_value.as_slice());
    println!("[CHECK 3] merkle proof verifies to our tx's receipt: {}", if check3 { "PASS" } else { "FAIL" });

    println!();
    println!("SUMMARY  check1={}  check2={}  check3={}", check1, check2, check3);

    if check1 && check2 && check3 {
        Ok(())
    } else {
        Err(anyhow!("one or more checks failed"))
    }
}
