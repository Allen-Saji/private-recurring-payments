# Private recurring payments

A Zcash testnet signer for company-approved recurring supplier payments. Two pinned company keys approve fixed terms; the supplier signs period invoices; an isolated Rust service enforces those terms before signing a shielded transaction. A React funding page connects to Noir and funds the operating wallet.

Agreement authorization, monthly UTC and testnet interval schedules, revocation, a durable occurrence ledger, authenticated execution API, and an agent client are implemented. A separately confined supplier issues persistent invoices, independently verifies shielded receipts, and gates a live testnet telemetry API. A durable recurring worker collects invoices and handles payment-to-service delivery. A local authenticated HTTP bridge exposes the backend to application servers; six MCP tools expose the constrained flow to AI agent hosts. Amendments, production key custody and multi-tenant internet authentication remain outside this implementation. See the [agreement operator guide](docs/agreements.md) and [backend API and deployment guide](docs/backend-api.md).

## Build

Requires Linux, Rust 1.96 or compatible, Node 22, npm, a C compiler, and CMake. Dependencies are pinned in the lockfiles:

```sh
bash scripts/bootstrap.sh
```

The adapter uses the official NU7-compatible releases: `zcash_client_backend` 0.25.0, `zcash_client_sqlite` 0.23.0, `pczt` 0.10.0, `zcash_protocol` 0.11.0, `zcash_primitives` 0.31.0, `zcash_keys` 0.17.0 and `orchard` 0.16.0. No vendored patches or unstable consensus flags are needed. See [dependency attribution](THIRD-PARTY.md).

## Create and sync test wallets

Keep state outside this checkout. Each wallet has a separate random 64-byte seed and database. Initialization refuses to overwrite existing wallets. Seeds are raw seed bytes, not BIP39 phrases; back up the whole state directory if needed.

```sh
export WALLET_STATE_DIR="$HOME/.local/share/private-recurring-testnet"
target/debug/private-recurring-wallet --state-dir "$WALLET_STATE_DIR" init
target/debug/private-recurring-wallet --state-dir "$WALLET_STATE_DIR" sync
```

The adapter connects only to `https://testnet.zec.rocks:443` and checks that the server reports testnet and the same consensus branch as the SDK at its height. A mismatch blocks commands before signing. Generated funding addresses contain only an Orchard receiver, also used for Ironwood payments. Mainnet operation is not exposed.

## Fund through Noir

