use crate::wallet::{self, NETWORK};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::path::Path;
use zcash_client_backend::{
    data_api::{
        WalletRead,
        wallet::{ConfirmationsPolicy, decrypt_and_store_transaction},
    },
    proto::service::{BlockId, Empty, TxFilter},
    wallet::NoteId,
};
use zcash_primitives::transaction::{Transaction, TxId};
use zcash_protocol::{
    PoolType, ShieldedPool,
    consensus::{BlockHeight, BranchId},
    memo::Memo,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub txid: String,
    pub amount_zatoshis: String,
    pub memo: String,
    pub mined_height: u32,
    pub verified_tip: u32,
    pub confirmations: u32,
    pub observed_at: u64,
    pub consensus_branch: String,
    pub latest_block_time: u32,
}

pub fn transaction_id(encoded: &str) -> Result<TxId> {
    ensure!(
        encoded.len() == 64
            && encoded
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "Invalid transaction ID"
    );
    let mut hash = hex::decode(encoded)?;
    hash.reverse();
    Ok(TxId::from_bytes(hash.as_slice().try_into()?))
}

// Uses only the recipient's wallet. Signer status, outboxes and caller-supplied
// amounts/memos are not evidence of receipt.
pub async fn received(
    path: &Path,
    encoded: &str,
    amount: u64,
    memo: &str,
    minimum: u32,
) -> Result<Receipt> {
    ensure!((1..=100).contains(&minimum), "Invalid confirmation policy");
    let id = transaction_id(encoded)?;
    wallet::sync(path).await?;
    let mut db = wallet::open(path)?;
    let mined = db
        .get_tx_height(id)?
        .context("Supplier has not scanned a mined payment")?;
    let scanned = db
        .get_wallet_summary(ConfirmationsPolicy::MIN)?
        .context("Missing scan summary")?;
    ensure!(
        scanned.fully_scanned_height() >= mined,
        "Supplier scan incomplete"
    );
    let mut client = wallet::connect().await?;
    let raw = client
        .get_transaction(TxFilter {
            hash: id.as_ref().to_vec(),
            ..Default::default()
        })
        .await?
        .into_inner();
    ensure!(
        raw.height == u64::from(u32::from(mined)),
        "Payment is missing or changed chain position"
    );
    let tx = Transaction::read(raw.data.as_slice(), BranchId::for_height(&NETWORK, mined))?;
    ensure!(
        tx.txid() == id && tx.transparent_bundle().is_none() && tx.sapling_bundle().is_none(),
        "Payment identity or shielded pool mismatch"
    );
    let block = client
        .get_block(BlockId {
            height: raw.height,
            hash: vec![],
        })
        .await?
        .into_inner();
    let known = db
        .get_block_hash(mined)?
        .context("Missing scanned block hash")?;
    ensure!(
        known.0.as_slice() == block.hash,
        "Supplier scan differs from current chain"
    );
    let info = client.get_lightd_info(Empty {}).await?.into_inner();
    let tip = u32::try_from(info.block_height)?;
    let now = crate::policy::now()?;
    let latest = client
        .get_block(BlockId {
            height: info.block_height,
            hash: vec![],
        })
        .await?
        .into_inner();
    ensure!(
        u64::from(latest.time) <= now + 120 && now.saturating_sub(u64::from(latest.time)) <= 1800,
        "Chain observation is stale"
    );
    let confirmations = tip
        .checked_sub(u32::from(mined))
        .context("Chain tip behind payment")?
        + 1;
    ensure!(confirmations >= minimum, "Payment needs more confirmations");
    decrypt_and_store_transaction(&NETWORK, &mut db, &tx, Some(mined))?;
    let outputs = db.get_received_outputs(
        id,
        (BlockHeight::from_u32(tip) + 1).into(),
        ConfirmationsPolicy::MIN,
    )?;
    ensure!(
        outputs.len() == 1
            && outputs[0].pool_type() == PoolType::Shielded(ShieldedPool::Ironwood)
            && u64::from(outputs[0].value()) == amount,
        "Supplier amount or pool mismatch"
    );
    let note = NoteId::new(
        id,
        ShieldedPool::Ironwood,
        u16::try_from(outputs[0].output_index())?,
    );
    ensure!(
        db.get_memo(note)?.context("Missing received memo")? == Memo::from_bytes(memo.as_bytes())?,
        "Payment belongs to a different invoice"
    );
    Ok(Receipt {
        txid: encoded.into(),
        amount_zatoshis: amount.to_string(),
        memo: memo.into(),
        mined_height: u32::from(mined),
        verified_tip: tip,
        confirmations,
        observed_at: now,
        consensus_branch: info.consensus_branch_id,
        latest_block_time: latest.time,
    })
}
