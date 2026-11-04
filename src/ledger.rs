use crate::policy::{self, Agreement, Envelope, Invoice, Revocation, Trust};
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{path::Path, time::Duration};

pub struct Ledger {
    db: Connection,
    pub trust: Trust,
}

#[derive(Clone, Debug, Serialize)]
pub struct Occurrence {
    pub id: String,
    pub agreement_id: String,
    pub period_id: String,
    pub invoice_digest: String,
    pub memo: String,
    pub state: String,
    pub txid: Option<String>,
}

impl Ledger {
    pub fn overview(&self) -> Result<serde_json::Value> {
        let mut query = self.db.prepare(
            "SELECT envelope,revoked FROM agreements WHERE company=?1 ORDER BY rowid DESC LIMIT 20",
        )?;
        let rows = query.query_map([&self.trust.context.company_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?))
        })?;
        let mut agreements = Vec::new();
        for row in rows {
            let (envelope, revoked) = row?;
            let approved: Envelope<Agreement> = policy::decode(envelope.as_bytes())?;
            let reserved:i64=self.db.query_row("SELECT COALESCE(SUM(reserved_zatoshis),0) FROM occurrences WHERE company=?1 AND agreement_id=?2",params![self.trust.context.company_id,approved.payload.agreement_id],|r|r.get(0))?;
            let reserved = u64::try_from(reserved)?;
            let limit = policy::amount(&approved.payload.lifetime_limit_zatoshis)?;
            agreements.push(serde_json::json!({"envelope":approved,"revoked":revoked,"reserved_zatoshis":reserved.to_string(),"remaining_allowance_zatoshis":limit.saturating_sub(reserved).to_string()}));
        }
        let mut query = self
            .db
            .prepare("SELECT id FROM occurrences WHERE company=?1 ORDER BY rowid DESC LIMIT 20")?;
        let ids = query.query_map([&self.trust.context.company_id], |r| r.get::<_, String>(0))?;
        let mut payments = Vec::new();
        for id in ids {
            let row = self.get(&id?)?;
            payments.push(serde_json::json!({"payment_id":row.id,"agreement_id":row.agreement_id,"period_id":row.period_id,"state":row.state,"txid":row.txid}));
        }
        Ok(
            serde_json::json!({"agreements":agreements,"payments":payments,"observations_are_cached":true,"limit":20}),
        )
    }
    pub fn durable_ids(&self) -> Result<Vec<String>> {
        let mut query=self.db.prepare("SELECT id FROM occurrences WHERE state IN ('signed_durable','broadcast_unknown','confirmed')")?;
        Ok(query
            .query_map([], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?)
    }
    pub fn open(path: &Path, trust: Trust) -> Result<Self> {
        trust.validate()?;
        let db = Connection::open(path)?;
        db.busy_timeout(Duration::from_secs(10))?;
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.pragma_update(None, "synchronous", "FULL")?;
        db.pragma_update(None, "foreign_keys", "ON")?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), trust TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS agreements (company TEXT NOT NULL,id TEXT NOT NULL,digest TEXT NOT NULL,envelope TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,sequence INTEGER NOT NULL DEFAULT 0,revocation_digest TEXT, PRIMARY KEY(company,id));
        CREATE TABLE IF NOT EXISTS occurrences (id TEXT PRIMARY KEY,company TEXT NOT NULL,agreement_id TEXT NOT NULL,period_id TEXT NOT NULL,invoice_id TEXT NOT NULL,invoice_digest TEXT NOT NULL,invoice TEXT NOT NULL,reserved_zatoshis INTEGER NOT NULL CHECK(reserved_zatoshis>0),memo TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('reserved','signing','signed_durable','broadcast_unknown','confirmed','recovery_required')),txid TEXT,raw_hash TEXT, UNIQUE(company,agreement_id,period_id),UNIQUE(company,agreement_id,invoice_id),FOREIGN KEY(company,agreement_id) REFERENCES agreements(company,id));")?;
        let encoded = serde_jcs::to_string(&trust)?;
        db.execute("INSERT OR IGNORE INTO identity VALUES(1,?1)", [&encoded])?;
        let pinned: String =
            db.query_row("SELECT trust FROM identity WHERE singleton=1", [], |r| {
                r.get(0)
            })?;
        ensure!(
            pinned == encoded,
            "Signer trust configuration differs from the pinned ledger identity"
        );
        Ok(Self { db, trust })
    }

    pub fn install(&mut self, envelope: &Envelope<Agreement>) -> Result<String> {
        envelope.payload.validate(&self.trust)?;
        policy::verify(policy::AGREEMENT_DOMAIN, envelope, &self.trust.approvers)?;
        let digest = policy::digest(policy::AGREEMENT_DOMAIN, &envelope.payload)?;
        let a = &envelope.payload;
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let old: Option<String> = tx
            .query_row(
                "SELECT digest FROM agreements WHERE company=?1 AND id=?2",
                params![a.context.company_id, a.agreement_id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(old) = old {
            ensure!(
                old == digest,
                "Agreement ID already exists; changing terms or schedule requires a future amendment protocol"
            );
        } else {
            tx.execute(
                "INSERT INTO agreements(company,id,digest,envelope) VALUES(?1,?2,?3,?4)",
                params![
                    a.context.company_id,
                    a.agreement_id,
                    digest,
                    serde_jcs::to_string(envelope)?
                ],
            )?;
        }
        tx.commit()?;
        Ok(digest)
    }

    pub fn agreement(&self, id: &str) -> Result<Agreement> {
        let encoded: String = self
            .db
            .query_row(
                "SELECT envelope FROM agreements WHERE company=?1 AND id=?2",
                params![self.trust.context.company_id, id],
                |r| r.get(0),
            )
            .context("Agreement is not installed")?;
        let envelope: Envelope<Agreement> = policy::decode(encoded.as_bytes())?;
        envelope.payload.validate(&self.trust)?;
        policy::verify(policy::AGREEMENT_DOMAIN, &envelope, &self.trust.approvers)?;
        Ok(envelope.payload)
    }

    pub fn reserve(&mut self, invoice: &Envelope<Invoice>, now: u64) -> Result<Occurrence> {
        let a = self.agreement(&invoice.payload.agreement_id)?;
        policy::verify(
            policy::INVOICE_DOMAIN,
            invoice,
            std::slice::from_ref(&a.supplier_key),
        )?;
        let i = &invoice.payload;
        let digest = policy::digest(policy::INVOICE_DOMAIN, i)?;
        let company = self.trust.context.company_id.clone();
        ensure!(i.context == self.trust.context, "Invoice context mismatch");
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let old: Option<String> = tx
            .query_row(
                "SELECT id FROM occurrences WHERE company=?1 AND agreement_id=?2 AND period_id=?3",
                params![company, a.agreement_id, i.period_id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(id) = old {
            let prior = read_occurrence(&tx, &id)?;
            ensure!(
                prior.invoice_digest == digest,
                "Period already reserved under another invoice; no second payment"
            );
            tx.commit()?;
            return Ok(prior);
        }
        let period = a.validate_invoice(invoice, now)?;
        let revoked: bool = tx.query_row(
            "SELECT revoked FROM agreements WHERE company=?1 AND id=?2",
            params![company, a.agreement_id],
            |r| r.get(0),
        )?;
        ensure!(!revoked, "Agreement is revoked");
        let invoice_used:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM occurrences WHERE company=?1 AND agreement_id=?2 AND invoice_id=?3)",params![company,a.agreement_id,i.invoice_id],|r|r.get(0))?;
        ensure!(!invoice_used, "Supplier invoice ID already used");
        let total:i64=tx.query_row("SELECT COALESCE(SUM(reserved_zatoshis),0) FROM occurrences WHERE company=?1 AND agreement_id=?2",params![company,a.agreement_id],|r|r.get(0))?;
        let reserve = policy::amount(&a.amount_zatoshis)?
            .checked_add(policy::amount(&a.max_fee_zatoshis)?)
            .context("Reservation overflow")?;
        ensure!(
            u64::try_from(total)?
                .checked_add(reserve)
                .context("Lifetime reservation overflow")?
                <= policy::amount(&a.lifetime_limit_zatoshis)?,
            "Agreement lifetime budget exhausted"
        );
        let id = hex::encode(Sha256::digest(serde_jcs::to_vec(&(
            &company,
            &a.agreement_id,
            &period.id,
        ))?));
        let memo = policy::invoice_memo(i)?;
        tx.execute("INSERT INTO occurrences(id,company,agreement_id,period_id,invoice_id,invoice_digest,invoice,reserved_zatoshis,memo,state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'reserved')",params![id,company,a.agreement_id,period.id,i.invoice_id,digest,serde_jcs::to_string(invoice)?,i64::try_from(reserve)?,memo])?;
        tx.commit()?;
        self.get(&id)
    }

    // This committed transition is the authorization cutoff, serialized with revocation.
    // A crash after it retains the reservation even if signing did not finish.
    pub fn authorize_signing(&mut self, id: &str, now: u64) -> Result<()> {
        let row = self.get(id)?;
        let agreement = self.agreement(&row.agreement_id)?;
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (state, encoded): (String, String) = tx.query_row(
            "SELECT state,invoice FROM occurrences WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        ensure!(
            state == "reserved",
            "Occurrence is not available for new signing"
        );
        let revoked: bool = tx.query_row(
            "SELECT revoked FROM agreements WHERE company=?1 AND id=?2",
            params![agreement.context.company_id, agreement.agreement_id],
            |r| r.get(0),
        )?;
        ensure!(!revoked, "Revocation won the signing cutoff");
        let invoice: Envelope<Invoice> = policy::decode(encoded.as_bytes())?;
        agreement.validate_invoice(&invoice, now)?;
        tx.execute("UPDATE occurrences SET state='signing' WHERE id=?1", [id])?;
        tx.commit()?;
        Ok(())
    }

    pub fn revoke(&mut self, envelope: &Envelope<Revocation>) -> Result<usize> {
        policy::verify(
            policy::REVOKE_DOMAIN,
            envelope,
            std::slice::from_ref(&self.trust.revoker),
        )?;
        let r = &envelope.payload;
        ensure!(
            r.schema == 1 && r.context == self.trust.context && r.sequence > 0,
            "Invalid revocation context or sequence"
        );
        let a = self.agreement(&r.agreement_id)?;
        ensure!(
            r.agreement_digest == policy::digest(policy::AGREEMENT_DOMAIN, &a)?,
            "Revocation agreement digest mismatch"
        );
        let digest = policy::digest(policy::REVOKE_DOMAIN, r)?;
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (seq, prior): (u32, Option<String>) = tx.query_row(
            "SELECT sequence,revocation_digest FROM agreements WHERE company=?1 AND id=?2",
            params![r.context.company_id, r.agreement_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        ensure!(
            r.sequence > seq || (r.sequence == seq && prior.as_ref() == Some(&digest)),
            "Stale or conflicting revocation sequence"
        );
        tx.execute("UPDATE agreements SET revoked=1,sequence=?3,revocation_digest=?4 WHERE company=?1 AND id=?2",params![r.context.company_id,r.agreement_id,r.sequence,digest])?;
        let authorized:usize=tx.query_row("SELECT COUNT(*) FROM occurrences WHERE company=?1 AND agreement_id=?2 AND state!='reserved'",params![r.context.company_id,r.agreement_id],|r|r.get(0))?;
        tx.commit()?;
        Ok(authorized)
    }

    pub fn get(&self, id: &str) -> Result<Occurrence> {
        read_occurrence(&self.db, id)
    }

    pub fn durable(&mut self, id: &str, txid: &str, hash: &str) -> Result<()> {
        let changed=self.db.execute("UPDATE occurrences SET state='signed_durable',txid=?2,raw_hash=?3 WHERE id=?1 AND state='signing'",params![id,txid,hash])?;
        ensure!(changed == 1, "Cannot attach artifact to this occurrence");
        Ok(())
    }

    pub fn broadcast_unknown(&mut self, id: &str) -> Result<()> {
        let changed=self.db.execute("UPDATE occurrences SET state='broadcast_unknown' WHERE id=?1 AND state IN ('signed_durable','broadcast_unknown')",[id])?;
        ensure!(
            changed == 1,
            "Occurrence has no durable artifact to broadcast"
        );
        Ok(())
    }

    pub fn confirmed(&mut self, id: &str) -> Result<()> {
        let changed=self.db.execute("UPDATE occurrences SET state='confirmed' WHERE id=?1 AND state IN ('broadcast_unknown','confirmed')",[id])?;
        ensure!(changed == 1, "Cannot confirm an unsubmitted occurrence");
        Ok(())
    }

    pub fn expected_hash(&self, id: &str) -> Result<String> {
        Ok(self
            .db
            .query_row("SELECT raw_hash FROM occurrences WHERE id=?1", [id], |r| {
                r.get(0)
            })?)
    }
    pub fn has_unresolved_other(&self, id: &str) -> Result<bool> {
        Ok(self.db.query_row("SELECT EXISTS(SELECT 1 FROM occurrences WHERE id!=?1 AND state IN ('signing','recovery_required'))",[id],|r|r.get(0))?)
    }
    pub fn unconfirm(&mut self, id: &str) -> Result<()> {
        self.db.execute(
            "UPDATE occurrences SET state='broadcast_unknown' WHERE id=?1 AND state='confirmed'",
            [id],
        )?;
        Ok(())
    }
}

fn read_occurrence(db: &Connection, id: &str) -> Result<Occurrence> {
    db.query_row("SELECT id,agreement_id,period_id,invoice_digest,memo,state,txid FROM occurrences WHERE id=?1",[id],|r|Ok(Occurrence{id:r.get(0)?,agreement_id:r.get(1)?,period_id:r.get(2)?,invoice_digest:r.get(3)?,memo:r.get(4)?,state:r.get(5)?,txid:r.get(6)?})).context("Unknown occurrence")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::tests::{fixture, invoice};

    #[test]
    fn final_authorization_rechecks_time_and_storage_errors() {
        let d = tempfile::tempdir().unwrap();
        let (t, a, key) = fixture();
        let mut l = Ledger::open(&d.path().join("l"), t).unwrap();
        l.install(&a).unwrap();
        let row = l
            .reserve(&invoice(&a.payload, &key, 1010, "one"), 1010)
            .unwrap();
        assert!(l.authorize_signing(&row.id, 1120).is_err());
        l.db.execute_batch("CREATE TRIGGER fail_sign BEFORE UPDATE ON occurrences WHEN NEW.state='signing' BEGIN SELECT RAISE(ABORT,'injected storage error'); END;").unwrap();
        assert!(l.authorize_signing(&row.id, 1010).is_err());
        assert_eq!(l.get(&row.id).unwrap().state, "reserved");
    }

    #[test]
    fn schedule_replacement_and_changed_trust_cannot_reset_authority() {
        let d = tempfile::tempdir().unwrap();
        let (t, mut a, _) = fixture();
        let path = d.path().join("l");
        let mut l = Ledger::open(&path, t.clone()).unwrap();
        l.install(&a).unwrap();
        a.payload.valid_from = 1120;
        a.payload.schedule = policy::Schedule::TestnetInterval {
            anchor: 1120,
            interval_secs: 120,
            payment_window_secs: 120,
        };
        a.signatures = vec![
            policy::sign(
                policy::AGREEMENT_DOMAIN,
                &a.payload,
                &ed25519_dalek::SigningKey::from_bytes(&[1; 32]),
            )
            .unwrap(),
            policy::sign(
                policy::AGREEMENT_DOMAIN,
                &a.payload,
                &ed25519_dalek::SigningKey::from_bytes(&[2; 32]),
            )
            .unwrap(),
        ];
        assert!(l.install(&a).is_err());
        let mut changed = t;
        changed.context.signer_id = "another-signer".into();
        assert!(Ledger::open(&path, changed).is_err());
    }
    #[test]
    fn replay_invoice_changes_budget_and_restart() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("ledger.sqlite");
        let (t, a, key) = fixture();
        let mut l = Ledger::open(&path, t.clone()).unwrap();
        l.install(&a).unwrap();
        let i = invoice(&a.payload, &key, 1010, "one");
        let first = l.reserve(&i, 1010).unwrap();
        assert_eq!(l.reserve(&i, 1900).unwrap().id, first.id);
        assert!(
            l.reserve(&invoice(&a.payload, &key, 1010, "other"), 1010)
                .is_err()
        );
        drop(l);
        let mut l = Ledger::open(&path, t).unwrap();
        assert_eq!(l.reserve(&i, 1010).unwrap().id, first.id);
        l.reserve(&invoice(&a.payload, &key, 1130, "two"), 1130)
            .unwrap();
        assert!(
            l.reserve(&invoice(&a.payload, &key, 1250, "three"), 1250)
                .is_err()
        );
    }
    #[test]
    fn revocation_and_signing_have_a_durable_order() {
        for revoke_first in [true, false] {
            let d = tempfile::tempdir().unwrap();
            let (t, a, key) = fixture();
            let mut l = Ledger::open(&d.path().join("l"), t).unwrap();
            l.install(&a).unwrap();
            let row = l
                .reserve(&invoice(&a.payload, &key, 1010, "one"), 1010)
                .unwrap();
            let r = Revocation {
                schema: 1,
                context: a.payload.context.clone(),
                agreement_id: a.payload.agreement_id.clone(),
                agreement_digest: policy::digest(policy::AGREEMENT_DOMAIN, &a.payload).unwrap(),
                sequence: 1,
            };
            let e = Envelope {
                signatures: vec![
                    policy::sign(
                        policy::REVOKE_DOMAIN,
                        &r,
                        &ed25519_dalek::SigningKey::from_bytes(&[1; 32]),
                    )
                    .unwrap(),
                ],
                payload: r,
            };
            if revoke_first {
                assert_eq!(l.revoke(&e).unwrap(), 0);
                assert!(l.authorize_signing(&row.id, 1010).is_err());
            } else {
                l.authorize_signing(&row.id, 1010).unwrap();
                assert_eq!(l.revoke(&e).unwrap(), 1);
                assert!(l.authorize_signing(&row.id, 1010).is_err());
            }
            assert!(
                l.reserve(&invoice(&a.payload, &key, 1130, "two"), 1130)
                    .is_err()
            );
        }
    }
    #[test]
    fn concurrent_reservations_have_one_winner() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("l");
        let (t, a, key) = fixture();
        Ledger::open(&path, t.clone()).unwrap().install(&a).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let handles: Vec<_> = (0..2)
            .map(|n| {
                let p = path.clone();
                let t = t.clone();
                let b = barrier.clone();
                let i = invoice(&a.payload, &key, 1010, &format!("invoice-{n}"));
                std::thread::spawn(move || {
                    let mut l = Ledger::open(&p, t).unwrap();
                    b.wait();
                    l.reserve(&i, 1010).is_ok()
                })
            })
            .collect();
        assert_eq!(
            handles
                .into_iter()
                .filter(|h| h.thread().id() != std::thread::current().id())
                .map(|h| usize::from(h.join().unwrap()))
                .sum::<usize>(),
            1
        );
    }
}
