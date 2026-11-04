use crate::wallet::{self, NETWORK};
use anyhow::{Context, Result, ensure};
use secrecy::{ExposeSecret, SecretVec};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{convert::Infallible, fs, path::Path};
use zcash_client_backend::{
    data_api::{
        WalletRead,
        wallet::{
            ConfirmationsPolicy, create_pczt_from_proposal, decrypt_and_store_transaction,
            extract_and_store_transaction_from_pczt, propose_standard_transfer_to_address,
        },
    },
    fees::StandardFeeRule,
    proto::service::{ChainSpec, RawTransaction, TxFilter},
    wallet::{NoteId, OvkPolicy},
};
use zcash_keys::{address::Address, keys::UnifiedSpendingKey};
use zcash_primitives::transaction::{
    Transaction,
    builder::{BundlePadding, cached_orchard_proving_key},
};
use zcash_protocol::{
    PoolType, ShieldedPool,
    consensus::{BlockHeight, BranchId},
    memo::{Memo, MemoBytes},
    value::Zatoshis,
};

pub const AMOUNT: u64 = 1_000_000;
pub const MEMO: &str = "private-recurring:wallet-check:invoice-001";
const MAX_FEE: u64 = 100_000;

#[derive(Serialize, Deserialize)]
pub struct Outbox {
    network: String,
    pub txid: String,
    pub sha256: String,
    raw_hex: String,
    expiry_height: u32,
    branch: u32,
    recipient: String,
    amount_zatoshis: u64,
    fee_zatoshis: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PaymentSpec {
    pub recipient: String,
    pub amount: u64,
    pub memo: String,
    pub max_fee: u64,
    pub max_actions: u32,
}

fn legacy_spec(root: &Path) -> Result<PaymentSpec> {
    Ok(PaymentSpec {
        recipient: recipient(root)?.0,
        amount: AMOUNT,
        memo: MEMO.into(),
        max_fee: MAX_FEE,
        max_actions: 50,
    })
}

fn recipient(root: &Path) -> Result<(String, Address, orchard::Address)> {
    let public: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("supplier/public.json"))?)?;
    let encoded = public["address"]
        .as_str()
        .context("Missing supplier address")?
        .to_owned();
    let address = Address::decode(&NETWORK, &encoded).context("Supplier address is not testnet")?;
    let receiver = match &address {
        Address::Unified(ua) if ua.transparent().is_none() && ua.sapling().is_none() => {
            *ua.orchard().context("Missing Orchard receiver")?
        }
        _ => anyhow::bail!("Supplier must use a shielded-only Unified Address"),
    };
    Ok((encoded, address, receiver))
}