Install a NU7-compatible Noir testnet build. The live check below used the official [PR53 preview](https://github.com/NoirWallet/noir-wallet/pull/53), merge commit `4b6e0bf63c56e2e9ecb7392babb9758b2c15b53a`; it is an unreleased preview. Stable v1.0.40's embedded library predates active NU7 sends, although its connection and balance APIs work. Mainnet and testnet are separate extension builds. If both are installed, disable the mainnet extension while testing because either can answer the shared provider request.

Create a fresh test wallet in Noir. Request TAZ at [Fauzec](https://fauzec.com/) using Noir's testnet receiving address, then let Noir sync. Valar's faucet returned a known payout failure during integration; see [its open issue](https://github.com/valargroup/valar-testnet-faucet/issues/5). If test funds are transparent, shield them in Noir before using this page.

```sh
WALLET_STATE_DIR="$HOME/.local/share/private-recurring-testnet" node web/server.mjs
```

Open `http://localhost:4173` in the browser containing Noir. Use `localhost`: Noir v1.0.40 injects its provider on `http://localhost/*`, but not on `http://127.0.0.1/*`. Connect the account, review the 0.05 TAZ destination, and approve in Noir. The page uses the official `@noir-wallet/sdk`, requests `fundingSource: 'shielded'`, and never requests a recovery phrase or spending key.

Run `verify-funding <txid>` after funding is mined. This syncs the operating wallet, decrypts the exact 0.05 TAZ amount and expected memo, rejects a transparent bundle, and saves a receipt. The page reads a public status snapshot; its refresh button does not sync the chain. Wallet requests are coordinated across tabs with the browser Locks API. Interrupted requests remain blocked until the user checks Noir history. A returned transaction ID is labeled as submission until receipt verification succeeds.

## Prepare, recover, submit, verify

```sh
target/debug/private-recurring-wallet --state-dir "$WALLET_STATE_DIR" sync
target/debug/private-recurring-wallet --state-dir "$WALLET_STATE_DIR" prepare
# Start a fresh process and recover the exact persisted transaction.
target/debug/private-recurring-wallet --state-dir "$WALLET_STATE_DIR" recover
target/debug/private-recurring-wallet --state-dir "$WALLET_STATE_DIR" broadcast
target/debug/private-recurring-wallet --state-dir "$WALLET_STATE_DIR" verify
```

`prepare` accepts no external recipient, amount, or PCZT. It builds the fixed test payment, rejects transparent or non-Ironwood bundles, checks one exact supplier output and owned internal change, verifies note/value commitments, proves, signs, and persists. It decrypts the final supplier output using that wallet's viewing key before recording the raw transaction in the outbox.

`broadcast` reads and checks the persisted bytes, transaction ID, expiry, and intended receipt. Retries submit those same bytes. It does not construct replacements. `verify` fetches the mined transaction, matches its full bytes, syncs the separate supplier wallet, and checks the received pool, amount and memo with at least one confirmation. Verification records are saved under `payment-001/` in the private state directory.

These original wallet diagnostic commands retain one payment slot. Recurring execution uses the separate agreement ledger and occurrence directories described in the operator guide. Ambiguous signing without a durable artifact requires operator review; neither path silently constructs a replacement.

## Security boundaries

- Disposable testnet state only. Seed files are unencrypted, mode 0600, in mode 0700 directories. This is not production key custody.
- A filesystem lock serializes local wallet commands. Signed PCZT and outbox writes use exclusive creation and filesystem synchronization before broadcast.
- PCZT inspection checks locally constructed transactions, including decrypted output contents before signing. There is no API accepting arbitrary PCZTs or signing requests.
- The local web server exposes only the built page and a public wallet snapshot. There is no HTTP signing or broadcast endpoint. It binds to loopback and checks Host and Origin.
- The test harness can read both wallets' state. Separate keys establish independent decryption, not organizational isolation.
- The lightwalletd operator sees network requests. Tor/Nym, encrypted business records, hardened custody, and mandate authorization remain separate work.
- A mined receipt can be reorganized. One confirmation is a test threshold, not a production settlement policy.
- The execution service accepts only authenticated invoice submission and status queries over a Unix socket. Its container has wallet state; the agent container has only signed invoices, the socket, and an execution capability. Company/supplier signing keys stay outside both containers.

## Checks

```sh
cargo test --locked
cargo fmt --check
npm --prefix web test
npm --prefix web run build
```

Local checks do not establish that a live payment succeeded. Use the `verify` command and its saved receipt for that evidence.

### Live testnet verification, November 4, 2026

| Check | Transaction | Observed result |
| --- | --- | --- |
| Operating wallet to supplier | [34fc839b...c8e89b3](https://testnet.zcashexplorer.app/transactions/34fc839b89aa0b7a13735266bcdb05caea4ea8be57d148b27e445b2d1c8e89b3) | 0.01 TAZ; four confirmations at height 4,581,337; saved bytes matched; supplier decrypted amount and invoice memo |
| Noir to operating wallet | [3b5c3893...bfeba3a](https://testnet.zcashexplorer.app/transactions/3b5c3893102817ec88e345f3d8c28fcd7c12722e70d8d199078b1b8febfeba3a) | 0.05 TAZ; five confirmations at height 4,581,352; operating wallet decrypted amount and funding memo |

Both receipts are Ironwood and have no transparent inputs or outputs. The supplier test ran first using separate direct faucet funds; Noir funding was verified afterward. These checks establish both wallet operations, not a recurring mandate or a claim that the earlier payment consumed the later funding output.

Backend checks: `bash scripts/check-backend.sh`. MCP dependency setup: `npm ci --ignore-scripts --prefix agent`. The UI is maintained separately; backend integration routes and capability boundaries are documented in [backend-api.md](docs/backend-api.md).
