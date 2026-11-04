use anyhow::Result;
use clap::{Parser, Subcommand};
use fs2::FileExt;
use private_recurring_wallet::{control, funding, payment, service, supplier, wallet};
use std::{fs::OpenOptions, os::unix::fs::OpenOptionsExt, path::PathBuf};

#[derive(Parser)]
#[command(about = "Private recurring payments: testnet wallet integration")]
struct Args {
    #[arg(long)]
    state_dir: PathBuf,
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    Supplier {
        #[command(subcommand)]
        command: supplier::Command,
    },
    Serve {
        #[arg(long)]
        socket: PathBuf,
        #[arg(long)]
        execution_token_file: PathBuf,
    },
    Policy {
        #[command(subcommand)]
        command: control::Command,
    },
    Init,
    Sync,
    Status,
    Prepare,
    Recover,
    Broadcast,
    Verify,
    VerifyFunding {
        txid: String,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    rustls::crypto::ring::default_provider()
        .install_default()
        .ok();
    let args = Args::parse();
    if let Command::Supplier { command } = &args.command {
        return supplier::run(&args.state_dir, command).await;
    }
    if let Command::Policy { command } = &args.command {
        return control::run(&args.state_dir, command).await;
    }
    if let Command::Serve {
        socket,
        execution_token_file,
    } = &args.command
    {
        return service::serve(&args.state_dir, socket, execution_token_file).await;
    }
    wallet::private_dir(&args.state_dir)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(args.state_dir.join("wallet.lock"))?;
    lock.try_lock_exclusive()
        .map_err(|_| anyhow::anyhow!("Another wallet command is running"))?;
    wallet::connect().await?;
    match &args.command {
        Command::Prepare => payment::prepare(&args.state_dir)?,
        Command::Recover => payment::recover(&args.state_dir)?,
        Command::Broadcast => payment::broadcast(&args.state_dir).await?,
        Command::Verify => payment::verify(&args.state_dir).await?,
        Command::VerifyFunding { txid } => funding::verify(&args.state_dir, txid).await?,
        _ => (),
    }
    for name in ["operating", "supplier"] {
        let path = args.state_dir.join(name);
        match args.command {
            Command::Init => wallet::init(&path, name).await?,
            Command::Sync => {
                eprintln!("Syncing {name} testnet wallet...");
                wallet::sync(&path).await?;
            }
            _ => (),
        }
    }
    let receipts = serde_json::json!({
        "supplier": latest_receipt(&args.state_dir.join("payment-001"), "verified-at-")?,
        "funding": latest_receipt(&args.state_dir.join("noir-funding"), "")?,
    });
    let result = serde_json::json!({"network":"testnet", "fundingReady":true, "receipts":receipts, "updatedAtUnix":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_secs(), "operating":wallet::status(&args.state_dir.join("operating"))?, "supplier":wallet::status(&args.state_dir.join("supplier"))?});
    let bytes = serde_json::to_vec_pretty(&result)?;
    let tmp = args.state_dir.join("public-status.next.json");
    std::fs::write(&tmp, &bytes)?;
    std::fs::rename(tmp, args.state_dir.join("public-status.json"))?;
    println!("{}", String::from_utf8(bytes)?);
    Ok(())
}

fn latest_receipt(dir: &std::path::Path, prefix: &str) -> Result<serde_json::Value> {
    if !dir.exists() {
        return Ok(serde_json::Value::Null);
    }
    let mut candidates = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(prefix) && name.ends_with(".json") {
            candidates.push((entry.metadata()?.modified()?, entry.path()));
        }
    }
    candidates.sort_by_key(|(time, _)| *time);
    match candidates.last() {
        Some((_, path)) => Ok(serde_json::from_slice(&std::fs::read(path)?)?),
        None => Ok(serde_json::Value::Null),
    }
}
