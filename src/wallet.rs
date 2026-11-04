use anyhow::{Context, Result, ensure};
use rand::Rng;
use secrecy::SecretVec;
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
    time::Duration,
};
use zcash_client_backend::{
    data_api::{AccountBirthday, WalletRead, WalletWrite, wallet::ConfirmationsPolicy},
    proto::service::{
        BlockId, ChainSpec, Empty, compact_tx_streamer_client::CompactTxStreamerClient,
    },
};
use zcash_client_sqlite::{WalletDb, util::SystemClock, wallet::init::init_wallet_db};
use zcash_keys::keys::UnifiedAddressRequest;
use zcash_protocol::consensus::{BlockHeight, BranchId, Network};

pub const NETWORK: Network = Network::TestNetwork;
pub const SERVER: &str = "https://testnet.zec.rocks:443";
pub type WalletRng = rand_core::UnwrapErr<rand::rngs::SysRng>;
pub fn rng() -> WalletRng {
    rand_core::UnwrapErr(rand::rngs::SysRng)
}
pub type Db = WalletDb<rusqlite::Connection, Network, SystemClock, WalletRng>;

pub fn private_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    ensure!(
        !fs::symlink_metadata(path)?.file_type().is_symlink(),
        "State directory cannot be a symlink"
    );
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

pub fn write_new(path: &Path, data: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(data)?;
    file.sync_all()?;
    fs::File::open(path.parent().context("Missing parent directory")?)?.sync_all()?;
    Ok(())
}

pub fn open(path: &Path) -> Result<Db> {
    ensure!(path.join("wallet.sqlite").exists(), "Run init first");
    db(path)
}

fn db(path: &Path) -> Result<Db> {
    let conn = rusqlite::Connection::open(path.join("wallet.sqlite"))?;
    fs::set_permissions(
        path.join("wallet.sqlite"),
        fs::Permissions::from_mode(0o600),
    )?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    rusqlite::vtab::array::load_module(&conn)?;
    Ok(WalletDb::from_connection(conn, NETWORK, SystemClock, rng()))
}

pub async fn connect() -> Result<CompactTxStreamerClient<tonic::transport::Channel>> {
    tokio::time::timeout(Duration::from_secs(30), connect_inner())
        .await
        .context("Testnet connection and network check timed out")?
}

async fn connect_inner() -> Result<CompactTxStreamerClient<tonic::transport::Channel>> {
    let endpoint = tonic::transport::Channel::from_static(SERVER)
        .tls_config(tonic::transport::ClientTlsConfig::new().with_webpki_roots())?
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120));
    let mut client = CompactTxStreamerClient::new(endpoint.connect().await?);
    let info = client.get_lightd_info(Empty {}).await?.into_inner();
    ensure!(info.chain_name == "test", "Server is not on testnet");
    let reported = u32::from_str_radix(info.consensus_branch_id.trim_start_matches("0x"), 16)
        .context("Invalid server consensus branch")?;
    let expected = u32::from(BranchId::for_height(
        &NETWORK,
        BlockHeight::from_u32(u32::try_from(info.block_height)?),
    ));
    ensure!(
        reported == expected,
        "Consensus mismatch: server {reported:08x}, SDK {expected:08x}; signing is disabled"
    );
    Ok(client)
}

pub async fn init(path: &Path, name: &str) -> Result<()> {
    private_dir(path)?;
    ensure!(
        !path.join("seed.bin").exists() && !path.join("wallet.sqlite").exists(),
        "Wallet exists or initialization was interrupted; refusing to overwrite"
    );
    let mut client = connect().await?;
    let tip = client
        .get_latest_block(ChainSpec {})
        .await?
        .into_inner()
        .height;
    let tree = client
        .get_tree_state(BlockId {
            height: tip.saturating_sub(10),
            hash: vec![],
        })
        .await?
        .into_inner();
    let birthday = AccountBirthday::from_treestate(tree, None)?;
    let mut bytes = vec![0u8; 64];
    rng().fill_bytes(&mut bytes);
    write_new(&path.join("seed.bin"), &bytes)?;
    let seed = SecretVec::new(bytes);
    let mut db = db(path)?;
    init_wallet_db(&mut db, None)?;
    let (account, _) = db.create_account(name, &seed, &birthday, None)?;
    let (address, _) = db
        .get_next_available_address(account, UnifiedAddressRequest::ORCHARD)?
        .context("Could not generate shielded address")?;
    let public = json!({"network":"testnet", "address":address.encode(&NETWORK), "birthday":u32::from(birthday.height()), "role":name});
    write_new(
        &path.join("public.json"),
        &serde_json::to_vec_pretty(&public)?,
    )?;
    Ok(())
}

pub async fn sync(path: &Path) -> Result<()> {
    let mut client = connect().await?;
    let mut db = open(path)?;
    zcash_client_backend::sync::run(
        &mut client,
        &NETWORK,
        &crate::cache::MemoryCache::default(),
        &mut db,
        100,
    )
    .await
    .map_err(|e| anyhow::anyhow!("Sync failed: {e:?}"))?;
    Ok(())
}

pub fn status(path: &Path) -> Result<Value> {
    let mut public: Value = serde_json::from_slice(&fs::read(path.join("public.json"))?)?;
    let db = open(path)?;
    if let Some(summary) = db.get_wallet_summary(ConfirmationsPolicy::MIN)? {
        public["chainTip"] = json!(u32::from(summary.chain_tip_height()));
        public["scannedHeight"] = json!(u32::from(summary.fully_scanned_height()));
        let account = db
            .get_account_ids()?
            .into_iter()
            .next()
            .context("No account")?;
        if let Some(balance) = summary.account_balances().get(&account) {
            public["totalZatoshis"] = json!(u64::from(balance.total()).to_string());
            public["ironwoodSpendableZatoshis"] =
                json!(u64::from(balance.ironwood_balance().spendable_value()).to_string());
        }
    }
    Ok(public)
}
