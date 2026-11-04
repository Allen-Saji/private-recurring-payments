use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use zcash_client_backend::proto::service::{RawTransaction, TxFilter};
use zcash_primitives::transaction::Transaction;
use zcash_protocol::consensus::BranchId;

#[tokio::main]
async fn main() -> Result<()> {
    rustls::crypto::ring::default_provider()
        .install_default()
        .ok();
    let path = std::env::args()
        .nth(1)
        .context("Pass a retained testnet outbox file")?;
    let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(path)?)?;
    ensure!(
        saved["network"] == "testnet",
        "Only testnet outboxes supported"
    );
    let raw = hex::decode(saved["raw_hex"].as_str().context("Missing bytes")?)?;
    ensure!(
        hex::encode(Sha256::digest(&raw))
            == saved["sha256"].as_str().context("Missing checksum")?,
        "Checksum mismatch"
    );
    let branch = BranchId::try_from(u32::try_from(
        saved["branch"].as_u64().context("Missing branch")?,
    )?)
    .map_err(|e| anyhow::anyhow!(e))?;
    let tx = Transaction::read(raw.as_slice(), branch)?;
    ensure!(
        tx.txid().to_string() == saved["txid"].as_str().context("Missing ID")?,
        "ID mismatch"
    );
    let mut client = private_recurring_wallet::wallet::connect().await?;
    let filter = TxFilter {
        hash: tx.txid().as_ref().to_vec(),
        ..Default::default()
    };
    let before = client.get_transaction(filter.clone()).await?.into_inner();
    ensure!(
        before.height > 0 && before.data == raw,
        "Expected already-mined identical transaction"
    );
    let reply = client
        .send_transaction(RawTransaction {
            data: raw.clone(),
            height: 0,
        })
        .await?
        .into_inner();
    let after = client.get_transaction(filter).await?.into_inner();
    ensure!(
        after.height == before.height && after.data == raw,
        "Mined transaction changed"
    );
    println!(
        "{}",
        serde_json::json!({"txid":tx.txid().to_string(),"same_mined_height":after.height,"same_bytes":true,"duplicate_submit_code":reply.error_code,"duplicate_submit_message":reply.error_message})
    );
    Ok(())
}
