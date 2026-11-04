use anyhow::{Context, Result, ensure};
use zcash_client_backend::proto::service::{
    ChainSpec, Empty, TxFilter, compact_tx_streamer_client::CompactTxStreamerClient,
};
use zcash_primitives::transaction::{Transaction, TxId};
use zcash_protocol::consensus::{BlockHeight, BranchId, Network};

#[tokio::main]
async fn main() -> Result<()> {
    rustls::crypto::ring::default_provider()
        .install_default()
        .ok();
    let encoded = std::env::args().nth(1).context("Pass a transaction ID")?;
    let mut hash = hex::decode(&encoded)?;
    ensure!(hash.len() == 32, "Transaction ID must be 32 bytes");
    hash.reverse();
    let txid = TxId::from_bytes(hash.as_slice().try_into()?);
    let channel = tonic::transport::Channel::from_static("https://testnet.zec.rocks:443")
        .tls_config(tonic::transport::ClientTlsConfig::new().with_webpki_roots())?
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(30))
        .connect()
        .await?;
    let mut client = CompactTxStreamerClient::new(channel);
    ensure!(
        client
            .get_lightd_info(Empty {})
            .await?
            .into_inner()
            .chain_name
            == "test",
        "Not testnet"
    );
    let tip = client
        .get_latest_block(ChainSpec {})
        .await?
        .into_inner()
        .height;
    let raw = client
        .get_transaction(TxFilter {
            hash: txid.as_ref().to_vec(),
            ..Default::default()
        })
        .await?
        .into_inner();
    let mined = raw.height > 0 && raw.height < u64::from(u32::MAX) && raw.height <= tip;
    let height = if mined { raw.height } else { tip };
    let tx = Transaction::read(
        raw.data.as_slice(),
        BranchId::for_height(
            &Network::TestNetwork,
            BlockHeight::from_u32(u32::try_from(height)?),
        ),
    )?;
    ensure!(tx.txid() == txid, "Transaction identity mismatch");
    println!(
        "{}",
        serde_json::to_string_pretty(
            &serde_json::json!({"txid":encoded,"tip":tip,"mined_height":if mined{Some(raw.height)}else{None},"confirmations":if mined{tip-raw.height+1}else{0},"transparent_inputs":tx.transparent_bundle().map_or(0,|b|b.vin.len()),"transparent_outputs":tx.transparent_bundle().map_or(0,|b|b.vout.len()),"ironwood_actions":tx.ironwood_bundle().map_or(0,|b|b.actions().len()),"orchard_actions":tx.orchard_bundle().map_or(0,|b|b.actions().len()),"note":"Public chain metadata only; does not prove recipient or amount"})
        )?
    );
    Ok(())
}
