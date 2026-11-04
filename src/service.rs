use crate::{
    engine,
    policy::{self, Envelope, Invoice},
    wallet,
};
use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::os::unix::fs::{FileTypeExt, OpenOptionsExt};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use subtle::ConstantTimeEq;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
};
use zeroize::{Zeroize, Zeroizing};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    token: String,
    action: Action,
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Action {
    Overview {},
    Submit { invoice: Box<Envelope<Invoice>> },
    Status { payment_id: String },
}

async fn handle(mut stream: UnixStream, root: Arc<PathBuf>, token_hash: [u8; 32]) -> Result<()> {
    let mut request = tokio::time::timeout(Duration::from_secs(5), async {
        let n = stream.read_u32().await?;
        ensure!(n <= 32_768, "Request too large");
        let mut bytes = vec![0; n as usize];
        stream.read_exact(&mut bytes).await?;
        policy::decode::<Request>(&bytes)
    })
    .await
    .context("Request deadline exceeded")??;
    let candidate: [u8; 32] = Sha256::digest(request.token.as_bytes()).into();
    request.token.zeroize();
    ensure!(
        bool::from(candidate.ct_eq(&token_hash)),
        "Unauthorized execution credential"
    );
    let result: Result<serde_json::Value> = match request.action {
        Action::Overview {} => engine::ledger(&root).and_then(|l| l.overview()),
        Action::Submit { invoice } => engine::execute(&root, &invoice, true)
            .await
            .map(|r| engine::response(&r)),
        Action::Status { payment_id } => status(&root, &payment_id).await,
    };
    let response = match result {
        Ok(value) => serde_json::json!({"ok":true,"result":value}),
        Err(error) => serde_json::json!({"ok":false,"error":error.to_string()}),
    };
    let bytes = serde_json::to_vec(&response)?;
    tokio::time::timeout(Duration::from_secs(5), async {
        stream.write_u32(bytes.len() as u32).await?;
        stream.write_all(&bytes).await
    })
    .await??;
    Ok(())
}

async fn status(root: &Path, id: &str) -> Result<serde_json::Value> {
    let row = engine::ledger(root)?.get(id)?;
    if (row.state == "broadcast_unknown" || row.state == "confirmed")
        && let Err(error) = engine::reconcile(root, id).await
    {
        let mut response = engine::response(&engine::ledger(root)?.get(id)?);
        response["state"] = serde_json::json!("verification_pending");
        response["observation_error"] = serde_json::json!(error.to_string());
        return Ok(response);
    }
    Ok(engine::response(&engine::ledger(root)?.get(id)?))
}

pub async fn serve(root: &Path, socket: &Path, token_file: &Path) -> Result<()> {
    engine::ledger(root)?;
    wallet::private_dir(
        socket
            .parent()
            .context("Socket requires a parent directory")?,
    )?;
    let socket_lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(socket.with_extension("lock"))?;
    socket_lock
        .try_lock_exclusive()
        .context("Execution endpoint already has an active owner")?;
    if socket.exists() {
        ensure!(
            std::fs::symlink_metadata(socket)?.file_type().is_socket(),
            "Refusing to replace a non-socket endpoint"
        );
        match UnixStream::connect(socket).await {
            Ok(_) => anyhow::bail!("A process is already listening on this endpoint"),
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => {
                use rand::Rng;
                let mut suffix = [0u8; 8];
                wallet::rng().fill_bytes(&mut suffix);
                std::fs::rename(
                    socket,
                    socket.with_extension(format!("stale-{}", hex::encode(suffix))),
                )?;
            }
            Err(error) => return Err(error.into()),
        }
    }
    let token = Zeroizing::new(std::fs::read_to_string(token_file)?);
    let token = token.trim();
    ensure!(
        token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit()),
        "Execution token must be 32 random bytes in hex"
    );
    let token_hash: [u8; 32] = Sha256::digest(token.as_bytes()).into();
    let listener = UnixListener::bind(socket)?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(socket, std::fs::Permissions::from_mode(0o600))?;
    eprintln!("Execution socket ready: {}", socket.display());
    let root = Arc::new(root.to_owned());
    let slots = Arc::new(tokio::sync::Semaphore::new(8));
    loop {
        let (stream, _) = listener.accept().await?;
        let Ok(permit) = slots.clone().try_acquire_owned() else {
            drop(stream);
            continue;
        };
        let root = root.clone();
        tokio::spawn(async move {
            let _permit = permit;
            if handle(stream, root, token_hash).await.is_err() {
                eprintln!("Execution request rejected before response");
            }
        });
    }
}