fn inspect(
    pczt: pczt::Pczt,
    fvk: &orchard::keys::FullViewingKey,
    receiver: &orchard::Address,
    fee: u64,
    spec: &PaymentSpec,
    target: BlockHeight,
) -> Result<pczt::Pczt> {
    ensure!(
        *pczt.global().tx_version() == 6
            && *pczt.global().version_group_id() == zcash_protocol::constants::V6_VERSION_GROUP_ID,
        "Unsupported transaction version"
    );
    ensure!(
        *pczt.global().consensus_branch_id() == u32::from(BranchId::for_height(&NETWORK, target)),
        "Transaction consensus branch mismatch"
    );
    ensure!(
        pczt.global().fallback_lock_time().unwrap_or(0) == 0,
        "Unexpected locktime"
    );
    ensure!(
        *pczt.global().expiry_height() > u32::from(target)
            && *pczt.global().expiry_height() <= u32::from(target) + 120,
        "Transaction expiry outside signer policy"
    );
    ensure!(
        pczt.transparent().inputs().is_empty() && pczt.transparent().outputs().is_empty(),
        "Transparent inputs or outputs rejected"
    );
    ensure!(
        pczt.sapling().spends().is_empty()
            && pczt.sapling().outputs().is_empty()
            && pczt.orchard().actions().is_empty(),
        "Only Ironwood is supported by this integration"
    );
    ensure!(
        !pczt.ironwood().actions().is_empty(),
        "Missing Ironwood bundle"
    );
    ensure!(
        fee > 0 && fee <= spec.max_fee,
        "Fee exceeds the test payment limit"
    );
    ensure!(
        *pczt.ironwood().value_sum() == (fee, false),
        "Bundle balance does not match fee"
    );
    ensure!(
        pczt.ironwood().actions().len() <= spec.max_actions as usize,
        "Transaction action cap exceeded"
    );
    let mut outputs = Vec::new();
    for action in pczt.ironwood().actions() {
        ensure!(
            action.spend().dummy_sk().is_none(),
            "Unfinalized dummy key rejected"
        );
        let output = action.output();
        let value = output.value().context("Missing output value")?;
        if value == 0 {
            continue;
        }
        let to = orchard::Address::from_raw_address_bytes(
            output.recipient().as_ref().context("Missing receiver")?,
        )
        .into_option()
        .context("Invalid receiver")?;
        outputs.push((to, value));
    }
    validate_outputs_for(&outputs, fvk, receiver, spec.amount)?;
    let verified = pczt::roles::verifier::Verifier::new(pczt)
        .with_ironwood::<&str, _>(|bundle| {
            bundle.verify_cross_address_restriction()?;
            for action in bundle.actions() {
                action.verify_cv_net()?;
                action.spend().verify_nullifier(Some(fvk))?;
                action.spend().verify_rk(Some(fvk))?;
                action.output().verify_note_commitment(action.spend())?;
                let value = action.output().value().as_ref().map(|v| v.inner()).ok_or(
                    pczt::roles::verifier::OrchardError::Custom("Missing output value"),
                )?;
                if value > 0 {
                    let (note, address, memo) = action
                        .recover_output_with_ovk(
                            &fvk.to_ovk(zip32::Scope::External),
                            *bundle.bundle_version(),
                        )
                        .map_err(|_| {
                            pczt::roles::verifier::OrchardError::Custom(
                                "Unsupported note encryption version",
                            )
                        })?
                        .or_else(|| {
                            action
                                .decrypt_output_with_ivk(
                                    &orchard::keys::PreparedIncomingViewingKey::new(
                                        &fvk.to_ivk(zip32::Scope::Internal),
                                    ),
                                    *bundle.bundle_version(),
                                )
                                .ok()
                                .flatten()
                        })
                        .ok_or(pczt::roles::verifier::OrchardError::Custom(
                            "Cannot decrypt a value-bearing output before signing",
                        ))?;
                    if note.value().inner() != value
                        || action.output().recipient().as_ref() != Some(&address)
                    {
                        return Err(pczt::roles::verifier::OrchardError::Custom(
                            "Encrypted output differs from inspected metadata",
                        ));
                    }
                    if &address == receiver
                        && MemoBytes::from_bytes(&memo).ok()
                            != MemoBytes::from_bytes(spec.memo.as_bytes()).ok()
                    {
                        return Err(pczt::roles::verifier::OrchardError::Custom(
                            "Encrypted supplier memo differs from approved binding",
                        ));
                    }
                }
            }
            Ok(())
        })
        .map_err(|e| anyhow::anyhow!("PCZT consistency check failed: {e:?}"))?;
    Ok(verified.finish())
}

fn validate_outputs_for(
    outputs: &[(orchard::Address, u64)],
    fvk: &orchard::keys::FullViewingKey,
    receiver: &orchard::Address,
    expected_amount: u64,
) -> Result<()> {
    let mut recipients = 0;
    for (to, value) in outputs {
        if *value == 0 {
            continue;
        }
        if to == receiver {
            ensure!(
                *value == expected_amount,
                "Supplier amount differs from approved test payment"
            );
            recipients += 1;
        } else {
            ensure!(
                fvk.scope_for_address(to) == Some(zip32::Scope::Internal),
                "Unexpected output or unowned change"
            );
        }
    }
    ensure!(recipients == 1, "Expected exactly one supplier payment");
    Ok(())
}

pub fn prepare(root: &Path) -> Result<()> {
    prepare_with(root, &root.join("payment-001"), &legacy_spec(root)?, || {
        Ok(())
    })?;
    Ok(())
}

