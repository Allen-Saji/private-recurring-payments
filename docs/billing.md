# Billing and invoice records

Each recurring payment has an immutable supplier-signed payment request. Its separate human-readable billing document adds an invoice number, buyer/supplier identities, service period, itemized charge and total. The supplier signs that document with the invoice key under `private-recurring/billing/v1`. Validation checks the original request digest, agreement-derived dates and exact authorized total. Editing a billing document cannot change payment authority.

## Invoice lifecycle

The supplier saves the payment request and billing document in one SQLite transaction. Repeated collection returns the original request. Invoice numbers are stable per supplier instance (`INV-000001`, etc.); the random invoice ID and agreement binding remain the authoritative identities across instances. All amounts use integer zatoshis, serialized as decimal strings. Browser formatting uses BigInt.

Payment and collection states are separate:

| Payment state | Meaning |
|---|---|
| unpaid | No verified receipt or submitted transaction claim is recorded. |
| verification_pending | A transaction was submitted for supplier verification, or a previous receipt could not be reverified. It does not count as paid. |
| paid | The supplier's last recorded verification matched the payment. The observation includes its time and confirmation height. |

Collection is independently `open`, `window_closed`, or `stopped` by revocation. Cancelling an agreement does not void paid invoices or erase receipts. An already authorized payment may still settle after cancellation. An expired payment window is not a retry instruction or permission to issue a replacement invoice for that period. Service access still requires fresh verification and ends at its original boundary.

The ledger reports total billed, paid, pending and unpaid amounts across the whole supplier instance. Ten-row cursor pages do not truncate these totals. Unpaid totals are historical unsettled charges, not a claim that cancelled or expired invoices remain collectible. Network fees are separate from the supplier's service charge.

## Existing invoices

Older payment requests remain valid and unchanged. Before upgrading a used supplier database, take a consistent SQLite backup. To issue signed billing documents for previously recorded requests:

```sh
prp --state-dir "$SUPPLIER_STATE" supplier document-existing
```

This operation is idempotent. It records the actual document-creation time separately from the original payment-request issue time. It does not rewrite old signatures, payment memos, transaction IDs or revocation state. Until a billing document exists, the API explicitly returns null for that document instead of implying a signature.

## API and agent tools

- `GET /v1/billing`: totals, agreement and newest ten invoice summaries. Optional `?before=<cursor>` retrieves older records. Use only the returned next_cursor.
- `GET /v1/billing/invoices/:invoice_id`: full original payment request, signed billing document, recorded receipt and latest submitted transaction claim.
- Existing settlement verification remains at `POST /v1/invoices/:invoice_id/settlement`.
- MCP tools `list_billing_invoices` and `get_billing_invoice` expose these records to agents alongside the payment tools.

These routes require the existing API capability. They report cached observations, not fresh permission to access the paid service. A billing-document signature authenticates the supplier's record; company approval remains bound to the agreement. JSON exports include both signed envelopes so their relationship can be checked independently.

## Billing workspace

The unified application serves invoices at `/app/invoices` with the same account session and private workspace as agreements and wallet funding. It reads supplier records from that account's state. The read-only review account displays a separately exported testnet evidence pack and cannot submit payments or change agreements.

Follow [workspaces.md](workspaces.md) to build and start the application on `http://localhost:4176`. Use `npm --prefix web run build:product` for the supported frontend build. Account credentials and sessions are managed by the application gateway; no backend API capability is included in the browser bundle.

The older access-code gateway in `web/billing/server.mjs` is retained for compatibility tests. It is not the server for the current account-based billing interface. Use the unified application for new installations.

The interface includes status filters, invoice-number search, older-page navigation, a receipt recheck and exports:

- Signed JSON: selected original request, supplier billing document and receipt observation.
- CSV: all currently loaded invoice rows, with exact zatoshis and formula-safe text cells. This export includes loaded rows even when a display filter is active.
- PDF: native browser print of the selected invoice and receipt. Navigation, ledger and controls are hidden; text stays selectable. The PDF is a snapshot, not a live receipt check or a substitute for verifying the signed JSON.

Exports contain private billing information. The app does not publish or send them to another service.

## Scope

This is fixed-price testnet subscription billing in TAZ, with one service line per newly issued invoice. Tax is explicitly not calculated. Fiat conversion, statutory tax-invoice compliance, usage-based billing, proration, refunds, credit notes, tax IDs and accounting-system integrations are not implemented. No customer or legal-entity information is invented.

Run `bash scripts/check-backend.sh` and `npm --prefix web run build:product` for automated verification. The billing tests cover altered signed totals/periods, idempotent documents, legacy records, pending-payment accounting, cancellation semantics and cursor completeness. The local server tests cover access-code verification, session invalidation, cross-origin rejection, capability isolation and forbidden operations.
