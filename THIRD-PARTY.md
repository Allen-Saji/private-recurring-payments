# Dependency attribution

- [Zipher](https://github.com/atmospherelabs-dev/zipher-app/tree/2e7ccd3c332e94aa496abff0b52b331726e9cb6b), MIT, revision `2e7ccd3c332e94aa496abff0b52b331726e9cb6b`. Its engine wallet, send, and sync implementations provided integration references. Copyright and license: [upstream LICENSE.md](https://github.com/atmospherelabs-dev/zipher-app/blob/2e7ccd3c332e94aa496abff0b52b331726e9cb6b/LICENSE.md).
- [Official librustzcash](https://github.com/zcash/librustzcash), MIT OR Apache-2.0: released wallet/backend/PCZT/protocol crates are pinned in `Cargo.lock`. The original Zipher dependency experiment was replaced after its protocol version failed to parse the active testnet's NU7 branch. No Zipher or Zakura fork is needed to build the current adapter.
- [Orchard](https://github.com/zcash/orchard) 0.16.0 supplies the shielded cryptography. Its original package license and notices remain in the downloaded source. No cryptographic primitive is reimplemented here.
- [Noir Wallet SDK](https://github.com/NoirWallet/noir-wallet/tree/main/packages/sdk), version 0.1.9, MIT. The npm package includes its license. Browser integration uses its public API.

Dependency sources and wallet data are not included in this repository. Cargo and npm fetch dependency packages with their original notices.
