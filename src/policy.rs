use anyhow::{Context as _, Result, bail, ensure};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use time::{Date, OffsetDateTime};
use zcash_keys::address::Address;

pub const AGREEMENT_DOMAIN: &str = "private-recurring/agreement/v1";
pub const INVOICE_DOMAIN: &str = "private-recurring/invoice/v1";
pub const REVOKE_DOMAIN: &str = "private-recurring/revoke/v1";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Context {
    pub company_id: String,
    pub signer_id: String,
    pub chain: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Trust {
    pub context: Context,
    pub approvers: [String; 2],
    pub revoker: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Schedule {
    CalendarMonth {
        anchor: u64,
        payment_window_secs: u32,
    },
    TestnetInterval {
        anchor: u64,
        interval_secs: u32,
        payment_window_secs: u32,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Agreement {
    pub schema: u8,
    pub context: Context,
    pub agreement_id: String,
    pub version: u32,
    pub supplier_key: String,
    pub recipient: String,
    pub amount_zatoshis: String,
    pub lifetime_limit_zatoshis: String,
    pub max_fee_zatoshis: String,
    pub max_actions: u32,
    pub valid_from: u64,
    pub expires_at: u64,
    pub schedule: Schedule,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Invoice {
    pub schema: u8,
    pub context: Context,
    pub agreement_id: String,
    pub agreement_version: u32,
    pub agreement_digest: String,
    pub invoice_id: String,
    pub period_id: String,
    pub recipient: String,
    pub amount_zatoshis: String,
    pub issued_at: u64,
    pub expires_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Revocation {
    pub schema: u8,
    pub context: Context,
    pub agreement_id: String,
    pub agreement_digest: String,
    pub sequence: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Approval {
    pub key: String,
    pub signature: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope<T> {
    pub payload: T,
    pub signatures: Vec<Approval>,
}

#[derive(Debug, Clone)]
pub struct Period {
    pub id: String,
    pub start: u64,
    pub window_end: u64,
}

pub fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    ensure!(bytes.len() <= 32_768, "Envelope exceeds 32 KiB");
    Ok(serde_json::from_slice(bytes)?)
}

pub fn message<T: Serialize>(domain: &str, payload: &T) -> Result<Vec<u8>> {
    let mut bytes = domain.as_bytes().to_vec();
    bytes.push(0);
    bytes.extend(serde_jcs::to_vec(payload)?);
    Ok(bytes)
}

pub fn digest<T: Serialize>(domain: &str, payload: &T) -> Result<String> {
    Ok(hex::encode(Sha256::digest(message(domain, payload)?)))
}

// New reservations use an independently reproducible invoice binding. Supplier
// invoice IDs contain 256 random bits, keeping the hash opaque without the invoice.
pub fn invoice_memo(invoice: &Invoice) -> Result<String> {
    Ok(format!(
        "prp:v2:{}",
        digest("private-recurring/memo/v2", invoice)?
    ))
}

pub fn sign<T: Serialize>(domain: &str, payload: &T, key: &SigningKey) -> Result<Approval> {
    Ok(Approval {
        key: hex::encode(key.verifying_key().to_bytes()),
        signature: hex::encode(key.sign(&message(domain, payload)?).to_bytes()),
    })
}

fn public_key(encoded: &str) -> Result<VerifyingKey> {
    ensure!(
        encoded.len() == 64
            && encoded
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "Public key must be canonical lowercase hex"
    );
    Ok(VerifyingKey::from_bytes(
        &hex::decode(encoded)?
            .try_into()
            .map_err(|_| anyhow::anyhow!("Invalid key length"))?,
    )?)
}

pub fn verify<T: Serialize>(
    domain: &str,
    envelope: &Envelope<T>,
    expected: &[String],
) -> Result<()> {
    ensure!(
        envelope.signatures.len() == expected.len(),
        "Incorrect number of approvals"
    );
    let expected: BTreeSet<_> = expected.iter().collect();
    ensure!(
        expected.len() == envelope.signatures.len(),
        "Approval policy contains duplicate keys"
    );
    let bytes = message(domain, &envelope.payload)?;
    let mut seen = BTreeSet::new();
    for approval in &envelope.signatures {
        ensure!(
            expected.contains(&approval.key) && seen.insert(&approval.key),
            "Unknown or duplicate approver"
        );
        let signature = Signature::try_from(hex::decode(&approval.signature)?.as_slice())?;
        public_key(&approval.key)?
            .verify_strict(&bytes, &signature)
            .context("Invalid authorization signature")?;
    }
    Ok(())
}

pub fn identifier(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty()
            && value.len() <= 64
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b)),
        "Invalid identifier"
    );
    Ok(())
}

pub fn amount(value: &str) -> Result<u64> {
    ensure!(
        !value.is_empty()
            && value.len() <= 16
            && value.bytes().all(|b| b.is_ascii_digit())
            && (value == "0" || !value.starts_with('0')),
        "Noncanonical zatoshi amount"
    );
    let n = value.parse::<u64>()?;
    ensure!(
        n <= 2_100_000_000_000_000,
        "Amount exceeds Zcash money range"
    );
    Ok(n)
}

pub fn receiver(encoded: &str) -> Result<orchard::Address> {
    match Address::decode(&crate::wallet::NETWORK, encoded)
        .context("Invalid testnet destination")?
    {
        Address::Unified(ua) if ua.transparent().is_none() && ua.sapling().is_none() => {
            Ok(*ua.orchard().context("Missing shielded receiver")?)
        }
        _ => bail!("Only a testnet Orchard-only unified address is allowed"),
    }
}

impl Trust {
    pub fn validate(&self) -> Result<()> {
        identifier(&self.context.company_id)?;
        identifier(&self.context.signer_id)?;
        ensure!(
            self.context.chain == "zcash-testnet",
            "Only testnet is supported"
        );
        ensure!(
            self.approvers[0] != self.approvers[1],
            "Two distinct company approvers required"
        );
        for key in self.approvers.iter().chain([&self.revoker]) {
            public_key(key)?;
        }
        Ok(())
    }
}

impl Schedule {
    pub fn period_end(&self, now: u64) -> Result<u64> {
        let period = self.period(now)?;
        match self {
            Self::TestnetInterval { interval_secs, .. } => period
                .start
                .checked_add(u64::from(*interval_secs))
                .context("Schedule overflow"),
            Self::CalendarMonth { .. } => {
                let current = OffsetDateTime::from_unix_timestamp(i64::try_from(period.start)?)?;
                let (year, month) = if current.month() == time::Month::December {
                    (current.year() + 1, time::Month::January)
                } else {
                    (current.year(), current.month().next())
                };
                Ok(Date::from_calendar_date(year, month, 1)?
                    .midnight()
                    .assume_utc()
                    .unix_timestamp()
                    .try_into()?)
            }
        }
    }
    pub fn period(&self, now: u64) -> Result<Period> {
        match *self {
            Schedule::TestnetInterval {
                anchor,
                interval_secs,
                payment_window_secs,
            } => {
                ensure!(
                    (60..=86_400).contains(&interval_secs)
                        && payment_window_secs > 0
                        && payment_window_secs <= interval_secs,
                    "Invalid testnet interval/window"
                );
                ensure!(now >= anchor, "Agreement has not started");
                let n = (now - anchor) / u64::from(interval_secs);
                let start = anchor + n * u64::from(interval_secs);
                Ok(Period {
                    id: format!("interval:{n}"),
                    start,
                    window_end: start
                        .checked_add(u64::from(payment_window_secs))
                        .context("Schedule overflow")?,
                })
            }
            Schedule::CalendarMonth {
                anchor,
                payment_window_secs,
            } => {
                let a = OffsetDateTime::from_unix_timestamp(i64::try_from(anchor)?)?;
                ensure!(
                    a.day() == 1 && a.hour() == 0 && a.minute() == 0 && a.second() == 0,
                    "Monthly anchor must be a UTC month boundary"
                );
                ensure!(
                    payment_window_secs > 0 && payment_window_secs <= 28 * 86_400,
                    "Invalid monthly payment window"
                );
                ensure!(now >= anchor, "Agreement has not started");
                let t = OffsetDateTime::from_unix_timestamp(i64::try_from(now)?)?;
                let start = Date::from_calendar_date(t.year(), t.month(), 1)?
                    .midnight()
                    .assume_utc()
                    .unix_timestamp() as u64;
                Ok(Period {
                    id: format!("month:{:04}-{:02}", t.year(), t.month() as u8),
                    start,
                    window_end: start + u64::from(payment_window_secs),
                })
            }
        }
    }
}

impl Agreement {
    pub fn validate(&self, trust: &Trust) -> Result<()> {
        trust.validate()?;
        ensure!(
            self.schema == 1 && self.version == 1,
            "Only initial version 1 is supported; amendments are disabled"
        );
        ensure!(
            self.context == trust.context,
            "Company, signer, or chain mismatch"
        );
        identifier(&self.agreement_id)?;
        public_key(&self.supplier_key)?;
        receiver(&self.recipient)?;
        ensure!(
            !trust.approvers.contains(&self.supplier_key),
            "Supplier key must be separate from company approvers"
        );
        let charge = amount(&self.amount_zatoshis)?;
        let fee = amount(&self.max_fee_zatoshis)?;
        ensure!(
            charge > 0 && fee > 0 && fee <= 100_000,
            "Invalid charge or fee cap"
        );
        ensure!((2..=50).contains(&self.max_actions), "Invalid action cap");
        ensure!(
            amount(&self.lifetime_limit_zatoshis)?
                >= charge.checked_add(fee).context("Budget overflow")?,
            "Lifetime cap must cover charge and maximum fee"
        );
        ensure!(
            self.valid_from < self.expires_at && self.expires_at <= 253_402_300_799,
            "Invalid agreement validity"
        );
        let anchor = match self.schedule {
            Schedule::CalendarMonth { anchor, .. } | Schedule::TestnetInterval { anchor, .. } => {
                anchor
            }
        };
        ensure!(
            anchor == self.valid_from,
            "Schedule anchor must equal agreement start"
        );
        self.schedule.period(anchor)?;
        Ok(())
    }

    pub fn validate_invoice(&self, invoice: &Envelope<Invoice>, now: u64) -> Result<Period> {
        verify(
            INVOICE_DOMAIN,
            invoice,
            std::slice::from_ref(&self.supplier_key),
        )?;
        let i = &invoice.payload;
        identifier(&i.invoice_id)?;
        ensure!(
            i.schema == 1
                && i.context == self.context
                && i.agreement_id == self.agreement_id
                && i.agreement_version == self.version
                && i.agreement_digest == digest(AGREEMENT_DOMAIN, self)?,
            "Invoice agreement binding mismatch"
        );
        ensure!(
            i.recipient == self.recipient && i.amount_zatoshis == self.amount_zatoshis,
            "Invoice changes approved amount or recipient"
        );
        ensure!(
            now >= self.valid_from && now < self.expires_at,
            "Agreement is outside its validity window"
        );
        let period = self.schedule.period(now)?;
        ensure!(
            i.period_id == period.id && now < period.window_end,
            "Invoice is not for the current payable period"
        );
        ensure!(
            i.issued_at >= period.start
                && i.issued_at <= now
                && i.expires_at > now
                && i.expires_at <= period.window_end.min(self.expires_at),
            "Invoice issuance or expiry is invalid"
        );
        Ok(period)
    }
}

pub fn now() -> Result<u64> {
    Ok(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs())
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use time::Month;
    pub fn fixture() -> (Trust, Envelope<Agreement>, SigningKey) {
        let a = SigningKey::from_bytes(&[1; 32]);
        let b = SigningKey::from_bytes(&[2; 32]);
        let supplier = SigningKey::from_bytes(&[3; 32]);
        let trust = Trust {
            context: Context {
                company_id: "test-company".into(),
                signer_id: "test-signer".into(),
                chain: "zcash-testnet".into(),
            },
            approvers: [
                hex::encode(a.verifying_key().to_bytes()),
                hex::encode(b.verifying_key().to_bytes()),
            ],
            revoker: hex::encode(a.verifying_key().to_bytes()),
        };
        let usk = zcash_keys::keys::UnifiedSpendingKey::from_seed(
            &crate::wallet::NETWORK,
            &[7; 64],
            zip32::AccountId::ZERO,
        )
        .unwrap();
        let (address, _) = usk
            .to_unified_full_viewing_key()
            .default_address(zcash_keys::keys::UnifiedAddressRequest::ORCHARD)
            .unwrap();
        let payload = Agreement {
            schema: 1,
            context: trust.context.clone(),
            agreement_id: "contract".into(),
            version: 1,
            supplier_key: hex::encode(supplier.verifying_key().to_bytes()),
            recipient: address.encode(&crate::wallet::NETWORK),
            amount_zatoshis: "1000000".into(),
            lifetime_limit_zatoshis: "2200000".into(),
            max_fee_zatoshis: "100000".into(),
            max_actions: 10,
            valid_from: 1000,
            expires_at: 2000,
            schedule: Schedule::TestnetInterval {
                anchor: 1000,
                interval_secs: 120,
                payment_window_secs: 120,
            },
        };
        let signatures = vec![
            sign(AGREEMENT_DOMAIN, &payload, &a).unwrap(),
            sign(AGREEMENT_DOMAIN, &payload, &b).unwrap(),
        ];
        (
            trust,
            Envelope {
                payload,
                signatures,
            },
            supplier,
        )
    }
    pub fn invoice(a: &Agreement, key: &SigningKey, now: u64, id: &str) -> Envelope<Invoice> {
        let p = a.schedule.period(now).unwrap();
        let payload = Invoice {
            schema: 1,
            context: a.context.clone(),
            agreement_id: a.agreement_id.clone(),
            agreement_version: a.version,
            agreement_digest: digest(AGREEMENT_DOMAIN, a).unwrap(),
            invoice_id: id.into(),
            period_id: p.id,
            recipient: a.recipient.clone(),
            amount_zatoshis: a.amount_zatoshis.clone(),
            issued_at: now,
            expires_at: p.window_end.min(a.expires_at),
        };
        let signatures = vec![sign(INVOICE_DOMAIN, &payload, key).unwrap()];
        Envelope {
            payload,
            signatures,
        }
    }
    #[test]
    fn strict_json_and_amounts() {
        for input in [
            r#"{"key":"a","key":"b","signature":"x"}"#,
            r#"{"key":"a","signature":"b","extra":1}"#,
        ] {
            assert!(decode::<Approval>(input.as_bytes()).is_err());
        }
        for value in ["01", "-1", "1.0", "1e6", "18446744073709551616"] {
            assert!(amount(value).is_err());
        }
        assert!(decode::<Approval>(br#"{"key":"\ud800","signature":"x"}"#).is_err());
    }
    #[test]
    fn signatures_bind_domain_and_exact_terms() {
        let (t, mut a, _) = fixture();
        a.payload.validate(&t).unwrap();
        verify(AGREEMENT_DOMAIN, &a, &t.approvers).unwrap();
        assert!(verify(INVOICE_DOMAIN, &a, &t.approvers).is_err());
        a.payload.amount_zatoshis = "2000000".into();
        assert!(verify(AGREEMENT_DOMAIN, &a, &t.approvers).is_err());
        let (_, mut a, _) = fixture();
        a.signatures[1] = a.signatures[0].clone();
        assert!(verify(AGREEMENT_DOMAIN, &a, &t.approvers).is_err());
        a.signatures.pop();
        assert!(verify(AGREEMENT_DOMAIN, &a, &t.approvers).is_err());
    }
    #[test]
    fn invoice_rejects_future_expired_and_changed_terms() {
        let (_, a, key) = fixture();
        let mut i = invoice(&a.payload, &key, 1010, "i");
        a.payload.validate_invoice(&i, 1010).unwrap();
        assert!(a.payload.validate_invoice(&i, 1120).is_err());
        assert!(a.payload.validate_invoice(&i, 1009).is_err());
        i.payload.amount_zatoshis = "1000001".into();
        i.signatures = vec![sign(INVOICE_DOMAIN, &i.payload, &key).unwrap()];
        assert!(a.payload.validate_invoice(&i, 1010).is_err());
    }
    #[test]
    fn service_period_end_uses_calendar_boundary_not_payment_window() {
        let start = Date::from_calendar_date(2024, time::Month::February, 1)
            .unwrap()
            .midnight()
            .assume_utc()
            .unix_timestamp() as u64;
        let schedule = Schedule::CalendarMonth {
            anchor: start,
            payment_window_secs: 86400,
        };
        let end = schedule.period_end(start).unwrap();
        assert_eq!(end - start, 29 * 86400);
        assert!(schedule.period(start).unwrap().window_end < end);
        let dec = Date::from_calendar_date(2024, time::Month::December, 1)
            .unwrap()
            .midnight()
            .assume_utc()
            .unix_timestamp() as u64;
        assert_eq!(schedule.period_end(dec).unwrap() - dec, 31 * 86400);
    }

    #[test]
    fn utc_months_cross_leap_year_and_year_boundary() {
        let anchor = Date::from_calendar_date(2024, Month::January, 1)
            .unwrap()
            .midnight()
            .assume_utc()
            .unix_timestamp() as u64;
        let s = Schedule::CalendarMonth {
            anchor,
            payment_window_secs: 28 * 86400,
        };
        for (y, m, d, id) in [
            (2024, Month::February, 29, "month:2024-02"),
            (2024, Month::December, 31, "month:2024-12"),
            (2025, Month::January, 1, "month:2025-01"),
        ] {
            let now = Date::from_calendar_date(y, m, d)
                .unwrap()
                .midnight()
                .assume_utc()
                .unix_timestamp() as u64;
            assert_eq!(s.period(now).unwrap().id, id);
        }
        assert!(s.period(anchor - 1).is_err());
    }
}
