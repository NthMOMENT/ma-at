#![no_main]
sp1_zkvm::entrypoint!(main);

use serde::{Deserialize, Serialize};
use tiny_keccak::{Hasher, Keccak};

/// keccak256("IntentCreated(bytes32,address,uint256,address,bytes32,uint64,uint64,uint16)")
/// — the event signature actually live on IntentManager.sol at the pinned
/// contract address (confirmed against real chain data in Phase 1; NOT the
/// older 7-param signature without tokenAddress).
const INTENT_CREATED_SIGNATURE: &[u8] =
    b"IntentCreated(bytes32,address,uint256,address,bytes32,uint64,uint64,uint16)";

/// Untrusted input from the host (orchestrator). Nothing here is taken on
/// faith — every field is either hashed/decoded and checked against another
/// field, or discarded if it can't be tied back to `header_rlp`'s own hash.
#[derive(Serialize, Deserialize)]
pub struct ProofInput {
    /// Raw RLP encoding of the Arbitrum Sepolia block header containing our
    /// tx. Its keccak256 must equal the block hash we commit to — nothing
    /// about the header's contents (receiptsRoot, timestamp, number) is
    /// trusted until that hash check passes.
    pub header_rlp: Vec<u8>,
    /// Merkle-Patricia-Trie proof nodes from header.receiptsRoot down to the
    /// leaf holding our tx's receipt, keyed by rlp(tx_index).
    pub receipt_proof_nodes: Vec<Vec<u8>>,
    /// Index of our tx within the block — both the trie key and how we cross-
    /// check the receipt we end up with is the one the host claims it is.
    pub tx_index: u64,
    /// Which log within the decoded receipt is the IntentCreated event.
    pub log_index: u64,
    /// The IntentManager address we require the log to have been emitted by.
    pub expected_contract: [u8; 20],
}

/// Public outputs committed to the proof — readable by the orchestrator, and
/// the only thing downstream settlement logic should ever trust.
#[derive(Serialize, Deserialize)]
pub struct ProofOutput {
    pub block_hash: [u8; 32],
    pub block_number: u64,
    pub block_timestamp: u64,
    pub contract: [u8; 20],
    pub intent_id: [u8; 32],
    pub sender: [u8; 20],
    pub amount: [u8; 32],
    /// address(0) = native ETH; otherwise the ERC20 token contract. Not in
    /// the original Phase 2 spec (written against the pre-ERC20 event
    /// signature) — added because it's part of the live event and the
    /// orchestrator needs it to settle correctly. Flagged at Gate 2.
    pub token_address: [u8; 20],
    pub destination_wallet: [u8; 32],
    pub destination_chain_id: u64,
    pub expiry: u64,
    pub slippage_bps: u16,
}

fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Keccak::v256();
    hasher.update(data);
    let mut out = [0u8; 32];
    hasher.finalize(&mut out);
    out
}

fn be_bytes_to_u64(b: &[u8]) -> u64 {
    let mut buf = [0u8; 8];
    let n = b.len().min(8);
    buf[8 - n..].copy_from_slice(&b[b.len() - n..]);
    u64::from_be_bytes(buf)
}

fn nibbles_of(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(b >> 4);
        out.push(b & 0x0f);
    }
    out
}

/// Decodes a hex-prefix-encoded path (Ethereum MPT leaf/extension node's
/// first RLP item) into (is_leaf, path_nibbles).
fn decode_hex_prefix(encoded: &[u8]) -> (bool, Vec<u8>) {
    let nibbles = nibbles_of(encoded);
    let flag = nibbles[0];
    let is_leaf = flag == 2 || flag == 3;
    let odd = flag == 1 || flag == 3;
    let path = if odd { nibbles[1..].to_vec() } else { nibbles[2..].to_vec() };
    (is_leaf, path)
}

/// What the parent node said the next node in the path must be: either a
/// 32-byte keccak reference (the common case), or — for small subtrees —
/// the child node's RLP bytes embedded directly in the parent ("inline").
enum NodeRef {
    Hash([u8; 32]),
    Inline(Vec<u8>),
}

fn child_ref(item: rlp::Rlp) -> NodeRef {
    let bytes = item.data().unwrap();
    assert!(!bytes.is_empty(), "trie proof: reference to empty slot");
    if bytes.len() == 32 {
        let mut h = [0u8; 32];
        h.copy_from_slice(bytes);
        NodeRef::Hash(h)
    } else {
        NodeRef::Inline(bytes.to_vec())
    }
}

