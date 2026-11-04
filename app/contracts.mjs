// Response contracts for the hosted account API. Unknown additive fields are allowed.
const text = { type: "string" },
  integer = { type: "integer" },
  boolean = { type: "boolean" },
  zatoshis = { type: "string", pattern: "^[0-9]+$" };
const record = (properties, required = []) => ({
  type: "object",
  properties,
  required,
});
const array = (items) => ({ type: "array", items });
const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });
const ref = (name) => ({ $ref: "#/components/schemas/" + name });
const wrapped = (schema) =>
  record({ ok: { const: true }, result: schema }, ["ok", "result"]);
export const schemas = {
  Service: record(
    {
      id: text,
      name: text,
      provider: text,
      category: text,
      summary: text,
      description: text,
      status: { const: "available" },
      operator_notice: text,
      amount_zatoshis: zatoshis,
      max_fee_zatoshis: zatoshis,
      intervals: array(
        record({ seconds: integer, label: text }, ["seconds", "label"]),
      ),
      payment_counts: array(integer),
      delivers: array(text),
      requirements: array(text),
      links: record({ details: text, subscribe: text, api: text }),
    },
    [
      "id",
      "name",
      "provider",
      "amount_zatoshis",
      "max_fee_zatoshis",
      "intervals",
      "payment_counts",
      "links",
    ],
  ),
  Catalog: record(
    {
      version: integer,
      network: { const: "zcash-testnet" },
      consensus: { const: "NU7" },
      currency: { const: "TAZ" },
      services: array(ref("Service")),
    },
    ["services", "network", "consensus", "currency"],
  ),
  Session: record(
    {
      unlocked: boolean,
      user: nullable(
        record({ username: text, role: { enum: ["owner", "reviewer"] } }, [
          "username",
          "role",
        ]),
      ),
    },
    ["unlocked", "user"],
  ),
  Snapshot: record(
    {
      network: { const: "testnet" },
      consensus: { const: "NU7" },
      ready: boolean,
      fundingReady: boolean,
      updatedAtUnix: integer,
      operating: record(
        {
          address: text,
          chainTip: integer,
          scannedHeight: integer,
          totalZatoshis: zatoshis,
          ironwoodSpendableZatoshis: zatoshis,
        },
        ["address"],
      ),
      overview: record({
        agreements: array(
          record({
            envelope: ref("SignedEnvelope"),
            revoked: boolean,
            reserved_zatoshis: zatoshis,
            remaining_allowance_zatoshis: zatoshis,
          }),
        ),
        payments: array(
          record({
            payment_id: text,
            agreement_id: text,
            period_id: text,
            state: text,
            txid: nullable(text),
          }),
        ),
      }),
      receipts: record({
        funding: nullable(
          record({
            txid: text,
            amount_zatoshis: integer,
            mined_height: integer,
            confirmations: integer,
            pool: text,
          }),
        ),
      }),
    },
    ["network", "ready", "operating", "overview"],
  ),
  Proposal: record(
    {
      proposal_id: text,
      digest: text,
      terms: record({
        agreement_id: text,
        recipient: text,
        supplier_key: text,
        amount_zatoshis: zatoshis,
        max_fee_zatoshis: zatoshis,
        lifetime_limit_zatoshis: zatoshis,
        valid_from: integer,
        expires_at: integer,
        schedule: record({
          kind: text,
          anchor: integer,
          interval_secs: integer,
          payment_window_secs: integer,
        }),
      }),
      review_expires_at: integer,
    },
    ["proposal_id", "digest", "terms", "review_expires_at"],
  ),
  Workspace: record(
    {
      id: text,
      name: text,
      state: { enum: ["new", "queued", "running", "ready", "error"] },
      readOnly: { type: "boolean", default: false },
      automation: boolean,
      error: nullable(text),
      updatedAt: integer,
      snapshot: nullable(ref("Snapshot")),
      job_result: nullable({
        anyOf: [
          ref("Proposal"),
          ref("Snapshot"),
          record({ pending_funding: text }),
        ],
      }),
      evidence: record({ exportedAt: integer, notice: text }),
    },
    [
      "id",
      "name",
      "state",
      "automation",
      "error",
      "updatedAt",
      "snapshot",
      "job_result",
    ],
  ),
  SignedEnvelope: record(
    {
      payload: { type: "object" },
      signatures: array(
        record({ key: text, signature: text }, ["key", "signature"]),
      ),
    },
    ["payload", "signatures"],
  ),
  Receipt: record(
    {
      txid: text,
      amount_zatoshis: zatoshis,
      memo: text,
      mined_height: integer,
      verified_tip: integer,
      confirmations: integer,
      observed_at: integer,
      consensus_branch: text,
      latest_block_time: integer,
    },
    [
      "txid",
      "amount_zatoshis",
      "mined_height",
      "verified_tip",
      "confirmations",
      "observed_at",
    ],
  ),
  InvoiceRow: record(
    {
      invoice_id: text,
      invoice_number: text,
      payment_state: { enum: ["paid", "verification_pending", "unpaid"] },
      collection_state: { enum: ["open", "stopped", "window_closed"] },
      issued_at: integer,
      payable_until: integer,
      period_id: text,
      amount_zatoshis: zatoshis,
      service_from: integer,
      service_until: integer,
      txid: nullable(text),
      last_verified_at: nullable(integer),
      has_billing_document: boolean,
    },
    [
      "invoice_id",
      "invoice_number",
      "payment_state",
      "collection_state",
      "amount_zatoshis",
    ],
  ),
  Billing: record(
    {
      invoices: array(ref("InvoiceRow")),
      next_cursor: nullable(integer),
      currency: { const: "TAZ" },
      as_of: integer,
      agreement: nullable(
        record({
          agreement_id: text,
          buyer_company_id: text,
          supplier_key: text,
          amount_zatoshis: zatoshis,
          expires_at: integer,
          revoked: boolean,
        }),
      ),
      totals: record({
        billed_zatoshis: zatoshis,
        paid_zatoshis: zatoshis,
        pending_zatoshis: zatoshis,
        unpaid_zatoshis: zatoshis,
        invoice_count: integer,
        paid_count: integer,
        pending_count: integer,
        unpaid_count: integer,
      }),
    },
    ["invoices", "totals", "currency", "as_of", "agreement"],
  ),
  Invoice: record(
    {
      invoice_id: text,
      invoice_number: text,
      payment_state: { enum: ["paid", "verification_pending", "unpaid"] },
      collection_state: text,
      issued: record({
        envelope: ref("SignedEnvelope"),
        period_start: integer,
        service_until: integer,
        payment_memo: text,
      }),
      billing_document: nullable(ref("SignedEnvelope")),
      document_signature_verified: boolean,
      txid: nullable(text),
      receipt: nullable(ref("Receipt")),
      payment_candidate: nullable(
        record({
          txid: text,
          attempted_at: integer,
          last_error: nullable(text),
        }),
      ),
      as_of: integer,
    },
    ["invoice_id", "invoice_number", "issued", "payment_state", "receipt"],
  ),
  Resource: record(
    {
      service: { const: "zcash-testnet-telemetry" },
      invoice_id: text,
      access_until: integer,
      data: record({
        network: { const: "testnet" },
        height: integer,
        consensus_branch: text,
        latest_block_time: integer,
        observed_at: integer,
        source: text,
      }),
      receipt: ref("Receipt"),
    },
    ["service", "invoice_id", "access_until", "data", "receipt"],
  ),
};
export function attachResponseContracts(paths) {
  const responses = {
    "/api/catalog": "Catalog",
    "/api/catalog/{service_id}": "Service",
    "/session": "Session",
    "/api/workspace": "Workspace",
    "/api/status": "Snapshot",
    "/api/billing": "Billing",
    "/api/billing/invoices/{invoice_id}": "Invoice",
    "/api/invoices/{invoice_id}/resource": "Resource",
  };
  for (const [route, name] of Object.entries(responses))
    paths[route].get.responses["200"].content = {
      "application/json": {
        schema: route === "/api/status" ? ref(name) : wrapped(ref(name)),
      },
    };
  for (const item of Object.values(paths))
    if (item.post?.responses["202"])
      item.post.responses["202"].content = {
        "application/json": {
          schema: wrapped(record({ state: { const: "queued" } }, ["state"])),
        },
      };
  for (const route of ["/api/auth/register", "/api/auth/login"]) {
    paths[route].post.responses["200"].content = {
      "application/json": {
        schema: wrapped(
          record({ username: text, role: { enum: ["owner", "reviewer"] } }, [
            "username",
            "role",
          ]),
        ),
      },
    };
    paths[route].post.responses["200"].headers = {
      "Set-Cookie": {
        description:
          "HttpOnly session cookie; preserve it for subsequent requests.",
        schema: text,
      },
    };
  }
}
