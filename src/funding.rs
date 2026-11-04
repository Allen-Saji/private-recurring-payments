use crate::wallet::{self, NETWORK};
use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use std::path::Path;
use zcash_client_backend::{
    data_api::{
        WalletRead,
        wallet::{ConfirmationsPolicy, decrypt_and_store_transaction},
    },
    proto::service::TxFilter,
    wallet::NoteId,
};
use zcash_primitives::transaction::{Transaction, TxId};
use zcash_protocol::{
    PoolType, ShieldedPool,
    consensus::{BlockHeight, BranchId},
    memo::Memo,
};

const AMOUNT: u64 = 5_000_000;
const MEMO: &str = "private-recurring:wallet-funding:v1";

pub async fn verify(root: &Path, encoded: &str) -> Result<()> {
    let mut hash = hex::decode(encoded)?;
    ensure!(hash.len() == 32, "Transaction ID must contain 32 bytes");
    hash.reverse();
    let id = TxId::from_bytes(hash.as_slice().try_into()?);
    let mut client = wallet::connect().await?;
    let raw = client
        .get_transaction(TxFilter {
            hash: id.as_ref().to_vec(),
            ..Default::default()
        })
        .await?
        .into_inner();
    ensure!(
        raw.height > 0 && raw.height < u64::from(u32::MAX),
        "Noir funding transaction is not mined yet"
    );
    let mined = BlockHeight::from_u32(u32::try_from(raw.height)?);
    let tx = Transaction::read(raw.data.as_slice(), BranchId::for_height(&NETWORK, mined))?;
    ensure!(tx.txid() == id, "Transaction identity mismatch");
    ensure!(
        tx.transparent_bundle().is_none(),
        "Funding has transparent inputs or outputs"
    );
    wallet::sync(&root.join("operating")).await?;
    let mut db = wallet::open(&root.join("operating"))?;
    decrypt_and_store_transaction(&NETWORK, &mut db, &tx, Some(mined))?;
    let tip = db.chain_height()?.context("Missing operating chain tip")?;
    ensure!(tip >= mined, "Operating wallet is behind the funding block");
    let outputs = db.get_received_outputs(id, (tip + 1).into(), ConfirmationsPolicy::MIN)?;
    ensure!(
        outputs.len() == 1
            && outputs[0].pool_type() == PoolType::Shielded(ShieldedPool::Ironwood)
            && u64::from(outputs[0].value()) == AMOUNT,
        "Operating wallet did not receive the exact 0.05 TAZ Ironwood output"
    );
    let note = NoteId::new(
        id,
        ShieldedPool::Ironwood,
        u16::try_from(outputs[0].output_index())?,
    );
    ensure!(
        db.get_memo(note)?.context("Funding memo unavailable")?
            == Memo::from_bytes(MEMO.as_bytes())?,
        "Funding memo does not match the Noir request"
    );
    let evidence = serde_json::json!({"network":"testnet","kind":"noir-funding","txid":id.to_string(),"mined_height":u32::from(mined),"verified_tip":u32::from(tip),"confirmations":u32::from(tip)-u32::from(mined)+1,"amount_zatoshis":AMOUNT,"memo":MEMO,"pool":"ironwood","transparent_inputs":0,"transparent_outputs":0,"raw_sha256":hex::encode(Sha256::digest(&raw.data)),"verification":"operating wallet decrypted exact amount and funding memo; no transparent bundle"});
    let dir = root.join("noir-funding");
    wallet::private_dir(&dir)?;
    let file = dir.join(format!("{}-at-{}.json", id, u32::from(tip)));
    if !file.exists() {
        wallet::write_new(&file, &serde_json::to_vec_pretty(&evidence)?)?;
    }
    println!("{}", serde_json::to_string_pretty(&evidence)?);
    Ok(())
}
