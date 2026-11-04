use crate::{
    ledger::{Ledger, Occurrence},
    payment::{self, PaymentSpec},
    policy::{self, Envelope, Invoice, Trust},
    wallet,
};
use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use std::{
    fs::{self, OpenOptions},
    os::unix::fs::OpenOptionsExt,
    path::Path,
};

pub fn ledger(root: &Path) -> Result<Ledger> {
    let trust: Trust = policy::decode(&fs::read(root.join("trust.json"))?)?;
    Ledger::open(&root.join("agreements.sqlite"), trust)
}

fn spec(l: &Ledger, row: &Occurrence) -> Result<PaymentSpec> {
    let a = l.agreement(&row.agreement_id)?;
    Ok(PaymentSpec {
        recipient: a.recipient,
        amount: policy::amount(&a.amount_zatoshis)?,
        memo: row.memo.clone(),
        max_fee: policy::amount(&a.max_fee_zatoshis)?,
        max_actions: a.max_actions,
    })
}

pub fn response(row: &Occurrence) -> serde_json::Value {
    serde_json::json!({"payment_id":row.id,"state":row.state,"txid":row.txid})
}

pub async fn execute(
    root: &Path,
    invoice: &Envelope<Invoice>,
    release: bool,
) -> Result<Occurrence> {
    let mut l = ledger(root)?;
    audit_artifacts(root, &l)?;
    let row = l.reserve(invoice, policy::now()?)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(root.join("wallet.lock"))?;
    lock.try_lock_exclusive()
        .context("Wallet worker busy; retry this same invoice")?;
    let row = l.get(&row.id)?;
    if row.state == "confirmed" || row.state == "broadcast_unknown" {
        return Ok(row);
    }
    ensure!(
        !l.has_unresolved_other(&row.id)?,
        "Another occurrence requires recovery before signing can continue"
    );
    let spec = spec(&l, &row)?;
    let parent = root.join("occurrences");
    wallet::private_dir(&parent)?;
    let dir = parent.join(&row.id);
    if row.state == "reserved" {
        ensure!(
            !dir.exists(),
            "Interrupted preparation requires operator review; reservation retained"
        );
        wallet::sync(&root.join("operating")).await?;
        let outbox = payment::prepare_with(root, &dir, &spec, || {
            l.authorize_signing(&row.id, policy::now()?)
        })?;
        l.durable(&row.id, &outbox.txid, &outbox.sha256)?;
    } else if row.state == "signing" {
        let outbox = payment::recover_with(root, &dir, &spec)?;
        l.durable(&row.id, &outbox.txid, &outbox.sha256)?;
    }
    let outbox = payment::read_outbox_with(root, &dir, &spec)?;
    ensure!(
        outbox.sha256 == l.expected_hash(&row.id)?,
        "Outbox does not match the authoritative ledger"
    );
    if !release {
        return l.get(&row.id);
    }
    l.broadcast_unknown(&row.id)?;
    payment::broadcast_with(root, &dir, &spec).await?;
    l.get(&row.id)
}

pub async fn rebroadcast(root: &Path, id: &str) -> Result<Occurrence> {
    let mut l = ledger(root)?;
    let row = l.get(id)?;
    ensure!(
        row.state == "broadcast_unknown" || row.state == "signed_durable",
        "Only retained submitted/durable artifacts can be retried"
    );
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.join("wallet.lock"))?;
    lock.try_lock_exclusive().context("Wallet worker busy")?;
    let spec = spec(&l, &row)?;
    let dir = root.join("occurrences").join(id);
    ensure!(
        payment::read_outbox_with(root, &dir, &spec)?.sha256 == l.expected_hash(id)?,
        "Artifact hash mismatch"
    );
    l.broadcast_unknown(id)?;
    payment::broadcast_with(root, &dir, &spec).await?;
    l.get(id)
}

