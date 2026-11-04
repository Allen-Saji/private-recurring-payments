use crate::{
    engine,
    policy::{self, Agreement, Envelope, Invoice, Revocation, Trust},
    wallet,
};
use anyhow::{Context, Result, ensure};
use clap::{Subcommand, ValueEnum};
use ed25519_dalek::SigningKey;
use rand::Rng;
use std::{
    fs,
    path::{Path, PathBuf},
};
use zeroize::Zeroizing;

#[derive(Clone, ValueEnum)]
pub enum Kind {
    Agreement,
    Invoice,
    Revocation,
}
#[derive(Subcommand)]
pub enum Command {
    Keygen {
        #[arg(long)]
        out: PathBuf,
    },
    Sign {
        #[arg(long)]
        kind: Kind,
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        key: PathBuf,
        #[arg(long)]
        out: PathBuf,
        #[arg(long, required = true)]
        approve: bool,
    },
    Init {
        #[arg(long)]
        trust: PathBuf,
    },
    Install {
        #[arg(long)]
        agreement: PathBuf,
    },
    Revoke {
        #[arg(long)]
        revocation: PathBuf,
    },
    Submit {
        #[arg(long)]
        invoice: PathBuf,
    },
    Prepare {
        #[arg(long)]
        invoice: PathBuf,
    },
    Status {
        id: String,
    },
    Reconcile {
        id: String,
    },
    Rebroadcast {
        id: String,
    },
}

fn sign_file<T: serde::Serialize + serde::de::DeserializeOwned>(
    domain: &str,
    input: &Path,
    key: &SigningKey,
    out: &Path,
) -> Result<()> {
    let mut envelope: Envelope<T> = policy::decode(&fs::read(input)?)?;
    // The trusted owner CLI displays the exact canonical terms it is approving.
    println!(
        "Approving domain {domain}:\n{}",
        serde_jcs::to_string(&envelope.payload)?
    );
    let approval = policy::sign(domain, &envelope.payload, key)?;
    ensure!(
        !envelope.signatures.iter().any(|s| s.key == approval.key),
        "This key already approved these terms"
    );
    envelope.signatures.push(approval);
    wallet::write_new(out, &serde_json::to_vec_pretty(&envelope)?)?;
    Ok(())
}

pub async fn run(root: &Path, command: &Command) -> Result<()> {
    match command {
        Command::Keygen { out } => {
            wallet::private_dir(out.parent().context("Key file needs a parent directory")?)?;
            let mut bytes = Zeroizing::new([0u8; 32]);
            wallet::rng().fill_bytes(bytes.as_mut());
            wallet::write_new(out, bytes.as_ref())?;
            let key = SigningKey::from_bytes(&bytes);
            println!("{}", hex::encode(key.verifying_key().to_bytes()));
        }
        Command::Sign {
            kind,
            input,
            key,
            out,
            approve,
        } => {
            ensure!(*approve, "Explicit --approve is required");
            let bytes = Zeroizing::new(fs::read(key)?);
            ensure!(bytes.len() == 32, "Approval key must be 32 bytes");
            let key = SigningKey::from_bytes(bytes.as_slice().try_into()?);
            match kind {
                Kind::Agreement => {
                    sign_file::<Agreement>(policy::AGREEMENT_DOMAIN, input, &key, out)?
                }
                Kind::Invoice => sign_file::<Invoice>(policy::INVOICE_DOMAIN, input, &key, out)?,
                Kind::Revocation => {
                    sign_file::<Revocation>(policy::REVOKE_DOMAIN, input, &key, out)?
                }
            }
        }
        Command::Init { trust } => {
            wallet::private_dir(root)?;
            let config: Trust = policy::decode(&fs::read(trust)?)?;
            config.validate()?;
            wallet::write_new(
                &root.join("trust.json"),
                &serde_json::to_vec_pretty(&config)?,
            )?;
            engine::ledger(root)?;
            println!("Company approval keys pinned in signer ledger");
        }
        Command::Install { agreement } => {
            let e: Envelope<Agreement> = policy::decode(&fs::read(agreement)?)?;
            let hash = engine::ledger(root)?.install(&e)?;
            println!("Installed agreement digest: {hash}");
        }
        Command::Revoke { revocation } => {
            let e: Envelope<Revocation> = policy::decode(&fs::read(revocation)?)?;
            let n = engine::ledger(root)?.revoke(&e)?;
            println!(
                "Revocation durably acknowledged; {n} previously authorized occurrences remain recorded"
            );
        }
        Command::Submit { invoice } | Command::Prepare { invoice } => {
            let e: Envelope<Invoice> = policy::decode(&fs::read(invoice)?)?;
            let row = engine::execute(root, &e, matches!(command, Command::Submit { .. })).await?;
            println!("{}", engine::response(&row));
        }
        Command::Status { id } => println!("{}", engine::response(&engine::ledger(root)?.get(id)?)),
        Command::Reconcile { id } => {
            engine::reconcile(root, id).await?;
        }
        Command::Rebroadcast { id } => {
            println!(
                "{}",
                engine::response(&engine::rebroadcast(root, id).await?)
            );
        }
    }
    Ok(())
}
