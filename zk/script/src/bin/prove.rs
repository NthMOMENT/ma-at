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
use std::fmt;
use std::sync::Arc;

const TARGET_CONTRACT: &str = "0x9D1bd7119E9FefF6Baa3968272811323B354B16f";
// Robinhood Chain testnet IntentManager — same Solidity source, same
// IntentCreated signature/topic0, different address. Used for the
// --tamper=different-contract negative test.
const OTHER_REAL_CONTRACT: &str = "0xcA6bf2D574209D49515a9Eeb61E27924edE28860";
const INTENT_CREATED_TOPIC0: &str = "0x1633e7e54ae0b855365938679d6532826f20b065ed71f076c885b24249decd99";
// Solana chain id this deployment settles to. NOT enforced inside the zkVM
// (doing so would change the ELF and therefore the vkey) — the zkVM commits
// the real destinationChainId trustlessly regardless, and the orchestrator's
// settle gate (Phase 5B) re-checks it against that committed public output.
// This native check exists only to fail fast/readably instead of burning a
// ~7min/14GB prove run on an intent that was never going to settle here.
const EXPECTED_DESTINATION_CHAIN_ID: u64 = 1_399_811_149;

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

/// Everything written to proof_<intentId>.json — the full set of public
/// outputs plus the run metadata needed to make sense of them without
/// re-reading the binary proof.
#[derive(Serialize)]
struct ProofOutputJson {
    tx_hash: String,
    mode: String,
    vkey: String,
    block_hash: String,
    block_number: u64,
    block_timestamp: u64,
    contract: String,
    intent_id: String,
    sender: String,
    amount: String,
    token_address: String,
    destination_wallet: String,
    destination_chain_id: u64,
    expiry: u64,
    slippage_bps: u16,
}

impl ProofOutputJson {
    fn from_output(o: &ProofOutput, tx_hash: &str, mode: &str, vkey: &str) -> Self {
        Self {
            tx_hash: tx_hash.to_string(),
            mode: mode.to_string(),
            vkey: vkey.to_string(),
            block_hash: format!("0x{}", hex::encode(o.block_hash)),
            block_number: o.block_number,
            block_timestamp: o.block_timestamp,
            contract: format!("0x{}", hex::encode(o.contract)),
            intent_id: format!("0x{}", hex::encode(o.intent_id)),
            sender: format!("0x{}", hex::encode(o.sender)),
            amount: format!("0x{}", hex::encode(o.amount)),
            token_address: format!("0x{}", hex::encode(o.token_address)),
            destination_wallet: format!("0x{}", hex::encode(o.destination_wallet)),
            destination_chain_id: o.destination_chain_id,
            expiry: o.expiry,
            slippage_bps: o.slippage_bps,
        }
    }
}

/// Writes proof_<intentId>.json (mode == "prove") or exec_<intentId>.json
/// (mode == "execute") to a temp name, then renames it into place. Called
/// only on a clean, non-tampered outcome (a successful verify in prove mode;
/// a successful, non-panicking run in execute mode), so a reader polling for
/// the file never observes a partial write.
///
/// The prefix split matters downstream: the orchestrator (Phase 5B) will
/// only ever settle off a proof_<id>.json whose "mode" field is "prove" and
/// which has a matching proof_<id>.bin — an exec_<id>.json is execute-mode
/// output (no cryptographic proof behind it, no .bin) and must never be
/// mistaken for one.
fn write_json_output(output: &ProofOutput, tx_hash: &str, mode: &str, vkey: &str) -> Result<()> {
    let intent_id_hex = hex::encode(output.intent_id);
    let prefix = if mode == "prove" { "proof" } else { "exec" };
    let json_path = format!("{prefix}_{intent_id_hex}.json");
    let json_tmp = format!("{json_path}.tmp");
    let json = ProofOutputJson::from_output(output, tx_hash, mode, vkey);
    std::fs::write(&json_tmp, serde_json::to_string_pretty(&json)?)?;
    std::fs::rename(&json_tmp, &json_path)?;
    println!("[maat-zk] Wrote {json_path}");
    Ok(())
}

/// Distinguishes what the orchestrator needs to decide retry-vs-reject:
/// Infra (RPC/proof-construction trouble, transient by nature) -> exit 1,
/// retry with backoff. Semantic (the intent itself is bad) -> exit 2, mark
/// Rejected, never retry.
#[derive(Debug)]
enum CheckError {
    Infra(String),
    Semantic(String),
}

impl CheckError {
    fn exit_code(&self) -> i32 {
        match self {
            CheckError::Infra(_) => 1,
            CheckError::Semantic(_) => 2,
        }
    }
    fn kind(&self) -> &'static str {
        match self {
            CheckError::Infra(_) => "infra",
            CheckError::Semantic(_) => "semantic",
        }
    }
}

impl fmt::Display for CheckError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CheckError::Infra(m) | CheckError::Semantic(m) => write!(f, "{m}"),
        }
    }
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

