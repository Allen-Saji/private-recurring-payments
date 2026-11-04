# Backend API and supplier integration

The HTTP bridge listens on `127.0.0.1:4318`. This is a local testnet deployment. It exposes signer execution and supplier operations; approval signing, key management, installation and revocation remain trusted operator CLI operations. The frontend is maintained separately.

Every `/v1/` request requires `Authorization: Bearer <API capability>`. Keep that capability on the UI server and proxy requests from the authenticated UI; never embed it in a shipped bundle or log it. The API token is separate from the signer and supplier execution tokens. The bridge has neither wallet state nor approval keys. `GET /health` returns only process availability and the testnet designation; it does not attest to chain connectivity.

Configure `API_ALLOWED_ORIGINS` for direct local browser requests. Default origins are localhost ports 4173 and 5173. All responses use no-store. Host checks accept only localhost or 127.0.0.1 with the configured API port. This service is not an internet authentication system; use an authenticated application server for remote deployment.

## Routes

| Method and path | Request | Result |
|---|---|---|
| GET /v1/overview | None | `result.signer` contains approved envelopes, revocation and latest 20 payments; `result.supplier` contains agreement, latest 20 invoices and recorded receipts. These are cached observations, not fresh access grants. |
| POST /v1/invoices/current | `{}` | Persistent supplier invoice: `envelope`, `period_start`, `service_until`, `payment_memo`. One invoice per period, including retries/restarts. |
| POST /v1/payments | `{"invoice": <signed envelope>}` | `payment_id`, `state`, `txid`. Supply the supplier's exact envelope. A transport timeout leaves an unknown outcome; retry the same invoice. |
| GET /v1/payments/:payment_id | None | Signer reconciliation. `confirmed` means the signer's chain observation; it does not grant supplier access. |
| POST /v1/invoices/:invoice_id/settlement | `{"txid":"64 lowercase hex characters"}` | Supplier independently scans and decrypts receipt. Returns `receipt` and `entitlement_active`. |
| GET /v1/invoices/:invoice_id/resource | None | Fresh receipt verification followed by live Zcash testnet telemetry, `access_until`, and receipt. Refused when unpaid, expired, unconfirmed, wrong invoice, stale chain, or unavailable verification. |

Successful business responses use `{"ok":true,"result":...}`. A policy or entitlement refusal is HTTP 409 with `{"ok":false,"error":"..."}`. Authentication failure is 401; forbidden Host/Origin is 403; invalid fields/routes are 404; oversized requests are 413; unsupported content type is 415; backend or transport failure is 503. Do not translate every 503 into payment failure or create a replacement payment. Error text is diagnostic, not a stable machine-code enum.

Invoice and payment IDs are opaque 64-character lowercase hex. Requests are limited to 32 KiB. POST bodies accept only the documented fields. Administrative and generic signing routes are absent. The overview is bounded to 20 records per category; pagination and multi-tenant accounts are outside this first backend.

## Confirmation and privacy semantics

The supplier owns its invoice-signing key, receiving wallet, invoice database and execution socket. It has no payer spending keys or signer database. The signer reconciles from its operating wallet and saved bytes, without reading the new supplier wallet.

New payment memos use `prp:v2:` followed by a domain-separated hash of the signed invoice payload. The supplier generates a random 256-bit invoice ID, so the hash cannot be guessed from public business terms. This binds the payment to the exact signed invoice without placing company names or invoice contents in memo plaintext. Existing v1 salted outboxes remain unchanged and recoverable; the supplier service accepts only invoices it issued itself.

The supplier requires two confirmations by default and a chain tip block no older than 30 minutes. It checks its scanned transaction height/block hash against the configured lightwallet server, exact Ironwood amount, and invoice memo. Both services still trust the configured lightwallet server and local host; this is not independent full-node consensus validation. Every resource call rechecks receipt availability before returning data. Failed verification invalidates the cached entitlement observation. No cached receipt alone grants access.

Access ends at the originally billed service-period boundary, even if settlement is late. A late payment may be recorded without unlocking an already expired period. Revocation stops future invoice issuance after the supplier receives the signed revocation; the signer blocks new authorization as soon as its own acknowledgement commits. Already paid service lasts through its original period. Operator delivery to both services is explicit.

## Recurring worker

