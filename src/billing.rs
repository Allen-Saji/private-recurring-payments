use crate::{
    policy::{self, Agreement, Envelope},
    receipt::Receipt,
    supplier::Issued,
};
use anyhow::{Context, Result, ensure};
use ed25519_dalek::SigningKey;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const DOMAIN: &str = "private-recurring/billing/v1";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LineItem {
    pub description: String,
    pub quantity: u32,
    pub unit_amount_zatoshis: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Document {
    pub schema: u8,
    pub invoice_id: String,
    pub invoice_digest: String,
    pub invoice_number: String,
    pub document_created_at: u64,
    pub payment_request_issued_at: u64,
    pub payable_until: u64,
    pub service_from: u64,
    pub service_until: u64,
    pub buyer_company_id: String,
    pub supplier_key: String,
    pub currency: String,
    pub line_items: Vec<LineItem>,
    pub total_zatoshis: String,
    pub tax_treatment: String,
}

pub(crate) fn init(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS billing_documents(invoice_id TEXT PRIMARY KEY REFERENCES invoices(id),document TEXT NOT NULL);CREATE TABLE IF NOT EXISTS billing_payment_claims(invoice_id TEXT PRIMARY KEY REFERENCES invoices(id),txid TEXT NOT NULL,attempted_at INTEGER NOT NULL,last_error TEXT);")?;
    Ok(())
}

pub(crate) fn claim(db: &Connection, id: &str, txid: &str, now: u64) -> Result<()> {
    crate::receipt::transaction_id(txid)?;
    db.execute("INSERT INTO billing_payment_claims(invoice_id,txid,attempted_at,last_error) VALUES(?1,?2,?3,NULL) ON CONFLICT(invoice_id) DO UPDATE SET txid=excluded.txid,attempted_at=excluded.attempted_at,last_error=NULL",params![id,txid,now])?;
    Ok(())
}
pub(crate) fn claim_error(db: &Connection, id: &str, error: &str) -> Result<()> {
    db.execute(
        "UPDATE billing_payment_claims SET last_error=?2 WHERE invoice_id=?1",
        params![id, error],
    )?;
    Ok(())
}

pub(crate) fn number(sequence: i64) -> String {
    format!("INV-{sequence:06}")
}

fn validate_issued(issued: &Issued, a: &Agreement) -> Result<()> {
    let period = a.validate_invoice(&issued.envelope, issued.envelope.payload.issued_at)?;
    ensure!(
        issued.period_start == period.start
            && issued.service_until
                == a.schedule
                    .period_end(issued.envelope.payload.issued_at)?
                    .min(a.expires_at)
            && issued.payment_memo == policy::invoice_memo(&issued.envelope.payload)?,
        "Stored invoice service period or memo is inconsistent"
    );
    Ok(())
}

fn validate(
    document: &Envelope<Document>,
    issued: &Issued,
    a: &Agreement,
    sequence: i64,
) -> Result<()> {
    policy::verify(DOMAIN, document, std::slice::from_ref(&a.supplier_key))?;
    validate_issued(issued, a)?;
    let d = &document.payload;
    let i = &issued.envelope.payload;
    let period = a.schedule.period(i.issued_at)?;
    ensure!(
        d.schema == 1
            && d.invoice_id == i.invoice_id
            && d.invoice_digest == policy::digest(policy::INVOICE_DOMAIN, i)?
            && d.invoice_number == number(sequence),
        "Billing record identity mismatch"
    );
    ensure!(
        d.buyer_company_id == a.context.company_id
            && d.supplier_key == a.supplier_key
            && d.currency == "TAZ"
            && d.tax_treatment == "not_calculated",
        "Billing identity or currency mismatch"
    );
    ensure!(
        d.payment_request_issued_at == i.issued_at
            && d.document_created_at >= i.issued_at
            && d.document_created_at <= 253_402_300_799
            && d.payable_until == i.expires_at
            && d.service_from == period.start
            && d.service_until == a.schedule.period_end(i.issued_at)?.min(a.expires_at),
        "Billing service period mismatch"
    );
    ensure!(
        !d.line_items.is_empty() && d.line_items.len() <= 32,
        "Invalid line item count"
    );
    let mut total = 0u64;
    for item in &d.line_items {
        ensure!(
            !item.description.is_empty()
                && item.description.len() <= 240
                && item.description.is_ascii()
                && !item.description.chars().any(char::is_control)
                && item.quantity > 0,
            "Invalid billing line item"
        );
        let charge = policy::amount(&item.unit_amount_zatoshis)?
            .checked_mul(u64::from(item.quantity))
            .context("Line item overflow")?;
        total = total
            .checked_add(charge)
            .context("Invoice total overflow")?;
    }
    ensure!(
        d.total_zatoshis == i.amount_zatoshis && total == policy::amount(&i.amount_zatoshis)?,
        "Billing total differs from authorized invoice"
    );
    Ok(())
}

pub(crate) fn create(
    db: &Connection,
    issued: &Issued,
    a: &Agreement,
    key: &SigningKey,
    now: u64,
) -> Result<()> {
    let sequence: i64 = db.query_row(
        "SELECT rowid FROM invoices WHERE id=?1",
        [&issued.envelope.payload.invoice_id],
        |r| r.get(0),
    )?;
    let existing: Option<String> = db
        .query_row(
            "SELECT document FROM billing_documents WHERE invoice_id=?1",
            [&issued.envelope.payload.invoice_id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(encoded) = existing {
        validate(&policy::decode(encoded.as_bytes())?, issued, a, sequence)?;
        return Ok(());
    }
    let i = &issued.envelope.payload;
    let payload = Document {
        schema: 1,
        invoice_id: i.invoice_id.clone(),
        invoice_digest: policy::digest(policy::INVOICE_DOMAIN, i)?,
        invoice_number: number(sequence),
        document_created_at: now,
        payment_request_issued_at: i.issued_at,
        payable_until: i.expires_at,
        service_from: issued.period_start,
        service_until: issued.service_until,
        buyer_company_id: a.context.company_id.clone(),
        supplier_key: a.supplier_key.clone(),
        currency: "TAZ".into(),
        line_items: vec![LineItem {
            description: "Zcash testnet telemetry subscription".into(),
            quantity: 1,
            unit_amount_zatoshis: i.amount_zatoshis.clone(),
        }],
        total_zatoshis: i.amount_zatoshis.clone(),
        tax_treatment: "not_calculated".into(),
    };
    let document = Envelope {
        signatures: vec![policy::sign(DOMAIN, &payload, key)?],
        payload,
    };
    validate(&document, issued, a, sequence)?;
    db.execute(
        "INSERT INTO billing_documents(invoice_id,document) VALUES(?1,?2)",
        params![i.invoice_id, serde_jcs::to_string(&document)?],
    )?;
    Ok(())
}

fn states(
    verified: bool,
    has_tx: bool,
    revoked: bool,
    deadline: u64,
    now: u64,
) -> (&'static str, &'static str) {
    let payment = if verified {
        "paid"
    } else if has_tx {
        "verification_pending"
    } else {
        "unpaid"
    };
    let collection = if revoked {
        "stopped"
    } else if now >= deadline {
        "window_closed"
    } else {
        "open"
    };
    (payment, collection)
}

pub(crate) fn detail(db: &Connection, a: &Agreement, id: &str, now: u64) -> Result<Value> {
    policy::identifier(id)?;
    let (sequence, encoded, txid, receipt, verified): (
        i64,
        String,
        Option<String>,
        Option<String>,
        bool,
    ) = db
        .query_row(
            "SELECT rowid,issued,txid,receipt,verified FROM invoices WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .context("Unknown invoice")?;
    let issued: Issued = policy::decode(encoded.as_bytes())?;
    validate_issued(&issued, a)?;
    let document: Option<String> = db
        .query_row(
            "SELECT document FROM billing_documents WHERE invoice_id=?1",
            [id],
            |r| r.get(0),
        )
        .optional()?;
    let document: Option<Envelope<Document>> =
        document.map(|v| policy::decode(v.as_bytes())).transpose()?;
    if let Some(d) = &document {
        validate(d, &issued, a, sequence)?;
    }
    let receipt: Option<Receipt> = receipt.map(|v| serde_json::from_str(&v)).transpose()?;
    if let Some(r) = &receipt {
        ensure!(
            Some(&r.txid) == txid.as_ref()
                && r.memo == issued.payment_memo
                && r.amount_zatoshis == issued.envelope.payload.amount_zatoshis,
            "Stored receipt differs from invoice"
        );
    }
    ensure!(
        !verified || receipt.is_some(),
        "Verified invoice is missing its receipt"
    );
    let revoked: bool =
        db.query_row("SELECT revoked FROM identity WHERE singleton=1", [], |r| {
            r.get(0)
        })?;
    let candidate: Option<(String, u64, Option<String>)> = db
        .query_row(
            "SELECT txid,attempted_at,last_error FROM billing_payment_claims WHERE invoice_id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let payment_candidate = candidate
        .as_ref()
        .map(|(tx, time, error)| json!({"txid":tx,"attempted_at":time,"last_error":error}));
    let (payment_state, collection_state) = states(
        verified,
        txid.is_some() || candidate.is_some(),
        revoked,
        issued.envelope.payload.expires_at,
        now,
    );
    Ok(
        json!({"invoice_id":id,"invoice_number":number(sequence),"sequence":sequence.to_string(),"payment_state":payment_state,"collection_state":collection_state,"service_state":if now>=issued.service_until {"expired"}else{"within_period"},"issued":issued,"billing_document":document,"document_signature_verified":document.is_some(),"receipt":receipt,"txid":txid,"payment_candidate":payment_candidate,"observations_are_cached":true,"as_of":now}),
    )
}

pub(crate) fn list(db: &Connection, a: &Agreement, before: Option<u64>, now: u64) -> Result<Value> {
    ensure!(
        before.is_none_or(|x| x > 0 && x <= i64::MAX as u64),
        "Invalid billing cursor"
    );
    let mut query =
        db.prepare("SELECT id,rowid FROM invoices WHERE rowid<?1 ORDER BY rowid DESC LIMIT 11")?;
    let rows = query
        .query_map([before.map(|n| n as i64).unwrap_or(i64::MAX)], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut invoices = Vec::new();
    for (id, _) in rows.iter().take(10) {
        let item = detail(db, a, id, now)?;
        // Keep list frames bounded. The full signed document is available by ID.
        let invoice = &item["issued"]["envelope"]["payload"];
        let summary = json!({"invoice_id":item["invoice_id"],"invoice_number":item["invoice_number"],"payment_state":item["payment_state"],"collection_state":item["collection_state"],"issued_at":invoice["issued_at"],"payable_until":invoice["expires_at"],"period_id":invoice["period_id"],"amount_zatoshis":invoice["amount_zatoshis"],"service_from":item["issued"]["period_start"],"service_until":item["issued"]["service_until"],"txid":item["txid"],"last_verified_at":item["receipt"]["observed_at"],"has_billing_document":item["document_signature_verified"]});
        invoices.push(summary);
    }
    let mut totals = [0u64; 4];
    let mut counts = [0u64; 4];
    let revoked: bool =
        db.query_row("SELECT revoked FROM identity WHERE singleton=1", [], |r| {
            r.get(0)
        })?;
    let mut all = db.prepare("SELECT i.issued,COALESCE(i.txid,c.txid),i.verified FROM invoices i LEFT JOIN billing_payment_claims c ON c.invoice_id=i.id")?;
    let rows_all = all.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, bool>(2)?,
        ))
    })?;
    for row in rows_all {
        let (encoded, tx, verified) = row?;
        let issued: Issued = policy::decode(encoded.as_bytes())?;
        let amount = policy::amount(&issued.envelope.payload.amount_zatoshis)?;
        let (payment, _collection) = states(
            verified,
            tx.is_some(),
            revoked,
            issued.envelope.payload.expires_at,
            now,
        );
        let index = match payment {
            "paid" => 1,
            "verification_pending" => 2,
            _ => 3,
        };
        for n in [0, index] {
            totals[n] = totals[n]
                .checked_add(amount)
                .context("Billing aggregate overflow")?;
            counts[n] += 1;
        }
    }
    Ok(
        json!({"invoices":invoices,"next_cursor":if rows.len()>10 {Some(rows[9].1.to_string())}else{None},"totals":{"billed_zatoshis":totals[0].to_string(),"paid_zatoshis":totals[1].to_string(),"pending_zatoshis":totals[2].to_string(),"unpaid_zatoshis":totals[3].to_string(),"invoice_count":counts[0],"paid_count":counts[1],"pending_count":counts[2],"unpaid_count":counts[3]},"agreement":{"agreement_id":a.agreement_id,"buyer_company_id":a.context.company_id,"supplier_key":a.supplier_key,"amount_zatoshis":a.amount_zatoshis,"schedule":a.schedule,"expires_at":a.expires_at,"revoked":revoked},"currency":"TAZ","as_of":now,"observations_are_cached":true}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Connection, Agreement, Issued, SigningKey) {
        let (trust, e, k) = policy::tests::fixture();
        e.payload.validate(&trust).unwrap();
        let i = policy::tests::invoice(&e.payload, &k, 1001, "bill-one");
        let issued = Issued {
            payment_memo: policy::invoice_memo(&i.payload).unwrap(),
            envelope: i,
            period_start: 1000,
            service_until: 1120,
        };
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE invoices(id TEXT PRIMARY KEY,issued TEXT,txid TEXT,receipt TEXT,verified INTEGER);CREATE TABLE identity(singleton INTEGER,revoked INTEGER);INSERT INTO identity VALUES(1,0);").unwrap();
        init(&db).unwrap();
        db.execute(
            "INSERT INTO invoices VALUES(?1,?2,NULL,NULL,0)",
            params!["bill-one", serde_json::to_string(&issued).unwrap()],
        )
        .unwrap();
        (db, e.payload, issued, k)
    }
    #[test]
    fn billing_signature_binds_exact_total_period_and_original_request() {
        let (db, a, i, k) = fixture();
        create(&db, &i, &a, &k, 1002).unwrap();
        let original: String = db
            .query_row("SELECT document FROM billing_documents", [], |r| r.get(0))
            .unwrap();
        create(&db, &i, &a, &k, 1010).unwrap();
        let retry: String = db
            .query_row("SELECT document FROM billing_documents", [], |r| r.get(0))
            .unwrap();
        assert_eq!(original, retry);
        let mut d: Envelope<Document> = policy::decode(original.as_bytes()).unwrap();
        d.payload.line_items[0].unit_amount_zatoshis = "2000000".into();
        d.signatures = vec![policy::sign(DOMAIN, &d.payload, &k).unwrap()];
        assert!(validate(&d, &i, &a, 1).is_err());
        d.payload.line_items[0].unit_amount_zatoshis = "1000000".into();
        d.payload.service_until += 1;
        d.signatures = vec![policy::sign(DOMAIN, &d.payload, &k).unwrap()];
        assert!(validate(&d, &i, &a, 1).is_err());
    }
    #[test]
    fn stopped_collection_does_not_erase_paid_history_or_uncertain_payments() {
        assert_eq!(states(true, true, true, 1100, 1200), ("paid", "stopped"));
        assert_eq!(
            states(false, true, true, 1100, 1200),
            ("verification_pending", "stopped")
        );
        assert_eq!(
            states(false, false, false, 1100, 1200),
            ("unpaid", "window_closed")
        );
        assert_eq!(states(false, false, false, 1100, 1000), ("unpaid", "open"));
    }
    #[test]
    fn legacy_invoice_is_readable_without_fabricating_a_billing_signature() {
        let (db, a, _, _) = fixture();
        let d = detail(&db, &a, "bill-one", 1200).unwrap();
        assert_eq!(d["billing_document"], Value::Null);
        assert_eq!(d["invoice_number"], "INV-000001");
        let list = list(&db, &a, None, 1200).unwrap();
        assert_eq!(list["totals"]["unpaid_zatoshis"], "1000000");
        assert_eq!(list["invoices"][0]["collection_state"], "window_closed");
        assert!(super::list(&db, &a, Some(0), 1200).is_err());
    }
    #[test]
    fn unconfirmed_claim_is_pending_and_never_counted_as_paid() {
        let (db, a, _, _) = fixture();
        claim(&db, "bill-one", &"1".repeat(64), 1002).unwrap();
        claim_error(&db, "bill-one", "Payment needs more confirmations").unwrap();
        let report = list(&db, &a, None, 1003).unwrap();
        assert_eq!(report["totals"]["pending_zatoshis"], "1000000");
        assert_eq!(report["totals"]["paid_zatoshis"], "0");
        let invoice = detail(&db, &a, "bill-one", 1003).unwrap();
        assert_eq!(invoice["payment_state"], "verification_pending");
        assert!(invoice["receipt"].is_null());
        assert!(claim(&db, "bill-one", "not-a-txid", 1004).is_err());
    }
    #[test]
    fn cursor_pages_preserve_invoice_numbers_and_complete_totals() {
        let (db, mut a, _, key) = fixture();
        a.expires_at = 5000;
        for n in 0..23 {
            let id = if n == 0 {
                "bill-one".to_string()
            } else {
                format!("bill-{n}")
            };
            let now = 1001 + n * 120;
            let invoice = policy::tests::invoice(&a, &key, now, &id);
            let issued = Issued {
                payment_memo: policy::invoice_memo(&invoice.payload).unwrap(),
                envelope: invoice,
                period_start: 1000 + n * 120,
                service_until: 1120 + n * 120,
            };
            if n == 0 {
                db.execute(
                    "UPDATE invoices SET issued=?1 WHERE id=?2",
                    params![serde_json::to_string(&issued).unwrap(), id],
                )
                .unwrap();
            } else {
                db.execute(
                    "INSERT INTO invoices(id,issued,verified) VALUES(?1,?2,0)",
                    params![id, serde_json::to_string(&issued).unwrap()],
                )
                .unwrap();
            }
        }
        let mut cursor = None;
        let mut ids = std::collections::BTreeSet::new();
        let mut pages = 0;
        loop {
            let page = list(&db, &a, cursor, 4000).unwrap();
            assert_eq!(page["totals"]["invoice_count"], 23);
            assert_eq!(page["totals"]["billed_zatoshis"], "23000000");
            for row in page["invoices"].as_array().unwrap() {
                assert!(ids.insert(row["invoice_id"].as_str().unwrap().to_string()));
            }
            pages += 1;
            cursor = page["next_cursor"].as_str().map(|s| s.parse().unwrap());
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(pages, 3);
        assert_eq!(ids.len(), 23);
    }
}
