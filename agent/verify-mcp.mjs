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
  assert.equal(tools.tools.length, 6);
  assert(!tools.tools.some((t) => /export|install|revoke|keygen/.test(t.name)));
  const result = await client.callTool({
    name: "get_payment_overview",
    arguments: {},
  });
  assert(!result.isError);
  const overview = JSON.parse(result.content[0].text);
  assert(overview.ok);
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