pub fn prepare_with(
    root: &Path,
    dir: &Path,
    spec: &PaymentSpec,
    mut before_sign: impl FnMut() -> Result<()>,
) -> Result<Outbox> {
    ensure!(
        !dir.exists(),
        "A test payment is already reserved. Use recover or broadcast; never prepare a replacement blindly."
    );
    let mut db = wallet::open(&root.join("operating"))?;
    let account = db
        .get_account_ids()?
        .into_iter()
        .next()
        .context("No operating account")?;
    let summary = db
        .get_wallet_summary(ConfirmationsPolicy::MIN)?
        .context("Sync before preparing")?;
    ensure!(summary.is_synced(), "Wallet must be fully synced");
    let encoded = spec.recipient.clone();
    let to = Address::decode(&NETWORK, &encoded).context("Invalid approved destination")?;
    let receiver = crate::policy::receiver(&encoded)?;
    let memo = MemoBytes::from_bytes(spec.memo.as_bytes())?;
    let proposal = propose_standard_transfer_to_address::<_, _, Infallible>(
        &mut db,
        &NETWORK,
        StandardFeeRule::Zip317,
        account,
        ConfirmationsPolicy::MIN,
        &to,
        Zatoshis::from_u64(spec.amount)?,
        Some(memo),
        None,
        ShieldedPool::Ironwood,
        None,
        None,
    )
    .map_err(|e| anyhow::anyhow!("Proposal failed: {e:?}"))?;
    ensure!(
        proposal.steps().len() == 1,
        "Multi-step proposals are not supported"
    );
    let fee = u64::from(proposal.steps().head.balance().fee_required());
    let target = BlockHeight::from(proposal.min_target_height());
    let pczt = create_pczt_from_proposal::<_, _, Infallible, _, Infallible, _>(
        &mut db,
        &NETWORK,
        &zcash_client_sqlite::util::SystemClock,
        &mut wallet::rng(),
        account,
        OvkPolicy::Sender,
        &proposal,
        Some(target + 120),
        BundlePadding::DEFAULT,
    )
    .map_err(|e| anyhow::anyhow!("PCZT creation failed: {e:?}"))?;
    let seed = SecretVec::new(fs::read(root.join("operating/seed.bin"))?);
    let usk = UnifiedSpendingKey::from_seed(&NETWORK, seed.expose_secret(), zip32::AccountId::ZERO)
        .map_err(|_| anyhow::anyhow!("Could not derive testnet spending key"))?;
    let fvk = orchard::keys::FullViewingKey::from(usk.orchard());
    let pczt = inspect(pczt, &fvk, &receiver, fee, spec, target)?;
    wallet::private_dir(dir)?;
    let intent = serde_json::json!({"recipient":encoded,"amount_zatoshis":spec.amount,"fee_zatoshis":fee,"memo":spec.memo});
    wallet::write_new(
        &dir.join("intent.json"),
        &serde_json::to_vec_pretty(&intent)?,
    )?;
    eprintln!("Creating the Ironwood proof...");
    let prover = pczt::roles::prover::Prover::new(pczt);
    let proved = prover
        .create_ironwood_proof(
            wallet::rng(),
            cached_orchard_proving_key(orchard::circuit::OrchardCircuitVersion::PostNu6_3),
        )
        .map_err(|e| anyhow::anyhow!("Ironwood proving failed: {e:?}"))?
        .finish();
    // Recheck authorization only after proving and immediately before signing.
    let proved = inspect(proved, &fvk, &receiver, fee, spec, target)?;
    before_sign()?;
    let indices: Vec<_> = proved
        .ironwood()
        .actions()
        .iter()
        .enumerate()
        .filter(|(_, a)| a.spend().spend_auth_sig().is_none())
        .map(|(i, _)| i)
        .collect();
    let mut signer = pczt::roles::signer::Signer::new(proved)
        .map_err(|e| anyhow::anyhow!("Signer initialization failed: {e:?}"))?;
    let ask = orchard::keys::SpendAuthorizingKey::from(usk.orchard());
    for index in indices {
        signer
            .sign_ironwood(wallet::rng(), index, &ask)
            .map_err(|e| anyhow::anyhow!("Signing failed: {e:?}"))?;
    }
    let signed = signer
        .finish()
        .serialize()
        .map_err(|e| anyhow::anyhow!("PCZT serialization failed: {e:?}"))?;
    wallet::write_new(&dir.join("signed.pczt"), &signed)?;
    drop(db);
    recover_with(root, dir, spec)
}

pub fn recover(root: &Path) -> Result<()> {
    recover_with(root, &root.join("payment-001"), &legacy_spec(root)?)?;
    Ok(())
}

