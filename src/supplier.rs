use crate::{
    billing,
    policy::{self, Agreement, Envelope, Invoice, Revocation, Trust},
    receipt::{self, Receipt},
    wallet,
};
use anyhow::{Context, Result, ensure};
use clap::Subcommand;
use ed25519_dalek::SigningKey;
use fs2::FileExt;
use rand::Rng;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    io::Read,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    time::Duration,
};
use zeroize::Zeroizing;

#[derive(Subcommand)]
pub enum Command {
    InitWallet,
    DocumentExisting,
    Configure {
        #[arg(long)]
        agreement: PathBuf,
        #[arg(long)]
        trust: PathBuf,
        #[arg(long, default_value_t = 2)]
        confirmations: u32,
    },
    Revoke {
        #[arg(long)]
        revocation: PathBuf,
    },
    Rpc,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    trust: Trust,
    agreement: Envelope<Agreement>,
    confirmations: u32,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Action {
    Overview {},
    Billing { before: Option<u64> },
    BillingInvoice { invoice_id: String },
    Invoice {},
    Settle { invoice_id: String, txid: String },
    Access { invoice_id: String },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Issued {
    pub(crate) envelope: Envelope<Invoice>,
    pub(crate) period_start: u64,
    pub(crate) service_until: u64,
    pub(crate) payment_memo: String,
}

struct Store {
    db: Connection,
    config: Config,
}

impl Store {
    fn open(root: &Path) -> Result<Self> {
        let config: Config = policy::decode(&fs::read(root.join("config.json"))?)?;
        config.agreement.payload.validate(&config.trust)?;
        policy::verify(
            policy::AGREEMENT_DOMAIN,
            &config.agreement,
            &config.trust.approvers,
        )?;
        ensure!(
            (1..=100).contains(&config.confirmations),
            "Invalid confirmation policy"
        );
        let db = Connection::open(root.join("supplier.sqlite"))?;
        db.busy_timeout(Duration::from_secs(5))?;
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.pragma_update(None, "synchronous", "FULL")?;
        db.pragma_update(None, "foreign_keys", "ON")?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1),config TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,sequence INTEGER NOT NULL DEFAULT 0,revocation_digest TEXT);
          CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY,period TEXT NOT NULL UNIQUE,issued TEXT NOT NULL,txid TEXT UNIQUE,receipt TEXT,verified INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0,1)));")?;
        billing::init(&db)?;
        let encoded = serde_jcs::to_string(&config)?;
        db.execute(
            "INSERT OR IGNORE INTO identity(singleton,config) VALUES(1,?1)",
            [&encoded],
        )?;
        let pinned: String =
            db.query_row("SELECT config FROM identity WHERE singleton=1", [], |r| {
                r.get(0)
            })?;
        ensure!(
            encoded == pinned,
            "Supplier configuration differs from pinned identity"
        );
        Ok(Self { db, config })
    }

    fn issue(&mut self, key: &SigningKey, now: u64) -> Result<Issued> {
        let a = &self.config.agreement.payload;
        ensure!(
            hex::encode(key.verifying_key().to_bytes()) == a.supplier_key,
            "Wrong supplier signing key"
        );
        ensure!(
            now >= a.valid_from && now < a.expires_at,
            "Agreement outside validity window"
        );
        let period = a.schedule.period(now)?;
        let transaction = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let revoked: bool =
            transaction.query_row("SELECT revoked FROM identity WHERE singleton=1", [], |r| {
                r.get(0)
            })?;
        ensure!(!revoked, "Agreement is revoked");
        let old: Option<String> = transaction
            .query_row(
                "SELECT issued FROM invoices WHERE period=?1",
                [&period.id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(old) = old {
            return policy::decode(old.as_bytes());
        }
        ensure!(
            now < period.window_end,
            "Payment window closed; wait for next period"
        );
        let mut nonce = [0u8; 32];
        wallet::rng().fill_bytes(&mut nonce);
        let payload = Invoice {
            schema: 1,
            context: a.context.clone(),
            agreement_id: a.agreement_id.clone(),
            agreement_version: a.version,
            agreement_digest: policy::digest(policy::AGREEMENT_DOMAIN, a)?,
            invoice_id: hex::encode(nonce),
            period_id: period.id.clone(),
            recipient: a.recipient.clone(),
            amount_zatoshis: a.amount_zatoshis.clone(),
            issued_at: now,
            expires_at: period.window_end.min(a.expires_at),
        };
        let issued = Issued {
            payment_memo: policy::invoice_memo(&payload)?,
            envelope: Envelope {
                signatures: vec![policy::sign(policy::INVOICE_DOMAIN, &payload, key)?],
                payload,
            },
            period_start: period.start,
            service_until: a.schedule.period_end(now)?.min(a.expires_at),
        };
        a.validate_invoice(&issued.envelope, now)?;
        transaction.execute(
            "INSERT INTO invoices(id,period,issued) VALUES(?1,?2,?3)",
            params![
                issued.envelope.payload.invoice_id,
                period.id,
                serde_jcs::to_string(&issued)?
            ],
        )?;
        billing::create(&transaction, &issued, a, key, now)?;
        transaction.commit()?;
        Ok(issued)
    }

    fn invoice(&self, id: &str) -> Result<Issued> {
        policy::identifier(id)?;
        let encoded: String = self
            .db
            .query_row("SELECT issued FROM invoices WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .context("Unknown supplier invoice")?;
        policy::decode(encoded.as_bytes())
    }

    fn pending(&self, id: &str) -> Result<()> {
        self.db
            .execute("UPDATE invoices SET verified=0 WHERE id=?1", [id])?;
        Ok(())
    }

    fn accept(&mut self, id: &str, receipt: &Receipt) -> Result<()> {
        let i = self.invoice(id)?;
        ensure!(
            receipt.memo == i.payment_memo
                && receipt.amount_zatoshis == i.envelope.payload.amount_zatoshis
                && receipt.confirmations >= self.config.confirmations,
            "Receipt does not satisfy invoice"
        );
        let transaction = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let old: Option<String> =
            transaction.query_row("SELECT txid FROM invoices WHERE id=?1", [id], |r| r.get(0))?;
        ensure!(
            old.as_ref().is_none_or(|x| x == &receipt.txid),
            "Invoice already bound to another transaction"
        );
        transaction.execute(
            "UPDATE invoices SET txid=?2,receipt=?3,verified=1 WHERE id=?1",
            params![id, receipt.txid, serde_json::to_string(receipt)?],
        )?;
        transaction.commit()?;
        Ok(())
    }

    fn entitlement(&self, id: &str, now: u64) -> Result<Issued> {
        let invoice = self.invoice(id)?;
        let verified: bool =
            self.db
                .query_row("SELECT verified FROM invoices WHERE id=?1", [id], |r| {
                    r.get(0)
                })?;
        ensure!(verified, "Payment not verified by supplier");
        ensure!(
            now >= invoice.period_start && now < invoice.service_until,
            "Paid service period expired"
        );
        Ok(invoice)
    }

    fn revoke(&mut self, envelope: &Envelope<Revocation>) -> Result<()> {
        policy::verify(
            policy::REVOKE_DOMAIN,
            envelope,
            std::slice::from_ref(&self.config.trust.revoker),
        )?;
        let r = &envelope.payload;
        let a = &self.config.agreement.payload;
        ensure!(
            r.schema == 1
                && r.context == a.context
                && r.agreement_id == a.agreement_id
                && r.agreement_digest == policy::digest(policy::AGREEMENT_DOMAIN, a)?
                && r.sequence > 0,
            "Revocation binding mismatch"
        );
        let digest = policy::digest(policy::REVOKE_DOMAIN, r)?;
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (seq, prior): (u32, Option<String>) = tx.query_row(
            "SELECT sequence,revocation_digest FROM identity WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        ensure!(
            r.sequence > seq || (r.sequence == seq && prior.as_ref() == Some(&digest)),
            "Stale or conflicting revocation"
        );
        tx.execute(
            "UPDATE identity SET revoked=1,sequence=?1,revocation_digest=?2 WHERE singleton=1",
            params![r.sequence, digest],
        )?;
        tx.commit()?;
        Ok(())
    }

    fn overview(&self) -> Result<Value> {
        let revoked: bool =
            self.db
                .query_row("SELECT revoked FROM identity WHERE singleton=1", [], |r| {
                    r.get(0)
                })?;
        let mut statement = self.db.prepare(
            "SELECT issued,txid,receipt,verified FROM invoices ORDER BY rowid DESC LIMIT 20",
        )?;
        let rows = statement.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, bool>(3)?,
            ))
        })?;
        let mut invoices = Vec::new();
        for row in rows {
            let (issued, txid, receipt, verified) = row?;
            invoices.push(json!({"invoice":serde_json::from_str::<Value>(&issued)?,"txid":txid,"receipt":receipt.map(|r|serde_json::from_str::<Value>(&r)).transpose()?,"last_observation_verified":verified}));
        }
        Ok(
            json!({"agreement":self.config.agreement,"revoked":revoked,"required_confirmations":self.config.confirmations,"invoices":invoices,"service":"zcash-testnet-telemetry","observations_are_cached":true}),
        )
    }
}

