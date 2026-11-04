# Private testnet workspaces

The application serves the landing page, account sign-in, agreements, Noir funding and invoices from one origin. Each account gets independent operating and supplier wallets, approval keys, agreement and invoice databases. The HTTP client never chooses a state directory or another account's identity.

## Run locally

Use Node 22.13 or later in the Node 22 release line, Rust and the native build dependencies described in the README. Node's SQLite API is experimental in this runtime.

```sh
npm ci --prefix web
npm run build:product --prefix web
cargo build --locked --bins
export APP_STATE_DIR="$HOME/.local/share/tandem-private-workspaces"
export PRP_BINARY="$(pwd)/target/debug/private-recurring-wallet"
export APP_ORIGIN=http://localhost:4176
mkdir -p "$APP_STATE_DIR"
chmod 700 "$APP_STATE_DIR"
docker compose -p tandem-product -f deploy/product.compose.yaml up -d --build
```

Open `http://localhost:4176`. Use localhost for Noir's local extension integration. The container binds only to loopback. For development without Docker, use `flock -n "$APP_STATE_DIR/application.lock" node app/server.mjs` with the same environment. Run exactly one application process per state directory.

Create an account, connect a NU7-compatible Noir testnet extension, and approve the displayed 0.05 TAZ funding transfer in Noir. The server verifies the exact amount and memo in its own wallet. The balance can also be synced independently. Faucet deposits increase the balance but are not presented as Noir funding receipts.

The initial service is network telemetry at 0.01 TAZ per period. Choose one to three payments, every ten minutes, hour or day. Review the exact amount, fee allowance and expiry before authorizing. A proposal expires after five minutes. Authorization requires at least 0.011 TAZ spendable. Automatic execution starts after authorization and continues without an open browser. Missed periods do not extend the agreement or service period.

Invoices contain signed line items and payment requests. A submitted transaction stays pending until the supplier independently verifies it. Paid periods unlock the network feed through the invoice page. JSON, CSV and native PDF exports preserve the billing record. Cancellation stops new authorizations while retaining invoices and receipts. Each workspace currently supports one agreement, including after cancellation or expiry.

## NU7 enforcement

Every network connection requires testnet and the SDK's `BranchId::Nu7` at the reported height. The server's consensus branch must match. Pre-NU7, mainnet and mismatched branches are refused before network payment operations. There is no mainnet switch. The network regression test exercises each refusal.

Payment outboxes record the consensus branch and persisted transaction bytes. Supplier receipts record their independently observed branch, mined height and confirmations. Transaction IDs alone do not disclose a shielded payment's amount or invoice binding. Keep the authorized recipient's receipt when verifying settlement.

## Public testnet operation

Set `APP_ORIGIN` to the exact HTTPS origin without a trailing slash. Set `APP_DOMAIN` for `deploy/Caddyfile.product` on a host already configured for Caddy and TLS. The proxy must preserve the original Host header and reach loopback port 4176. HTTPS origins receive Secure, HttpOnly, SameSite=Strict session cookies. Sessions expire after eight hours; logout invalidates the stored session digest. Passwords use salted scrypt. Host, Origin, Fetch Metadata, JSON content type and a same-origin request header are checked for writes.

`MAX_ACCOUNTS` defaults to 50. Registration and login have global limits; actions have account limits. The worker serializes queued jobs and retries the exact retained job after a process interruption. Wallet operations use an additional filesystem lock, and transaction execution retains the original occurrence and outbox. Failed or ambiguous payments must be reconciled, never replaced by deleting state.

Keep the entire state directory on persistent private storage. Stop the application for a consistent full backup, including all SQLite files, wallets, keys, authorizations and outboxes. Restoring a stale backup can lose newer spending reservations; backup rollback protection is not implemented. Recreate the container after rebuilding the Rust binary so its bind mount points at the new binary. The health check proves HTTP availability, not chain synchronization or settlement.

## Trust and release limits

This is a server-managed testnet release. The service stores operating-wallet seeds and both approval keys. Two signatures validate the policy format; they do not represent two independent human approvals in this release. Account isolation prevents normal users from accessing each other's state; the server operator can access all hosted records and keys. Noir retains the funding wallet's keys and requires its own approval for each deposit.

Keys and databases are not encrypted at rest. Password reset, MFA, organization invitations, arbitrary suppliers, agreement amendments and production custody are not implemented. Network requests expose metadata to infrastructure providers; Nym is not integrated. Do not accept mainnet funds or describe this as a production custody service.

The account gateway is separate from the lower-level Unix signer/API deployment. It does not inherit that deployment's separate-container key boundary. The older shared access-code billing server and diagnostic funding server are not the public application entry points.

## Verification

```sh
bash scripts/check-backend.sh
npm test --prefix web
npm run build:product --prefix web
```

HTTP tests cover account ownership, foreign invoice refusal, client path overrides, cookies, logout, session expiry, hostile origins and exact job recovery. Live wallet provisioning and payment receipts must be checked separately. A successful build or an empty workspace is not evidence that the new account flow has completed a payment.

## Recorded review access

Judge access is a separate read-only role. The public username/password are `judge` / `tandem-review`. The server blocks every review-account mutation except logout before calling the wallet backend. Account registration remains available to create a separate owner workspace. Review evidence is a snapshot, not a live balance or fresh transaction claim.

Export a deliberately selected testnet signer/supplier record, keeping the output outside source control:

```sh
node scripts/export-review.mjs "$PRP_BINARY" "$SIGNER_STATE" "$SUPPLIER_STATE" "$APP_STATE_DIR/review-evidence.json"
export JUDGE_EVIDENCE_FILE=/state/review-evidence.json
docker compose -p tandem-product -f deploy/product.compose.yaml up -d --force-recreate
```

`SIGNER_STATE` and `SUPPLIER_STATE` identify the existing lower-level testnet run that you intend reviewers to inspect. The exporter includes public addresses, signed agreement/invoice records, receipts and recorded balances. It exports no seeds, spending keys or viewing keys. Review the selected records before enabling access; the credentials are intentionally public. With a host Node process, use the host file path instead of `/state/review-evidence.json`.

If no evidence file is configured, the public review account is not provisioned automatically and the login page reports that review access is unavailable. Do not replace missing evidence with fabricated invoices. Existing owners and wallet state remain unchanged when the role migration runs.

The curated catalog is in `shared/catalog.json`; the signer only accepts its supported service identifier. `/services` explains the operator and terms before subscription setup. `/agents`, `/llms.txt`, `/.well-known/tandem.json` and `/openapi.json` describe the actual hosted workflow. Page canonical and social URLs derive from `APP_ORIGIN`; private application pages are marked noindex. `robots.txt` is a discovery preference, not an access control.