pub fn recover_with(root: &Path, dir: &Path, spec: &PaymentSpec) -> Result<Outbox> {
    if dir.join("outbox.json").exists() {
        let record = read_outbox_with(root, dir, spec)?;
        println!("Persisted transaction ready: {}", record.txid);
        return Ok(record);
    }
    let intent: serde_json::Value = serde_json::from_slice(&fs::read(dir.join("intent.json"))?)?;
    let bytes = fs::read(dir.join("signed.pczt")).context(
        "No durable signed PCZT. This reservation needs operator review; no replacement was built.",
    )?;
    let signed = pczt::Pczt::parse(&bytes)
        .map_err(|e| anyhow::anyhow!("Stored PCZT parse failed: {e:?}"))?;
    let branch = *signed.global().consensus_branch_id();
    let mut db = wallet::open(&root.join("operating"))?;
    let txid = extract_and_store_transaction_from_pczt::<wallet::Db, Infallible>(
        &mut db,
        &zcash_client_sqlite::util::SystemClock,
        &mut wallet::rng(),
        signed,
        None,
        None,
    )
    .map_err(|e| anyhow::anyhow!("PCZT extraction failed: {e:?}"))?;
    let tx = db
        .get_transaction(txid)?
        .context("Missing stored transaction")?;
    verify_local_receipt(root, &tx, spec)?;
    let mut raw = Vec::new();
    tx.write(&mut raw)?;
    let record = Outbox {
        network: "testnet".into(),
        txid: txid.to_string(),
        sha256: hex::encode(Sha256::digest(&raw)),
        raw_hex: hex::encode(raw),
        expiry_height: u32::from(tx.expiry_height()),
        branch,
        recipient: intent["recipient"]
            .as_str()
            .context("Missing intent recipient")?
            .into(),
        amount_zatoshis: spec.amount,
        fee_zatoshis: intent["fee_zatoshis"]
            .as_u64()
            .context("Missing intent fee")?,
    };
    wallet::write_new(
        &dir.join("outbox.json"),
        &serde_json::to_vec_pretty(&record)?,
    )?;
    println!(
        "Signed transaction persisted, not broadcast: {}",
        record.txid
    );
    Ok(record)
}

fn verify_local_receipt(root: &Path, tx: &Transaction, spec: &PaymentSpec) -> Result<()> {
    ensure!(
        tx.transparent_bundle().is_none()
            && tx.sapling_bundle().is_none()
            && tx.orchard_bundle().is_none()
            && tx.ironwood_bundle().is_some(),
        "Unexpected final transaction pools"
    );
    let db = wallet::open(&root.join("operating"))?;
    let keys = db.get_unified_full_viewing_keys()?;
    let decrypted =
        zcash_client_backend::decrypt_transaction(&NETWORK, None, db.chain_height()?, tx, &keys);
    let receiver = crate::policy::receiver(&spec.recipient)?;
    let outputs: Vec<_> = decrypted
        .ironwood_outputs()
        .iter()
        .filter(|o| o.note().0.recipient() == receiver && o.note().0.value().inner() > 0)
        .collect();
    ensure!(
        outputs.len() == 1
            && outputs[0].note().0.value().inner() == spec.amount
            && outputs[0].memo() == &MemoBytes::from_bytes(spec.memo.as_bytes())?,
        "Final payment receiver, amount or memo differs from authorization"
    );
    ensure!(
        tx.ironwood_bundle()
            .context("Missing Ironwood bundle")?
            .actions()
            .len()
            <= spec.max_actions as usize,
        "Final action count exceeds authorization"
    );

    Ok(())
}

pub fn read_outbox_with(root: &Path, dir: &Path, spec: &PaymentSpec) -> Result<Outbox> {
    let record: Outbox = serde_json::from_slice(&fs::read(dir.join("outbox.json"))?)?;
    ensure!(
        record.network == "testnet"
            && record.amount_zatoshis == spec.amount
            && record.recipient == spec.recipient
            && record.fee_zatoshis <= spec.max_fee,
        "Outbox intent mismatch"
    );
    let raw = hex::decode(&record.raw_hex)?;
    ensure!(
        hex::encode(Sha256::digest(&raw)) == record.sha256,
        "Outbox bytes failed checksum verification"
    );
    let tx = Transaction::read(
        raw.as_slice(),
        BranchId::try_from(record.branch).map_err(|e| anyhow::anyhow!(e))?,
    )?;
    ensure!(
        tx.txid().to_string() == record.txid
            && u32::from(tx.expiry_height()) == record.expiry_height,
        "Outbox transaction identity mismatch"
    );
    verify_local_receipt(root, &tx, spec)?;
    Ok(record)
}

