use anyhow::{Context, Result};
use zcash_keys::address::Address;
use zcash_protocol::consensus::Network;

fn main() -> Result<()> {
    let encoded = std::env::args().nth(1).context("Pass a testnet address")?;
    let address = Address::decode(&Network::TestNetwork, &encoded)
        .context("Invalid address or wrong network")?;
    match address {
        Address::Unified(ua) => println!(
            "Valid testnet Unified Address: orchard={}, sapling={}, transparent={}",
            ua.orchard().is_some(),
            ua.sapling().is_some(),
            ua.transparent().is_some()
        ),
        _ => println!("Valid testnet address, not unified"),
    }
    Ok(())
}