/// Walks a Merkle-Patricia-Trie inclusion proof from `root` down to `key`,
/// panicking (aborting the proof) unless every node — hashed or inline —
/// matches exactly what the previous node referenced, and the path is fully
/// consumed at a matching leaf/branch terminator. Returns the leaf value
/// (our receipt's raw bytes).
fn verify_trie_proof(root: [u8; 32], key: &[u8], proof_nodes: &[Vec<u8>]) -> Vec<u8> {
    let mut expected = NodeRef::Hash(root);
    let mut remaining = nibbles_of(key);

    for node_bytes in proof_nodes {
        match &expected {
            NodeRef::Hash(h) => {
                assert_eq!(&keccak256(node_bytes), h, "trie proof node hash mismatch");
            }
            NodeRef::Inline(bytes) => {
                assert_eq!(node_bytes, bytes, "trie proof inline node mismatch");
            }
        }

        let node: rlp::Rlp = rlp::Rlp::new(node_bytes);
        let item_count = node.item_count().expect("bad trie node RLP");

        if item_count == 17 {
            if remaining.is_empty() {
                return node.at(16).unwrap().data().unwrap().to_vec();
            }
            let idx = remaining.remove(0) as usize;
            expected = child_ref(node.at(idx).unwrap());
        } else if item_count == 2 {
            let (is_leaf, path) = decode_hex_prefix(node.at(0).unwrap().data().unwrap());
            assert!(remaining.starts_with(&path), "trie proof: path mismatch");
            remaining = remaining[path.len()..].to_vec();
            if is_leaf {
                assert!(remaining.is_empty(), "trie proof: leaf reached with path remaining");
                return node.at(1).unwrap().data().unwrap().to_vec();
            } else {
                expected = child_ref(node.at(1).unwrap());
            }
        } else {
            panic!("trie proof: node is neither branch (17) nor leaf/extension (2)");
        }
    }
    panic!("trie proof: exhausted proof nodes without reaching a terminator");
}

/// EIP-2718: legacy receipts are a bare RLP list (first byte >= 0xc0);
/// typed receipts (EIP-1559 = 0x02, Arbitrum internal = 0x6a, ...) are
/// `type_byte || rlp([status, cumulativeGasUsed, logsBloom, logs])`.
/// Asserts the tx actually succeeded (status == 1) — a reverted tx's logs
/// are not a real IntentCreated event no matter what they decode to.
fn decode_receipt_logs(receipt_bytes: &[u8]) -> Vec<rlp::Rlp> {
    let body = if receipt_bytes[0] < 0xc0 { &receipt_bytes[1..] } else { receipt_bytes };
    let receipt = rlp::Rlp::new(body);
    let status = be_bytes_to_u64(receipt.at(0).unwrap().data().unwrap());
    assert_eq!(status, 1, "receipt status != success");
    let logs_rlp = receipt.at(3).expect("receipt missing logs list");
    logs_rlp.iter().collect()
}

pub fn main() {
    let input: ProofInput = sp1_zkvm::io::read::<ProofInput>();

    // ── 1. Header: hash it, then (only after hashing) trust its fields ──
    let block_hash = keccak256(&input.header_rlp);
    let header = rlp::Rlp::new(&input.header_rlp);
    assert_eq!(header.item_count().unwrap(), 16, "unexpected header field count");
    let receipts_root_bytes = header.at(5).unwrap().data().unwrap();
    let mut receipts_root = [0u8; 32];
    receipts_root.copy_from_slice(receipts_root_bytes);
    let block_number = be_bytes_to_u64(header.at(8).unwrap().data().unwrap());
    let block_timestamp = be_bytes_to_u64(header.at(11).unwrap().data().unwrap());

    // ── 2. Receipt inclusion: walk the MPT proof against receiptsRoot ──
    let trie_key = rlp::encode(&input.tx_index).to_vec();
    let receipt_bytes = verify_trie_proof(receipts_root, &trie_key, &input.receipt_proof_nodes);

    // ── 3. Pull our log out of the receipt, check it's really our event ──
    let logs = decode_receipt_logs(&receipt_bytes);
    let log = logs
        .get(input.log_index as usize)
        .expect("log_index out of range for this receipt");

    let log_address = log.at(0).unwrap().data().unwrap();
    assert_eq!(log_address, &input.expected_contract[..], "log address != expected contract");

    let topics: Vec<Vec<u8>> = log.at(1).unwrap().iter().map(|t| t.data().unwrap().to_vec()).collect();
    assert!(topics.len() >= 3, "IntentCreated should have 3 topics (topic0 + 2 indexed params)");
    assert_eq!(&topics[0][..], &keccak256(INTENT_CREATED_SIGNATURE)[..], "log topic0 != IntentCreated signature");

    let mut intent_id = [0u8; 32];
    intent_id.copy_from_slice(&topics[1]);
    let mut sender = [0u8; 20];
    sender.copy_from_slice(&topics[2][12..32]);

    // ── 4. Decode ALL non-indexed fields from `data` (full-width, no truncation) ──
    let data = log.at(2).unwrap().data().unwrap();
    assert_eq!(data.len(), 192, "unexpected IntentCreated data length");

    let mut amount = [0u8; 32];
    amount.copy_from_slice(&data[0..32]);
    let mut token_address = [0u8; 20];
    token_address.copy_from_slice(&data[44..64]);
    let mut destination_wallet = [0u8; 32];
    destination_wallet.copy_from_slice(&data[64..96]);
    let destination_chain_id = be_bytes_to_u64(&data[96..128]);
    let expiry = be_bytes_to_u64(&data[128..160]);
    let slippage_bps = be_bytes_to_u64(&data[160..192]) as u16;

    // ── 5. The bug this whole rewrite exists to fix: expiry vs. real block time ──
    assert!(expiry > block_timestamp, "intent already expired as of this block's timestamp");

    let output = ProofOutput {
        block_hash,
        block_number,
        block_timestamp,
        contract: input.expected_contract,
        intent_id,
        sender,
        amount,
        token_address,
        destination_wallet,
        destination_chain_id,
        expiry,
        slippage_bps,
    };

    sp1_zkvm::io::commit(&output);
}
