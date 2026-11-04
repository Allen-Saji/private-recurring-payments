import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
const env = Object.fromEntries(
  [
    "PATH",
    "SIGNER_SOCKET",
    "SIGNER_TOKEN_FILE",
    "SUPPLIER_SOCKET",
    "SUPPLIER_TOKEN_FILE",
  ]
    .map((k) => [k, process.env[k]])
    .filter(([, v]) => v),
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("./mcp.mjs", import.meta.url))],
  env,
  stderr: "pipe",
});
const client = new Client({ name: "backend-verification", version: "0.1.0" });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 8);
  assert(!tools.tools.some((t) => /export|install|revoke|keygen/.test(t.name)));
  const result = await client.callTool({
    name: "get_payment_overview",
    arguments: {},
  });
  assert(!result.isError);
  const overview = JSON.parse(result.content[0].text);
  assert(overview.ok);
  const billingResult = await client.callTool({
    name: "list_billing_invoices",
    arguments: {},
  });
  assert(!billingResult.isError);
  const billing = JSON.parse(billingResult.content[0].text);
  assert(billing.ok);
  if (billing.result.invoices.length) {
    const invoiceId = billing.result.invoices[0].invoice_id;
    const documentResult = await client.callTool({
      name: "get_billing_invoice",
      arguments: { invoice_id: invoiceId },
    });
    assert(!documentResult.isError);
    assert.equal(
      JSON.parse(documentResult.content[0].text).result.invoice_id,
      invoiceId,
    );
  }

  const forbidden = await client.callTool({
    name: "export_seed",
    arguments: {},
  });
  assert(forbidden.isError);
  const invalid = await client.callTool({
    name: "get_payment_status",
    arguments: { payment_id: "invalid" },
  });
  assert(invalid.isError);
  console.log(
    JSON.stringify({
      mcp_tools: tools.tools.map((t) => t.name),
      real_signer_overview: true,
      forbidden_tool_refused: true,
      invalid_id_refused: true,
    }),
  );
} finally {
  await client.close();
}
