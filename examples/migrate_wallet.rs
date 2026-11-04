use anyhow::{Context, Result, ensure};
use secrecy::{ExposeSecret, SecretVec};
use std::{fs, path::PathBuf};
use zcash_client_backend::data_api::WalletRead;
use zcash_client_sqlite::{WalletDb, util::SystemClock, wallet::init::init_wallet_db};
use zcash_keys::keys::{UnifiedAddressRequest, UnifiedSpendingKey};
use zcash_protocol::consensus::Network;

// Operate on an explicit private database copy, never an implicit active wallet.
fn main() -> Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    ensure!(
        args.len() == 2,
        "Usage: migrate_wallet DATABASE_COPY ORIGINAL_WALLET_DIRECTORY"
    );
    let copy = PathBuf::from(&args[0]);
    let original = PathBuf::from(&args[1]);
    ensure!(
        copy != original.join("wallet.sqlite"),
        "Use a database copy"
    );
    let seed = SecretVec::new(fs::read(original.join("seed.bin"))?);
    let public: serde_json::Value =
        serde_json::from_slice(&fs::read(original.join("public.json"))?)?;
    let usk = UnifiedSpendingKey::from_seed(
        &Network::TestNetwork,
        seed.expose_secret(),
        zip32::AccountId::ZERO,
    )
    .map_err(|_| anyhow::anyhow!("Key derivation failed"))?;
    let conn = rusqlite::Connection::open(copy)?;
    rusqlite::vtab::array::load_module(&conn)?;
    let mut db = WalletDb::from_connection(
        conn,
        Network::TestNetwork,
        SystemClock,
        rand_core::UnwrapErr(rand::rngs::SysRng),
    );
    init_wallet_db(&mut db, Some(seed))?;
    let accounts = db.get_account_ids()?;
    ensure!(accounts.len() == 1, "Unexpected account count");
    let address = db
        .get_last_generated_address_matching(accounts[0], UnifiedAddressRequest::ORCHARD)?
        .context("Missing generated address")?;
    ensure!(
        address.encode(&Network::TestNetwork)
            == public["address"]
                .as_str()
                .context("Missing public address")?,
        "Address changed in migration"
    );
    let keys = db.get_unified_full_viewing_keys()?;
    ensure!(
        keys[&accounts[0]].encode(&Network::TestNetwork)
            == usk
                .to_unified_full_viewing_key()
                .encode(&Network::TestNetwork),
        "Seed/account identity mismatch"
    );
    ensure!(
        u32::from(db.get_account_birthday(accounts[0])?) as u64
            == public["birthday"].as_u64().context("Missing birthday")?,
        "Birthday changed"
    );
    println!(
        "Migrated database copy: seed/account identity, shielded address, and birthday match."
    );
    Ok(())
}