`agent/renew.mjs` collects the supplier's current invoice, synchronizes that exact envelope to its private journal before submission, retries it across interruptions, asks the supplier to verify the resulting txid and calls the paid endpoint. It never creates replacement invoices or bypasses refusal. The Compose launcher holds an OS file lock on the journal. A second process cannot concurrently update it.

The worker has no network and only the two execution sockets and its own journal mounted. The supplier and signer make network calls independently. `--once` performs one pass; `--max-payments N` stops at N successful service deliveries recorded in that journal, including across restarts; `--poll-seconds N` controls checks. Successful delivery and refused invoices are retained. Missed periods are not backfilled. Transactions that settle after their period ends are retained as expired service, not converted into free future access.

This is deterministic invoice orchestration, not an LLM decision-maker. Agent frameworks can call the same constrained operations without receiving keys.

## Local deployment

Build with `cargo build --locked --bins`. The existing signer uses `deploy/compose.yaml`. The supplier, HTTP bridge and recurring worker use `deploy/backend.compose.yaml`.

Set these environment variables to absolute paths outside the checkout:

- `PRP_BINARY`, `PRP_RPC`: existing binary and signer socket directory.
- `SUPPLIER_STATE`, `SUPPLIER_RPC`: new supplier state and socket directory.
- `API_TOKEN_FILE`: separate random 32-byte hex API capability, mode 0600.
- `AGENT_STATE`: private worker journal directory, mode 0700.

Initialize a supplier with `prp --state-dir "$SUPPLIER_STATE" supplier init-wallet`. This prints only its receiving address and public invoice verification key. Use those in a new agreement approved by the two pinned company keys. Install that envelope in the signer using `policy install`, then configure the supplier:

```sh
prp --state-dir "$SUPPLIER_STATE" supplier configure \
  --agreement /private/agreement.approved.json --trust /private/trust.json --confirmations 2

docker compose -p prp-services -f deploy/backend.compose.yaml up -d --build supplier api
docker compose -p prp-services -f deploy/backend.compose.yaml run --rm renewals --max-payments 2
```

Create `SUPPLIER_RPC/execution.token` separately with random 32-byte hex, mode 0600; use the nonprinting generation pattern in agreements.md. A signed revocation is delivered through both `policy revoke --revocation FILE` on signer state and `supplier revoke --revocation FILE` on supplier state. There is no HTTP authority to install or revoke agreements.

The supplier image copies the pinned official Node binary into the tested Ubuntu runtime used for the Rust binary. Runtime roots are read-only, capabilities dropped, and UID/GID unprivileged. Rebuild the image if its pinned bases change. Restart bind-mounted binary services after a new Rust build. The HTTP bridge binds loopback even though its container uses host networking.

## MCP tools for AI agents

The stdio adapter uses the official TypeScript MCP SDK, pinned in `agent/package-lock.json`. It follows the [official MCP server interface](https://modelcontextprotocol.io/docs/develop/build-server) and keeps stdout reserved for protocol messages. Install its dependencies with `npm ci --ignore-scripts --prefix agent`.

Eight tools expose the same enforcement boundary: `get_payment_overview`, `get_current_invoice`, `submit_signed_invoice`, `get_payment_status`, `verify_supplier_payment`, `get_paid_resource`, `list_billing_invoices`, and `get_billing_invoice`. Submit accepts the exact supplier envelope as `invoice_json`. Unknown tools and invalid input schemas are rejected. Generic signing, key export, agreement installation and revocation are absent.

Launch through `docker compose -p prp-services -f deploy/backend.compose.yaml run --rm -T mcp` with the deployment variables already set. Configure that command as a stdio MCP server in the agent host. The MCP container has no network, wallet-state mounts or approval keys. Direct `node agent/mcp.mjs` is available for development, but running on the host does not provide the container filesystem boundary.

`agent/verify-mcp.mjs` checks a real MCP handshake, tool discovery, signer overview, unknown-tool refusal and invalid identifier refusal. It does not submit a payment. A downstream model may decide when to call these tools; model output never overrides signed agreement terms.

## Billing records and owner workspace

The billing API adds GET /v1/billing (optional before cursor) and GET /v1/billing/invoices/:invoice_id. The current account-based application serves billing at `/app/invoices` on port 4176. See [workspaces.md](workspaces.md) for the application gateway and account isolation. See [billing.md](billing.md) for invoice signatures, state semantics, pagination, migration and exports.