pub async fn broadcast(root: &Path) -> Result<()> {
    broadcast_with(root, &root.join("payment-001"), &legacy_spec(root)?).await
}

pub async fn broadcast_with(root: &Path, dir: &Path, spec: &PaymentSpec) -> Result<()> {
    let record = read_outbox_with(root, dir, spec)?;
    let mut client = wallet::connect().await?;
    let tip = client
        .get_latest_block(ChainSpec {})
        .await?
        .into_inner()
        .height;
    ensure!(
        record.expiry_height > 0 && tip < u64::from(record.expiry_height),
        "Transaction expired; reconcile first. Automatic replacement is disabled."
    );
    let raw = hex::decode(&record.raw_hex)?;
    let response = client
        .send_transaction(RawTransaction {
            data: raw,
            height: 0,
        })
        .await?
        .into_inner();
    ensure!(
        response.error_code == 0,
        "Submission returned {}: {}. Check the transaction before any retry.",
        response.error_code,
        response.error_message
    );
    let receipt = dir.join("submitted.json");
    if !receipt.exists() {
        wallet::write_new(
            &receipt,
            &serde_json::to_vec_pretty(
                &serde_json::json!({"txid":record.txid,"accepted_by":wallet::SERVER,"status":"submitted, not yet confirmed"}),
            )?,
        )?;
    }
    println!("Submitted the persisted transaction: {}", record.txid);
    Ok(())
}

pub async fn verify(root: &Path) -> Result<()> {
    verify_with(root, &root.join("payment-001"), &legacy_spec(root)?).await?;
    Ok(())
}

// Signer reconciliation needs only its own wallet. The supplier independently
// decides service access using its separately stored recipient wallet.
pub async fn observe_with(
    root: &Path,
    dir: &Path,
    spec: &PaymentSpec,
) -> Result<serde_json::Value> {
    let record = read_outbox_with(root, dir, spec)?;
    let id = crate::receipt::transaction_id(&record.txid)?;
    wallet::sync(&root.join("operating")).await?;
    let db = wallet::open(&root.join("operating"))?;
    let mined = db
        .get_tx_height(id)?
        .context("Signer has not scanned a mined payment")?;
    let mut client = wallet::connect().await?;
    let response = client
        .get_transaction(TxFilter {
            hash: id.as_ref().to_vec(),
            ..Default::default()
        })
        .await?
        .into_inner();
    ensure!(
        response.height == u64::from(u32::from(mined))
            && response.data == hex::decode(&record.raw_hex)?,
        "Mined transaction differs from retained artifact or scan"
    );
    let tip = db.chain_height()?.context("Missing signer chain tip")?;
    let confirmations = u32::from(tip)
        .checked_sub(u32::from(mined))
        .context("Signer behind payment")?
        + 1;
    let evidence = serde_json::json!({"network":"testnet","txid":record.txid,"raw_sha256":record.sha256,"mined_height":u32::from(mined),"verified_tip":u32::from(tip),"confirmations":confirmations,"verification":"signer scan and full mined bytes match retained payment; supplier entitlement is separate"});
    let path = dir.join(format!("signer-observed-at-{}.json", u32::from(tip)));
    if !path.exists() {
        wallet::write_new(&path, &serde_json::to_vec_pretty(&evidence)?)?;
    }
    Ok(evidence)
}