fn be_bytes_to_u64(b: &[u8]) -> u64 {
    let mut buf = [0u8; 8];
    let n = b.len().min(8);
    buf[8 - n..].copy_from_slice(&b[b.len() - n..]);
    u64::from_be_bytes(buf)
}

fn hex_to_u64(s: &str) -> Result<u64, CheckError> {
    u64::from_str_radix(s.trim_start_matches("0x"), 16).map_err(|e| CheckError::Infra(format!("bad hex integer {s}: {e}")))
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

/// Fetches everything needed for one tx and runs, natively and with
/// readable messages, every check the zkVM program would otherwise only
/// surface as an opaque panic (status, contract, topic0, expiry) plus one
/// it doesn't check at all (destination chain — see
/// EXPECTED_DESTINATION_CHAIN_ID). Returns a ready-to-prove ProofInput.
///
/// Every early return is classified Infra (RPC/proof-construction trouble —
/// transient, worth retrying) or Semantic (the intent itself is bad — never
/// worth retrying), matching prove.rs's exit codes 1 and 2.
fn native_precheck(urls: &[String], tx_hash: &str) -> Result<ProofInput, CheckError> {
    let tx = rpc_call(urls, "eth_getTransactionByHash", serde_json::json!([tx_hash]))
        .map_err(|e| CheckError::Infra(format!("failed to fetch tx {tx_hash}: {e}")))?;
    if tx.is_null() {
        return Err(CheckError::Infra(format!(
            "tx {tx_hash} not found via RPC (not yet indexed, or wrong endpoint/network)"
        )));
    }
    // Deliberately NOT checking tx.to here: a valid intent can arrive via a
    // smart wallet, an ERC-4337 bundler, or an agent smart account, any of
    // which make tx.to != IntentManager while still emitting a real
    // IntentCreated log from IntentManager somewhere in the receipt. The
    // only thing that matters — here and in the zkVM — is finding that log.
    let block_number = tx["blockNumber"]
        .as_str()
        .ok_or_else(|| CheckError::Infra(format!("tx {tx_hash} has no blockNumber (still pending?)")))?
        .to_string();
    let tx_index = hex_to_u64(
        tx["transactionIndex"]
            .as_str()
            .ok_or_else(|| CheckError::Infra(format!("tx {tx_hash} has no transactionIndex")))?,
    )?;

    let block = rpc_call(urls, "eth_getBlockByNumber", serde_json::json!([block_number, false]))
        .map_err(|e| CheckError::Infra(format!("failed to fetch block {block_number}: {e}")))?;
    let header_rlp = header_rlp_bytes(&block)
        .map_err(|e| CheckError::Infra(format!("failed to encode block {block_number} header: {e}")))?;
    let block_timestamp = hex_to_u64(
        block["timestamp"]
            .as_str()
            .ok_or_else(|| CheckError::Infra(format!("block {block_number} has no timestamp")))?,
    )?;

    let receipts = get_block_receipts(urls, &block_number, &block)
        .map_err(|e| CheckError::Infra(format!("failed to fetch receipts for block {block_number}: {e}")))?;
    let receipts_arr = receipts
        .as_array()
        .ok_or_else(|| CheckError::Infra(format!("receipts for block {block_number} not an array")))?;

    let memdb = Arc::new(MemoryDB::new(true));
    let mut trie = EthTrie::new(memdb);
    for r in receipts_arr {
        let idx = hex_to_u64(
            r["transactionIndex"]
                .as_str()
                .ok_or_else(|| CheckError::Infra("a receipt in this block is missing transactionIndex".to_string()))?,
        )?;
        let encoded =
            encode_receipt(r).map_err(|e| CheckError::Infra(format!("proof construction failed (RLP-encoding receipt {idx}): {e}")))?;
        trie.insert(&rlp::encode(&idx).to_vec(), &encoded)
            .map_err(|e| CheckError::Infra(format!("proof construction failed (trie insert for receipt {idx}): {e:?}")))?;
    }

    let target_receipt = receipts_arr
        .iter()
        .find(|r| r["transactionIndex"].as_str().map(|s| s.trim_start_matches("0x")) == Some(format!("{tx_index:x}").as_str()))
        .ok_or_else(|| CheckError::Infra(format!("target receipt (tx_index {tx_index}) not found in block {block_number} receipts")))?;

    let status = hex_to_u64(
        target_receipt["status"]
            .as_str()
            .ok_or_else(|| CheckError::Infra("target receipt has no status field".to_string()))?,
    )?;
    if status != 1 {
        return Err(CheckError::Semantic(format!("transaction reverted (receipt status = {status}, expected 1)")));
    }

    let logs = target_receipt["logs"]
        .as_array()
        .ok_or_else(|| CheckError::Infra("target receipt has no logs array".to_string()))?;

    // Locate the log exactly as the zkVM does: emitter == IntentManager AND
    // topic0 == keccak256(IntentCreated signature). tx.to is irrelevant —
    // see the comment above. log_index is the position of that single
    // matching log within this receipt's logs array.
    let matches: Vec<usize> = logs
        .iter()
        .enumerate()
        .filter(|(_, l)| {
            let addr_match = l["address"].as_str().map(|a| a.to_lowercase()) == Some(TARGET_CONTRACT.to_lowercase());
            let topic0_match =
                l["topics"].get(0).and_then(Value::as_str).map(|t| t.to_lowercase()) == Some(INTENT_CREATED_TOPIC0.to_lowercase());
            addr_match && topic0_match
        })
        .map(|(i, _)| i)
        .collect();
    let log_pos = match matches.len() {
        0 => {
            return Err(CheckError::Semantic(format!(
                "no IntentCreated log found (emitter == {TARGET_CONTRACT} && topic0 == IntentCreated) in this tx's receipt"
            )))
        }
        // KNOWN LIMITATION: a tx that emits more than one IntentCreated log
        // from IntentManager (e.g. a batched/multicall tx creating several
        // intents at once) is rejected rather than proved — this pipeline
        // proves inclusion of exactly one intent per tx. Revisit if batched
        // intent creation becomes a real use case.
        n if n > 1 => return Err(CheckError::Semantic("multiple intents per tx not supported".to_string())),
        _ => matches[0],
    };
    let log_index = log_pos as u64;
    let log = &logs[log_pos];

    let data = h2b(log["data"].as_str().ok_or_else(|| CheckError::Infra("IntentCreated log has no data field".to_string()))?)
        .map_err(|e| CheckError::Infra(format!("bad log data hex: {e}")))?;
    if data.len() != 192 {
        return Err(CheckError::Infra(format!("unexpected IntentCreated data length {} (expected 192)", data.len())));
    }
    let destination_chain_id = be_bytes_to_u64(&data[96..128]);
    let expiry = be_bytes_to_u64(&data[128..160]);

    if destination_chain_id != EXPECTED_DESTINATION_CHAIN_ID {
        return Err(CheckError::Semantic(format!(
            "wrong destination chain: intent targets chain {destination_chain_id}, this deployment only settles to {EXPECTED_DESTINATION_CHAIN_ID}"
        )));
    }
    if expiry <= block_timestamp {
        return Err(CheckError::Semantic(format!("intent already expired: expiry {expiry} <= block timestamp {block_timestamp}")));
    }

    // eth_trie's get_proof() silently returns an incomplete/wrong proof if
    // called before the trie's in-memory node cache is flushed via
    // root_hash()/commit() — must call it first even though we don't need
    // the returned root itself here (receiptsRoot already came from the
    // header).
    trie.root_hash().map_err(|e| CheckError::Infra(format!("proof construction failed (root_hash): {e:?}")))?;
    let key = rlp::encode(&tx_index).to_vec();
    let proof = trie
        .get_proof(&key)
        .map_err(|e| CheckError::Infra(format!("proof construction failed (get_proof): {e:?}")))?;

    Ok(ProofInput {
        header_rlp,
        receipt_proof_nodes: proof,
        tx_index,
        log_index,
        expected_contract: h2b20(TARGET_CONTRACT)
            .map_err(|e| CheckError::Infra(format!("bad TARGET_CONTRACT constant: {e}")))?,
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

    let urls = match rpc_urls() {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[maat-zk] PRE-CHECK FAILED (infra): {e}");
            std::process::exit(1);
        }
    };

    println!("[maat-zk] Building input from tx {tx_hash}...");
    let mut input = match native_precheck(&urls, &tx_hash) {
        Ok(input) => input,
        Err(e) => {
            eprintln!("[maat-zk] PRE-CHECK FAILED ({}): {}", e.kind(), e);
            std::process::exit(e.exit_code());
        }
    };
    println!("[maat-zk] Pre-check passed: contract, status, topic0, destination chain, and expiry all OK.");

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
                let vkey = pk.verifying_key().bytes32();
                if let Err(e) = write_json_output(&output, &tx_hash, "execute", &vkey) {
                    eprintln!("[maat-zk] WARNING: failed to write output JSON: {e}");
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
        println!("[maat-zk] MODE: prove (~7 min, ~14GB RAM on CPU)");
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
            Ok(()) => {
                println!("[maat-zk] PROOF VERIFIED");
                let intent_id_hex = hex::encode(output.intent_id);
                let bin_path = format!("proof_{intent_id_hex}.bin");
                let bin_tmp = format!("{bin_path}.tmp");
                proof.save(&bin_tmp)?;
                std::fs::rename(&bin_tmp, &bin_path)?;
                println!("[maat-zk] Proof saved to: {bin_path}");
                let vkey = pk.verifying_key().bytes32();
                if let Err(e) = write_json_output(&output, &tx_hash, "prove", &vkey) {
                    eprintln!("[maat-zk] WARNING: failed to write output JSON: {e}");
                }
            }
            Err(e) => {
                eprintln!("[maat-zk] PROOF VERIFICATION FAILED: {e}");
                std::process::exit(4);
            }
        }
    }

    Ok(())
}
