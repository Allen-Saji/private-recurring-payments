import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { request } from "./client.mjs";

const {
  SIGNER_SOCKET,
  SIGNER_TOKEN_FILE,
  SUPPLIER_SOCKET,
  SUPPLIER_TOKEN_FILE,
} = process.env;
if (
  !SIGNER_SOCKET ||
  !SIGNER_TOKEN_FILE ||
  !SUPPLIER_SOCKET ||
  !SUPPLIER_TOKEN_FILE
)
  throw new Error("Signer and supplier socket/capability paths are required");
const signer = (action) => request(SIGNER_SOCKET, SIGNER_TOKEN_FILE, action);
const supplier = (action) =>
  request(SUPPLIER_SOCKET, SUPPLIER_TOKEN_FILE, action);
const server = new McpServer({
  name: "private-recurring-payments",
  version: "0.1.0",
});
const id = z.string().regex(/^[a-f0-9]{64}$/);
const wrap = (fn) => async (args) => {
  try {
    const result = await fn(args);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      isError: !result.ok,
    };
  } catch {
    return {
      content: [
        {
          type: "text",
          text: "Backend unavailable. Payment outcome may be unknown; retain and retry the exact signed invoice.",
        },
      ],
      isError: true,
    };
  }
};
const add = (name, description, inputSchema, fn, spends = false) =>
  server.registerTool(
    name,
    {
      description,
      inputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: spends,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    wrap(fn),
  );
add(
  "get_payment_overview",
  "Read approved agreements, reserved allowance and recorded payment states. Observations may be cached.",
  {},
  () => signer({ op: "overview" }),
);
add(
  "get_current_invoice",
  "Collect the supplier-signed invoice for the current period. Retries return the same stored invoice.",
  {},
  () => supplier({ op: "invoice" }),
);
add(
  "submit_signed_invoice",
  "Pay only the exact supplier envelope under an installed company agreement. Pass JSON for the envelope returned by get_current_invoice. Never replace an invoice after a timeout.",
  { invoice_json: z.string().max(32768) },
  ({ invoice_json }) =>
    signer({ op: "submit", invoice: JSON.parse(invoice_json) }),
  true,
);
add(
  "get_payment_status",
  "Reconcile a signer payment. A confirmed signer observation does not grant supplier service access.",
  { payment_id: id },
  ({ payment_id }) => signer({ op: "status", payment_id }),
);
add(
  "verify_supplier_payment",
  "Ask the supplier to independently scan and decrypt payment for its invoice. Caller-provided receipt claims are not accepted.",
  { invoice_id: id, txid: id },
  (args) => supplier({ op: "settle", ...args }),
);
add(
  "get_paid_resource",
  "Obtain live testnet telemetry only after fresh supplier verification and while the paid service period remains active.",
  { invoice_id: id },
  (args) => supplier({ op: "access", ...args }),
);
add(
  "list_billing_invoices",
  "Read numbered invoices, billing totals and separate payment/collection states. Results are recorded observations, not fresh network verification.",
  {
    before: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  },
  ({ before }) => supplier({ op: "billing", before: before ?? null }),
);
add(
  "get_billing_invoice",
  "Read a supplier-signed billing document bound to the original payment request, with the recorded receipt and service period.",
  { invoice_id: id },
  ({ invoice_id }) => supplier({ op: "billing_invoice", invoice_id }),
);
await server.connect(new StdioServerTransport());