fn audit_artifacts(root: &Path, ledger: &Ledger) -> Result<()> {
    let dir = root.join("occurrences");
    for id in ledger.durable_ids()? {
        ensure!(
            dir.join(id).join("outbox.json").is_file(),
            "Ledger references a missing artifact directory or outbox; signing halted"
        );
    }
    if !dir.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let id = name.to_str().context("Invalid recovery entry")?;
        ensure!(
            id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()),
            "Unknown artifact directory requires operator review"
        );
        let row = ledger
            .get(id)
            .context("Artifact has no authoritative occurrence; possible stale ledger restore")?;
        ensure!(
            !(row.state == "reserved" && entry.path().join("signed.pczt").exists()),
            "Signed artifact is ahead of the ledger; signing halted"
        );
        if matches!(
            row.state.as_str(),
            "signed_durable" | "broadcast_unknown" | "confirmed"
        ) {
            let bytes = fs::read(entry.path().join("outbox.json"))
                .context("Ledger references a missing outbox")?;
            let outbox: serde_json::Value = serde_json::from_slice(&bytes)?;
            ensure!(
                outbox["sha256"].as_str() == Some(&ledger.expected_hash(id)?),
                "Artifact metadata differs from ledger"
            );
            use sha2::{Digest, Sha256};
            let raw = hex::decode(
                outbox["raw_hex"]
                    .as_str()
                    .context("Missing retained transaction bytes")?,
            )?;
            ensure!(
                hex::encode(Sha256::digest(raw)) == ledger.expected_hash(id)?,
                "Retained transaction bytes differ from ledger"
            );
        }
    }
    Ok(())
}

pub async fn reconcile(root: &Path, id: &str) -> Result<serde_json::Value> {
    let mut l = ledger(root)?;
    let row = l.get(id)?;
    ensure!(
        row.state == "broadcast_unknown" || row.state == "confirmed",
        "Occurrence is not submitted"
    );
    let spec = spec(&l, &row)?;
    let dir = root.join("occurrences").join(&row.id);
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.join("wallet.lock"))?;
    lock.try_lock_exclusive().context("Wallet worker busy")?;
    ensure!(
        payment::read_outbox_with(root, &dir, &spec)?.sha256 == l.expected_hash(id)?,
        "Artifact hash mismatch"
    );
    let receipt = match payment::observe_with(root, &dir, &spec).await {
        Ok(receipt) => receipt,
        Err(error) => {
            l.unconfirm(id)?;
            return Err(error);
        }
    };
    l.confirmed(id)?;
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_audit_detects_missing_directories_or_changed_raw_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let (trust, a, key) = policy::tests::fixture();
        let mut ledger = Ledger::open(&dir.path().join("ledger.sqlite"), trust).unwrap();
        ledger.install(&a).unwrap();
        let i = policy::tests::invoice(&a.payload, &key, 1001, "one");
        let row = ledger.reserve(&i, 1001).unwrap();
        ledger.authorize_signing(&row.id, 1001).unwrap();
        use sha2::{Digest, Sha256};
        let hash = hex::encode(Sha256::digest([1u8]));
        ledger.durable(&row.id, "test-tx", &hash).unwrap();
        assert!(audit_artifacts(dir.path(), &ledger).is_err());
        let artifact = dir.path().join("occurrences").join(&row.id);
        fs::create_dir_all(&artifact).unwrap();
        fs::write(
            artifact.join("outbox.json"),
            serde_json::to_vec(&serde_json::json!({"sha256":hash,"raw_hex":"02"})).unwrap(),
        )
        .unwrap();
        assert!(audit_artifacts(dir.path(), &ledger).is_err());
        fs::write(
            artifact.join("outbox.json"),
            serde_json::to_vec(&serde_json::json!({"sha256":hash,"raw_hex":"01"})).unwrap(),
        )
        .unwrap();
        assert!(audit_artifacts(dir.path(), &ledger).is_ok());
    }
}
