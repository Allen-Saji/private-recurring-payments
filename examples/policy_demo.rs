use anyhow::{Context, Result, ensure};
use ed25519_dalek::SigningKey;
use private_recurring_wallet::{
    policy::{self, Agreement, Context as Binding, Envelope, Invoice, Revocation, Schedule, Trust},
    wallet,
};
use rand::Rng;
use std::{fs, path::PathBuf};
use zeroize::Zeroizing;

fn key(path: &std::path::Path) -> Result<SigningKey> {
    let bytes = Zeroizing::new(fs::read(path)?);
    ensure!(bytes.len() == 32, "Invalid key length");
    Ok(SigningKey::from_bytes(bytes.as_slice().try_into()?))
}
fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    ensure!(
        args.len() >= 3,
        "Usage: policy_demo init|invoice|revoke WALLET_ROOT DEMO_DIR [invoice-label]"
    );
    let root = PathBuf::from(&args[1]);
    let demo = PathBuf::from(&args[2]);
    match args[0].as_str() {
        "init" => {
            wallet::private_dir(&demo)?;
            wallet::private_dir(&demo.join("keys"))?;
            wallet::private_dir(&demo.join("messages"))?;
            let mut pubs = Vec::new();
            for name in ["owner-a", "owner-b", "supplier"] {
                let mut bytes = Zeroizing::new([0u8; 32]);
                wallet::rng().fill_bytes(bytes.as_mut());
                wallet::write_new(&demo.join("keys").join(name), bytes.as_ref())?;
                pubs.push(hex::encode(
                    SigningKey::from_bytes(&bytes).verifying_key().to_bytes(),
                ));
            }
            let context = Binding {
                company_id: "atlas-testnet".into(),
                signer_id: "recurring-signer-01".into(),
                chain: "zcash-testnet".into(),
            };
            let trust = Trust {
                context: context.clone(),
                approvers: [pubs[0].clone(), pubs[1].clone()],
                revoker: pubs[0].clone(),
            };
            wallet::write_new(
                &demo.join("trust.json"),
                &serde_json::to_vec_pretty(&trust)?,
            )?;
            let public: serde_json::Value =
                serde_json::from_slice(&fs::read(root.join("supplier/public.json"))?)?;
            let start = policy::now()?;
            let a = Agreement {
                schema: 1,
                context,
                agreement_id: "signalfeed-recurring-001".into(),
                version: 1,
                supplier_key: pubs[2].clone(),
                recipient: public["address"]
                    .as_str()
                    .context("Missing supplier address")?
                    .into(),
                amount_zatoshis: "1000000".into(),
                lifetime_limit_zatoshis: "3300000".into(),
                max_fee_zatoshis: "100000".into(),
                max_actions: 10,
                valid_from: start,
                expires_at: start + 86_400,
                schedule: Schedule::TestnetInterval {
                    anchor: start,
                    interval_secs: 120,
                    payment_window_secs: 120,
                },
            };
            a.validate(&trust)?;
            let e = Envelope {
                payload: a,
                signatures: vec![],
            };
            wallet::write_new(
                &demo.join("agreement.unsigned.json"),
                &serde_json::to_vec_pretty(&e)?,
            )?;
            println!(
                "Generated private demo approval/supplier keys and unsigned two-minute testnet agreement; no spending authorization installed."
            );
        }
        "invoice" => {
            let label = args.get(3).context("Invoice label required")?;
            policy::identifier(label)?;
            let a: Envelope<Agreement> =
                policy::decode(&fs::read(demo.join("agreement.approved.json"))?)?;
            let now = policy::now()?;
            let period = a.payload.schedule.period(now)?;
            let invoice = Invoice {
                schema: 1,
                context: a.payload.context.clone(),
                agreement_id: a.payload.agreement_id.clone(),
                agreement_version: a.payload.version,
                agreement_digest: policy::digest(policy::AGREEMENT_DOMAIN, &a.payload)?,
                invoice_id: label.clone(),
                period_id: period.id,
                recipient: a.payload.recipient.clone(),
                amount_zatoshis: a.payload.amount_zatoshis.clone(),
                issued_at: now,
                expires_at: period.window_end.min(a.payload.expires_at),
            };
            let key = key(&demo.join("keys/supplier"))?;
            for variant in ["valid", "wrong-amount", "wrong-recipient", "duplicate"] {
                let mut i = invoice.clone();
                match variant {
                    "wrong-amount" => i.amount_zatoshis = "2000000".into(),
                    "wrong-recipient" => {
                        let p: serde_json::Value =
                            serde_json::from_slice(&fs::read(root.join("operating/public.json"))?)?;
                        i.recipient = p["address"].as_str().unwrap().into();
                    }
                    "duplicate" => i.invoice_id = format!("{label}-replacement"),
                    _ => (),
                }
                let e = Envelope {
                    signatures: vec![policy::sign(policy::INVOICE_DOMAIN, &i, &key)?],
                    payload: i,
                };
                wallet::write_new(
                    &demo
                        .join("messages")
                        .join(format!("{label}-{variant}.json")),
                    &serde_json::to_vec_pretty(&e)?,
                )?;
            }
            println!(
                "Generated supplier-signed invoice variants for current period, expires at {}",
                invoice.expires_at
            );
        }
        "revoke" => {
            let a: Envelope<Agreement> =
                policy::decode(&fs::read(demo.join("agreement.approved.json"))?)?;
            let r = Revocation {
                schema: 1,
                context: a.payload.context.clone(),
                agreement_id: a.payload.agreement_id.clone(),
                agreement_digest: policy::digest(policy::AGREEMENT_DOMAIN, &a.payload)?,
                sequence: 1,
            };
            let e = Envelope {
                signatures: vec![policy::sign(
                    policy::REVOKE_DOMAIN,
                    &r,
                    &key(&demo.join("keys/owner-a"))?,
                )?],
                payload: r,
            };
            wallet::write_new(
                &demo.join("revocation.json"),
                &serde_json::to_vec_pretty(&e)?,
            )?;
        }
        _ => anyhow::bail!("Unknown demo operation"),
    }
    Ok(())
}
