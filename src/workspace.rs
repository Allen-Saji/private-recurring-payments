//! Account-scoped testnet operations. The application derives this root from an
//! authenticated account; callers never supply a filesystem path over HTTP.
use crate::{
    engine, funding,
    policy::{self, Agreement, Envelope, Revocation, Schedule, Trust},
    supplier, wallet,
};
use anyhow::{Context, Result, ensure};
use ed25519_dalek::SigningKey;
use fs2::FileExt;
use rand::Rng;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{fs, io::Read, os::unix::fs::OpenOptionsExt, path::Path};
use zeroize::Zeroizing;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Action {
    Initialize {
        company: String,
        signer_id: String,
    },
    Status {},
    Sync {},
    Propose {
        #[serde(default = "default_service")]
        service_id: String,
        payments: u32,
        interval_secs: u32,
    },
    Approve {
        proposal_id: String,
        digest: String,
    },
    Cancel {},
    Tick {},
    VerifyFunding {
        txid: String,
    },
    Billing {
        before: Option<u64>,
    },
    BillingInvoice {
        invoice_id: String,
    },
    Recheck {
        invoice_id: String,
    },
    Access {
        invoice_id: String,
    },
}
fn default_service() -> String {
    "network-telemetry".into()
}
fn key(path: &Path) -> Result<SigningKey> {
    let bytes = Zeroizing::new(fs::read(path)?);
    ensure!(bytes.len() == 32, "Invalid workspace key");
    Ok(SigningKey::from_bytes(bytes.as_slice().try_into()?))
}
fn generate(path: &Path) -> Result<()> {
    if path.exists() {
        key(path)?;
        return Ok(());
    }
    let mut bytes = Zeroizing::new([0u8; 32]);
    wallet::rng().fill_bytes(bytes.as_mut());
    wallet::write_new(path, bytes.as_ref())
}
fn save_new<T: serde::Serialize>(path: &Path, value: &T) -> Result<()> {
    let bytes = serde_jcs::to_vec(value)?;
    if path.exists() {
        ensure!(fs::read(path)? == bytes, "Existing authorization differs");
    } else {
        wallet::write_new(path, &bytes)?;
    }
    Ok(())
}
fn agreement(root: &Path) -> Result<Option<Envelope<Agreement>>> {
    let file = root.join("agreement.approved.json");
    if file.exists() {
        Ok(Some(policy::decode(&fs::read(file)?)?))
    } else {
        Ok(None)
    }
}
fn status(root: &Path) -> Result<Value> {
    let overview = if root.join("trust.json").exists() {
        engine::ledger(root)?.overview()?
    } else {
        json!({"agreements":[],"payments":[]})
    };
    let operating = wallet::status(&root.join("operating"))?;
    let mut receipts = Vec::new();
    if root.join("noir-funding").exists() {
        for entry in fs::read_dir(root.join("noir-funding"))? {
            let e = entry?;
            if e.path().extension().and_then(|x| x.to_str()) == Some("json") {
                receipts.push((e.metadata()?.modified()?, e.path()));
            }
        }
    }
    receipts.sort_by_key(|(time, _)| *time);
    let receipt = receipts
        .last()
        .map(|(_, p)| -> Result<Value> { Ok(serde_json::from_slice(&fs::read(p)?)?) })
        .transpose()?;
    Ok(
        json!({"network":"testnet","consensus":"NU7","ready":true,"operating":operating,"fundingReady":true,"receipts":{"funding":receipt},"overview":overview,"updatedAtUnix":policy::now()?}),
    )
}
async fn initialize(root: &Path, company: &str, signer_id: &str) -> Result<Value> {
    policy::identifier(company)?;
    policy::identifier(signer_id)?;
    wallet::private_dir(&root.join("approvals"))?;
    for name in ["owner-a", "owner-b"] {
        generate(&root.join("approvals").join(name))?;
    }
    for role in ["operating", "supplier"] {
        let path = if role == "operating" {
            root.join("operating")
        } else {
            root.join("merchant/wallet")
        };
        if !path.join("public.json").exists() {
            wallet::init(&path, role).await?;
        }
    }
    generate(&root.join("merchant/invoice-signing.key"))?;
    let a = hex::encode(
        key(&root.join("approvals/owner-a"))?
            .verifying_key()
            .to_bytes(),
    );
    let b = hex::encode(
        key(&root.join("approvals/owner-b"))?
            .verifying_key()
            .to_bytes(),
    );
    let trust = Trust {
        context: policy::Context {
            company_id: company.into(),
            signer_id: signer_id.into(),
            chain: "zcash-testnet".into(),
        },
        approvers: [a.clone(), b],
        revoker: a,
    };
    trust.validate()?;
    save_new(&root.join("trust.json"), &trust)?;
    engine::ledger(root)?;
    wallet::sync(&root.join("operating")).await?;
    status(root)
}
fn terms(
    trust: &Trust,
    recipient: String,
    supplier_key: String,
    id: String,
    payments: u32,
    interval: u32,
    now: u64,
) -> Result<Agreement> {
    ensure!(
        (1..=3).contains(&payments) && [600, 3600, 86400].contains(&interval),
        "Choose 1-3 payments, every 10 minutes, hour or day"
    );
    let a = Agreement {
        schema: 1,
        context: trust.context.clone(),
        agreement_id: id,
        version: 1,
        supplier_key,
        recipient,
        amount_zatoshis: "1000000".into(),
        lifetime_limit_zatoshis: (u64::from(payments) * 1_100_000).to_string(),
        max_fee_zatoshis: "100000".into(),
        max_actions: 10,
        valid_from: now,
        expires_at: now + u64::from(payments) * u64::from(interval),
        schedule: Schedule::TestnetInterval {
            anchor: now,
            interval_secs: interval,
            payment_window_secs: interval,
        },
    };
    a.validate(trust)?;
    Ok(a)
}
async fn run(root: &Path, action: Action) -> Result<Value> {
    match action {
        Action::Initialize { company, signer_id } => initialize(root, &company, &signer_id).await,
        Action::Status {} => status(root),
        Action::Sync {} => {
            wallet::sync(&root.join("operating")).await?;
            status(root)
        }
        Action::VerifyFunding { txid } => {
            funding::verify(root, &txid).await?;
            status(root)
        }
        Action::Propose {
            service_id,
            payments,
            interval_secs,
        } => {
            ensure!(service_id == default_service(), "Service is not available");
            ensure!(
                agreement(root)?.is_none(),
                "This workspace already has a subscription agreement"
            );
            let trust: Trust = policy::decode(&fs::read(root.join("trust.json"))?)?;
            let recipient = wallet::status(&root.join("merchant/wallet"))?["address"]
                .as_str()
                .context("Supplier address unavailable")?
                .to_string();
            let pubkey = hex::encode(
                key(&root.join("merchant/invoice-signing.key"))?
                    .verifying_key()
                    .to_bytes(),
            );
            let mut nonce = [0u8; 16];
            wallet::rng().fill_bytes(&mut nonce);
            let id = hex::encode(nonce);
            let a = terms(
                &trust,
                recipient,
                pubkey,
                id.clone(),
                payments,
                interval_secs,
                policy::now()?,
            )?;
            wallet::private_dir(&root.join("proposals"))?;
            save_new(&root.join("proposals").join(format!("{id}.json")), &a)?;
            Ok(
                json!({"proposal_id":id,"digest":policy::digest(policy::AGREEMENT_DOMAIN,&a)?,"terms":a,"review_expires_at":a.valid_from+300}),
            )
        }
        Action::Approve {
            proposal_id,
            digest,
        } => {
            policy::identifier(&proposal_id)?;
            let a: Agreement = policy::decode(&fs::read(
                root.join("proposals").join(format!("{proposal_id}.json")),
            )?)?;
            ensure!(
                policy::digest(policy::AGREEMENT_DOMAIN, &a)? == digest,
                "Reviewed agreement changed"
            );
            if let Some(old) = agreement(root)? {
                ensure!(
                    policy::digest(policy::AGREEMENT_DOMAIN, &old.payload)? == digest,
                    "Another agreement is already authorized"
                );
            } else {
                wallet::sync(&root.join("operating")).await?;
                let available =
                    wallet::status(&root.join("operating"))?["ironwoodSpendableZatoshis"]
                        .as_str()
                        .unwrap_or("0")
                        .parse::<u64>()?;
                ensure!(
                    available >= 1_100_000,
                    "Add at least 0.011 TAZ before authorizing payments"
                );
                ensure!(
                    policy::now()? < a.valid_from + 300,
                    "Review expired; create a new proposal"
                );
            }
            let mut e = Envelope {
                payload: a,
                signatures: vec![],
            };
            for name in ["owner-a", "owner-b"] {
                e.signatures.push(policy::sign(
                    policy::AGREEMENT_DOMAIN,
                    &e.payload,
                    &key(&root.join("approvals").join(name))?,
                )?);
            }
            save_new(&root.join("agreement.approved.json"), &e)?;
            engine::ledger(root)?.install(&e)?;
            if !root.join("merchant/config.json").exists() {
                supplier::run(
                    &root.join("merchant"),
                    &supplier::Command::Configure {
                        agreement: root.join("agreement.approved.json"),
                        trust: root.join("trust.json"),
                        confirmations: 2,
                    },
                )
                .await?;
            } else {
                let existing =
                    supplier::execute(&root.join("merchant"), json!({"op":"overview"})).await?;
                ensure!(
                    existing["agreement"] == serde_json::to_value(&e)?,
                    "Supplier agreement differs from authorization"
                );
            }
            status(root)
        }
        Action::Cancel {} => {
            let e = agreement(root)?.context("No agreement to cancel")?;
            let r = Revocation {
                schema: 1,
                context: e.payload.context.clone(),
                agreement_id: e.payload.agreement_id.clone(),
                agreement_digest: policy::digest(policy::AGREEMENT_DOMAIN, &e.payload)?,
                sequence: 1,
            };
            let signed = Envelope {
                signatures: vec![policy::sign(
                    policy::REVOKE_DOMAIN,
                    &r,
                    &key(&root.join("approvals/owner-a"))?,
                )?],
                payload: r,
            };
            save_new(&root.join("revocation.json"), &signed)?;
            engine::ledger(root)?.revoke(&signed)?;
            supplier::run(
                &root.join("merchant"),
                &supplier::Command::Revoke {
                    revocation: root.join("revocation.json"),
                },
            )
            .await?;
            status(root)
        }
        Action::Billing { before } => {
            if agreement(root)?.is_none() {
                return Ok(
                    json!({"invoices":[],"next_cursor":null,"currency":"TAZ","as_of":policy::now()?,"agreement":null,"observations_are_cached":true,"totals":{"billed_zatoshis":"0","paid_zatoshis":"0","pending_zatoshis":"0","unpaid_zatoshis":"0","invoice_count":0,"paid_count":0,"pending_count":0,"unpaid_count":0}}),
                );
            }
            supplier::execute(
                &root.join("merchant"),
                json!({"op":"billing","before":before}),
            )
            .await
        }
        Action::BillingInvoice { invoice_id } => {
            supplier::execute(
                &root.join("merchant"),
                json!({"op":"billing_invoice","invoice_id":invoice_id}),
            )
            .await
        }
        Action::Access { invoice_id } => {
            supplier::execute(
                &root.join("merchant"),
                json!({"op":"access","invoice_id":invoice_id}),
            )
            .await
        }
        Action::Recheck { invoice_id } => {
            let detail = supplier::execute(
                &root.join("merchant"),
                json!({"op":"billing_invoice","invoice_id":invoice_id}),
            )
            .await?;
            let tx = detail["txid"]
                .as_str()
                .or_else(|| detail["payment_candidate"]["txid"].as_str())
                .context("No payment has been submitted")?;
            supplier::execute(
                &root.join("merchant"),
                json!({"op":"settle","invoice_id":invoice_id,"txid":tx}),
            )
            .await
        }
        Action::Tick {} => {
            let e = agreement(root)?.context("No agreement is authorized")?;
            let overview = engine::ledger(root)?.overview()?;
            ensure!(
                !overview["agreements"][0]["revoked"]
                    .as_bool()
                    .unwrap_or(true),
                "Agreement is cancelled"
            );
            wallet::private_dir(&root.join("requests"))?;
            let now = policy::now()?;
            let current_period = e.payload.schedule.period(now)?.id;
            let mut current_requested = false;
            // Reconcile earlier persisted invoices before considering a new period.
            for entry in fs::read_dir(root.join("requests"))? {
                let entry = entry?;
                if entry.path().extension().and_then(|x| x.to_str()) != Some("json") {
                    continue;
                }
                let invoice: Envelope<policy::Invoice> = policy::decode(&fs::read(entry.path())?)?;
                current_requested |= invoice.payload.period_id == current_period;
                if let Ok(row) = engine::execute(root, &invoice, true).await
                    && let Some(txid) = row.txid
                {
                    let _ = supplier::execute(
                        &root.join("merchant"),
                        json!({"op":"settle","invoice_id":invoice.payload.invoice_id,"txid":txid}),
                    )
                    .await;
                    let _ = engine::reconcile(root, &row.id).await;
                }
            }
            if current_requested || policy::now()? >= e.payload.expires_at {
                return status(root);
            }
            wallet::sync(&root.join("operating")).await?;
            let balance = wallet::status(&root.join("operating"))?;
            let available = balance["ironwoodSpendableZatoshis"]
                .as_str()
                .unwrap_or("0")
                .parse::<u64>()?;
            ensure!(
                available >= 1_100_000,
                "Add at least 0.011 TAZ before the next payment"
            );
            let issued = supplier::execute(&root.join("merchant"), json!({"op":"invoice"})).await?;
            let invoice: Envelope<policy::Invoice> =
                serde_json::from_value(issued["envelope"].clone())?;
            save_new(
                &root
                    .join("requests")
                    .join(format!("{}.json", invoice.payload.invoice_id)),
                &invoice,
            )?;
            let row = engine::execute(root, &invoice, true).await?;
            if let Some(txid) = row.txid {
                let _ = supplier::execute(
                    &root.join("merchant"),
                    json!({"op":"settle","invoice_id":invoice.payload.invoice_id,"txid":txid}),
                )
                .await;
                let _ = engine::reconcile(root, &row.id).await;
            }
            status(root)
        }
    }
}
pub async fn rpc(root: &Path) -> Result<()> {
    wallet::private_dir(root)?;
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(root.join("workspace.lock"))?;
    lock.try_lock_exclusive()
        .context("Workspace is processing another operation")?;
    let mut bytes = Vec::new();
    std::io::stdin().take(32769).read_to_end(&mut bytes)?;
    let result = match policy::decode::<Action>(&bytes) {
        Ok(action) => run(root, action).await,
        Err(error) => Err(error),
    };
    println!(
        "WORKSPACE_RESULT:{}",
        match result {
            Ok(value) => json!({"ok":true,"result":value}),
            Err(error) => json!({"ok":false,"error":error.to_string()}),
        }
    );
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn unsupported_service_cannot_create_an_authorization() {
        let root = tempfile::tempdir().unwrap();
        let error = run(
            root.path(),
            Action::Propose {
                service_id: "unlisted-supplier".into(),
                payments: 1,
                interval_secs: 600,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.to_string(), "Service is not available");
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    }
    #[test]
    fn published_catalog_matches_signer_amounts_and_schedule_bounds() {
        let catalog: Value = serde_json::from_str(include_str!("../shared/catalog.json")).unwrap();
        let service = &catalog["services"][0];
        assert_eq!(service["id"], default_service());
        let (trust, original, key) = policy::tests::fixture();
        for interval in service["intervals"].as_array().unwrap() {
            for count in service["payment_counts"].as_array().unwrap() {
                let plan = terms(
                    &trust,
                    original.payload.recipient.clone(),
                    hex::encode(key.verifying_key().to_bytes()),
                    "catalog-check".into(),
                    count.as_u64().unwrap() as u32,
                    interval["seconds"].as_u64().unwrap() as u32,
                    1000,
                )
                .unwrap();
                assert_eq!(service["amount_zatoshis"], plan.amount_zatoshis);
                assert_eq!(service["max_fee_zatoshis"], plan.max_fee_zatoshis);
                let per_payment = policy::amount(&plan.amount_zatoshis).unwrap()
                    + policy::amount(&plan.max_fee_zatoshis).unwrap();
                assert_eq!(
                    policy::amount(&plan.lifetime_limit_zatoshis).unwrap(),
                    per_payment * count.as_u64().unwrap()
                );
            }
        }
    }
    #[test]
    fn service_terms_bound_payments_and_fee_allowance() {
        let (t, a, k) = policy::tests::fixture();
        let key = hex::encode(k.verifying_key().to_bytes());
        let plan = terms(
            &t,
            a.payload.recipient.clone(),
            key.clone(),
            "plan".into(),
            3,
            600,
            1000,
        )
        .unwrap();
        assert_eq!(plan.lifetime_limit_zatoshis, "3300000");
        assert_eq!(plan.expires_at, 2800);
        assert!(terms(&t, a.payload.recipient, key, "plan".into(), 4, 600, 1000).is_err());
    }
    #[test]
    fn rpc_rejects_external_paths_and_payment_overrides() {
        assert!(policy::decode::<Action>(br#"{"op":"status","state_dir":"/other"}"#).is_err());
        assert!(
            policy::decode::<Action>(
                br#"{"op":"propose","payments":3,"interval_secs":600,"recipient":"stolen"}"#
            )
            .is_err()
        );
    }
}