pub async fn verify_with(root: &Path, dir: &Path, spec: &PaymentSpec) -> Result<serde_json::Value> {
    let record = read_outbox_with(root, dir, spec)?;
    let raw = hex::decode(&record.raw_hex)?;
    let expected = Transaction::read(
        raw.as_slice(),
        BranchId::try_from(record.branch).map_err(|e| anyhow::anyhow!(e))?,
    )?;
    let mut client = wallet::connect().await?;
    let response = client
        .get_transaction(TxFilter {
            hash: expected.txid().as_ref().to_vec(),
            ..Default::default()
        })
        .await?
        .into_inner();
    ensure!(
        response.height > 0 && response.height < u64::from(u32::MAX),
        "Payment is not mined yet"
    );
    ensure!(
        response.data == raw,
        "Mined transaction bytes differ from persisted bytes"
    );
    wallet::sync(&root.join("supplier")).await?;
    let mut db = wallet::open(&root.join("supplier"))?;
    let mined = BlockHeight::from_u32(u32::try_from(response.height)?);
    decrypt_and_store_transaction(&NETWORK, &mut db, &expected, Some(mined))?;
    let tip = db.chain_height()?.context("Missing supplier chain tip")?;
    ensure!(tip >= mined, "Supplier has not synced past the mined block");
    let outputs =
        db.get_received_outputs(expected.txid(), (tip + 1).into(), ConfirmationsPolicy::MIN)?;
    ensure!(
        outputs.len() == 1
            && outputs[0].pool_type() == PoolType::Shielded(ShieldedPool::Ironwood)
            && u64::from(outputs[0].value()) == spec.amount,
        "Supplier received output mismatch"
    );
    let note = NoteId::new(
        expected.txid(),
        ShieldedPool::Ironwood,
        u16::try_from(outputs[0].output_index())?,
    );
    let memo = db.get_memo(note)?.context("Missing received memo")?;
    ensure!(
        memo == Memo::from_bytes(spec.memo.as_bytes())?,
        "Supplier memo mismatch"
    );
    let confirmations = u32::from(tip) - u32::from(mined) + 1;
    ensure!(confirmations >= 1, "At least one confirmation is required");
    let evidence = serde_json::json!({"network":"testnet","txid":record.txid,"raw_sha256":record.sha256,"mined_height":u32::from(mined),"verified_tip":u32::from(tip),"confirmations":confirmations,"pool":"ironwood","transparent_inputs":0,"transparent_outputs":0,"supplier_amount_zatoshis":spec.amount,"supplier_memo":spec.memo,"verification":"full bytes matched; separate supplier wallet decrypted amount and memo"});
    let file = dir.join(format!("verified-at-{}.json", u32::from(tip)));
    if !file.exists() {
        wallet::write_new(&file, &serde_json::to_vec_pretty(&evidence)?)?;
    }
    println!("{}", serde_json::to_string_pretty(&evidence)?);
    Ok(evidence)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn keys(byte: u8) -> orchard::keys::FullViewingKey {
        let usk =
            UnifiedSpendingKey::from_seed(&NETWORK, &[byte; 64], zip32::AccountId::ZERO).unwrap();
        orchard::keys::FullViewingKey::from(usk.orchard())
    }
    #[test]
    fn rejects_redirected_change_even_when_supplier_is_paid() {
        let ours = keys(1);
        let supplier = keys(2).address_at(0u32, zip32::Scope::External);
        let stolen = keys(3).address_at(0u32, zip32::Scope::Internal);
        assert!(
            validate_outputs_for(
                &[(supplier, AMOUNT), (stolen, 500_000)],
                &ours,
                &supplier,
                AMOUNT
            )
            .is_err()
        );
        let change = ours.address_at(0u32, zip32::Scope::Internal);
        assert!(
            validate_outputs_for(
                &[(supplier, AMOUNT), (change, 500_000)],
                &ours,
                &supplier,
                AMOUNT
            )
            .is_ok()
        );
    }
    #[test]
    fn rejects_missing_duplicate_split_and_overpaid_supplier_outputs() {
        let ours = keys(1);
        let supplier = keys(2).address_at(0u32, zip32::Scope::External);
        for outputs in [
            vec![],
            vec![(supplier, AMOUNT), (supplier, AMOUNT)],
            vec![(supplier, AMOUNT / 2), (supplier, AMOUNT / 2)],
            vec![(supplier, AMOUNT + 1)],
        ] {
            assert!(validate_outputs_for(&outputs, &ours, &supplier, AMOUNT).is_err());
        }
    }
    #[test]
    fn excludes_external_self_payment_from_change() {
        let ours = keys(1);
        let supplier = keys(2).address_at(0u32, zip32::Scope::External);
        let external = ours.address_at(1u32, zip32::Scope::External);
        assert!(
            validate_outputs_for(
                &[(supplier, AMOUNT), (external, 1)],
                &ours,
                &supplier,
                AMOUNT
            )
            .is_err()
        );
    }
}