fn key(root: &Path) -> Result<SigningKey> {
    let bytes = Zeroizing::new(fs::read(root.join("invoice-signing.key"))?);
    ensure!(bytes.len() == 32, "Invalid supplier signing key");
    Ok(SigningKey::from_bytes(bytes.as_slice().try_into()?))
}

async fn verify(root: &Path, store: &mut Store, id: &str, txid: &str) -> Result<Receipt> {
    let i = store.invoice(id)?;
    // Commit uncertainty first. Any timeout, crash, scan failure or reorg cannot
    // leave an old observation sufficient to grant access.
    billing::claim(&store.db, id, txid, policy::now()?)?;
    store.pending(id)?;
    let evidence = receipt::received(
        &root.join("wallet"),
        txid,
        policy::amount(&i.envelope.payload.amount_zatoshis)?,
        &i.payment_memo,
        store.config.confirmations,
    )
    .await;
    let evidence = match evidence {
        Ok(value) => value,
        Err(error) => {
            billing::claim_error(&store.db, id, &error.to_string())?;
            return Err(error);
        }
    };
    store.accept(id, &evidence)?;
    Ok(evidence)
}

async fn rpc(root: &Path, action: Action) -> Result<Value> {
    let mut store = Store::open(root)?;
    match action {
        Action::Overview {} => store.overview(),
        Action::Billing { before } => billing::list(
            &store.db,
            &store.config.agreement.payload,
            before,
            policy::now()?,
        ),
        Action::BillingInvoice { invoice_id } => billing::detail(
            &store.db,
            &store.config.agreement.payload,
            &invoice_id,
            policy::now()?,
        ),
        Action::Invoice {} => Ok(serde_json::to_value(
            store.issue(&key(root)?, policy::now()?)?,
        )?),
        Action::Settle { invoice_id, txid } => Ok(
            json!({"invoice_id":invoice_id,"receipt":verify(root,&mut store,&invoice_id,&txid).await?,"entitlement_active":store.entitlement(&invoice_id,policy::now()?).is_ok()}),
        ),
        Action::Access { invoice_id } => {
            let i = store.invoice(&invoice_id)?;
            ensure!(
                policy::now()? < i.service_until,
                "Paid service period expired"
            );
            let txid: Option<String> = store.db.query_row(
                "SELECT txid FROM invoices WHERE id=?1",
                [&invoice_id],
                |r| r.get(0),
            )?;
            let evidence = verify(
                root,
                &mut store,
                &invoice_id,
                &txid.context("Payment required")?,
            )
            .await?;
            let i = store.entitlement(&invoice_id, policy::now()?)?;
            Ok(
                json!({"service":"zcash-testnet-telemetry","invoice_id":invoice_id,"access_until":i.service_until,"data":{"network":"testnet","height":evidence.verified_tip,"consensus_branch":evidence.consensus_branch,"latest_block_time":evidence.latest_block_time,"observed_at":evidence.observed_at,"source":wallet::SERVER},"receipt":evidence}),
            )
        }
    }
}

pub async fn execute(root: &Path, value: Value) -> Result<Value> {
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(root.join("supplier.lock"))?;
    lock.try_lock_exclusive()
        .context("Supplier is processing another operation")?;
    rpc(root, policy::decode(&serde_json::to_vec(&value)?)?).await
}

pub async fn run(root: &Path, command: &Command) -> Result<()> {
    wallet::private_dir(root)?;
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(root.join("supplier.lock"))?;
    lock.try_lock_exclusive()
        .context("Supplier worker busy; retry")?;
    match command {
        Command::DocumentExisting => {
            let mut store = Store::open(root)?;
            let signing_key = key(root)?;
            let a = store.config.agreement.payload.clone();
            let tx = store
                .db
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            let issued = {
                let mut q = tx.prepare("SELECT issued FROM invoices ORDER BY rowid")?;
                q.query_map([], |r| r.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?
            };
            for encoded in &issued {
                billing::create(
                    &tx,
                    &policy::decode(encoded.as_bytes())?,
                    &a,
                    &signing_key,
                    policy::now()?,
                )?;
            }
            tx.commit()?;
            println!("{}", json!({"documented_invoices":issued.len()}));
        }
        Command::InitWallet => {
            wallet::init(&root.join("wallet"), "supplier-service").await?;
            let mut bytes = Zeroizing::new([0u8; 32]);
            wallet::rng().fill_bytes(bytes.as_mut());
            wallet::write_new(&root.join("invoice-signing.key"), bytes.as_ref())?;
            println!(
                "{}",
                json!({"wallet":wallet::status(&root.join("wallet"))?,"supplier_key":hex::encode(SigningKey::from_bytes(&bytes).verifying_key().to_bytes())})
            );
        }
        Command::Configure {
            agreement,
            trust,
            confirmations,
        } => {
            let agreement: Envelope<Agreement> = policy::decode(&fs::read(agreement)?)?;
            let trust: Trust = policy::decode(&fs::read(trust)?)?;
            agreement.payload.validate(&trust)?;
            policy::verify(policy::AGREEMENT_DOMAIN, &agreement, &trust.approvers)?;
            ensure!(
                agreement.payload.supplier_key
                    == hex::encode(key(root)?.verifying_key().to_bytes()),
                "Agreement names another supplier key"
            );
            ensure!(
                wallet::status(&root.join("wallet"))?["address"] == agreement.payload.recipient,
                "Agreement does not pay this supplier wallet"
            );
            ensure!((1..=100).contains(confirmations), "Invalid confirmations");
            let config = Config {
                trust,
                agreement,
                confirmations: *confirmations,
            };
            wallet::write_new(
                &root.join("config.json"),
                &serde_json::to_vec_pretty(&config)?,
            )?;
            Store::open(root)?;
            println!("{}", json!({"configured":true}));
        }
        Command::Revoke { revocation } => {
            Store::open(root)?.revoke(&policy::decode(&fs::read(revocation)?)?)?;
            println!("{}", json!({"revoked":true}));
        }
        Command::Rpc => {
            let mut bytes = Vec::new();
            std::io::stdin().take(32769).read_to_end(&mut bytes)?;
            let result = match policy::decode::<Action>(&bytes) {
                Ok(action) => rpc(root, action).await,
                Err(error) => Err(error),
            };
            println!(
                "{}",
                match result {
                    Ok(value) => json!({"ok":true,"result":value}),
                    Err(error) => json!({"ok":false,"error":error.to_string()}),
                }
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (tempfile::TempDir, Store, SigningKey, u64) {
        let dir = tempfile::tempdir().unwrap();
        let (trust, agreement, key) = policy::tests::fixture();
        let now = agreement.payload.valid_from + 1;
        let config = Config {
            trust,
            agreement,
            confirmations: 2,
        };
        fs::write(
            dir.path().join("config.json"),
            serde_json::to_vec(&config).unwrap(),
        )
        .unwrap();
        let store = Store::open(dir.path()).unwrap();
        (dir, store, key, now)
    }
    fn evidence(i: &Issued, tx: &str, now: u64) -> Receipt {
        Receipt {
            txid: tx.into(),
            amount_zatoshis: i.envelope.payload.amount_zatoshis.clone(),
            memo: i.payment_memo.clone(),
            mined_height: 10,
            verified_tip: 11,
            confirmations: 2,
            observed_at: now,
            consensus_branch: "test".into(),
            latest_block_time: now as u32,
        }
    }
    #[test]
    fn stable_invoice_survives_restart_and_keeps_period_expiry() {
        let (dir, mut store, key, now) = setup();
        let a = store.issue(&key, now).unwrap();
        drop(store);
        let mut store = Store::open(dir.path()).unwrap();
        let b = store.issue(&key, now + 1).unwrap();
        assert_eq!(
            serde_jcs::to_string(&a).unwrap(),
            serde_jcs::to_string(&b).unwrap()
        );
        assert_eq!(a.envelope.payload.invoice_id.len(), 64);
        assert_eq!(
            a.payment_memo,
            policy::invoice_memo(&a.envelope.payload).unwrap()
        );
    }
    #[test]
    fn entitlement_requires_exact_receipt_and_expires_without_rollover() {
        let (_dir, mut s, k, n) = setup();
        let i = s.issue(&k, n).unwrap();
        let id = &i.envelope.payload.invoice_id;
        assert!(s.entitlement(id, n).is_err());
        let mut r = evidence(&i, "tx-one", n);
        r.memo = "different".into();
        assert!(s.accept(id, &r).is_err());
        r = evidence(&i, "tx-one", n);
        r.confirmations = 1;
        assert!(s.accept(id, &r).is_err());
        r = evidence(&i, "tx-one", n);
        s.accept(id, &r).unwrap();
        assert!(s.entitlement(id, n).is_ok());
        assert!(s.entitlement(id, i.service_until).is_err());
        s.pending(id).unwrap();
        assert!(s.entitlement(id, n).is_err());
    }
    #[test]
    fn receipt_cannot_pay_two_invoices_or_replace_a_bound_transaction() {
        let (_dir, mut s, k, n) = setup();
        let a = s.issue(&k, n).unwrap();
        let r = evidence(&a, "tx-one", n);
        s.accept(&a.envelope.payload.invoice_id, &r).unwrap();
        let b = s.issue(&k, a.service_until + 1).unwrap();
        assert!(s.accept(&b.envelope.payload.invoice_id, &r).is_err());
        let reused = evidence(&b, "tx-one", n);
        assert!(s.accept(&b.envelope.payload.invoice_id, &reused).is_err());
        let replacement = evidence(&a, "tx-two", n);
        assert!(
            s.accept(&a.envelope.payload.invoice_id, &replacement)
                .is_err()
        );
    }
    #[test]
    fn revocation_stops_new_invoices_without_erasing_paid_service() {
        let (_dir, mut s, k, n) = setup();
        let i = s.issue(&k, n).unwrap();
        s.accept(&i.envelope.payload.invoice_id, &evidence(&i, "tx-one", n))
            .unwrap();
        let a = &s.config.agreement.payload;
        let payload = Revocation {
            schema: 1,
            context: a.context.clone(),
            agreement_id: a.agreement_id.clone(),
            agreement_digest: policy::digest(policy::AGREEMENT_DOMAIN, a).unwrap(),
            sequence: 1,
        };
        let revocation = Envelope {
            signatures: vec![
                policy::sign(
                    policy::REVOKE_DOMAIN,
                    &payload,
                    &SigningKey::from_bytes(&[1; 32]),
                )
                .unwrap(),
            ],
            payload,
        };
        s.revoke(&revocation).unwrap();
        s.revoke(&revocation).unwrap();
        assert!(s.issue(&k, n + 1).is_err());
        assert!(s.entitlement(&i.envelope.payload.invoice_id, n + 1).is_ok());
        assert!(
            s.entitlement(&i.envelope.payload.invoice_id, i.service_until)
                .is_err()
        );
    }

    #[test]
    fn pinned_config_and_rpc_reject_authority_changes() {
        let (dir, _, _, _) = setup();
        let mut config: Config =
            policy::decode(&fs::read(dir.path().join("config.json")).unwrap()).unwrap();
        config.confirmations = 1;
        fs::write(
            dir.path().join("config.json"),
            serde_json::to_vec(&config).unwrap(),
        )
        .unwrap();
        assert!(Store::open(dir.path()).is_err());
        assert!(policy::decode::<Action>(br#"{"op":"configure"}"#).is_err());
        assert!(policy::decode::<Action>(br#"{"op":"invoice","amount":"1"}"#).is_err());
    }
}
