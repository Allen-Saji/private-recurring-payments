// Export public testnet evidence only. This never exports seed or viewing keys.
import { execFileSync } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
const [binary, signer, supplier, output] = process.argv.slice(2);
if (!output)
  throw new Error(
    "Usage: node scripts/export-review.mjs BINARY SIGNER_STATE SUPPLIER_STATE OUTPUT",
  );
function call(root, args, action) {
  const stdout = execFileSync(binary, ["--state-dir", root, ...args], {
    input: JSON.stringify(action),
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (args[0] === "workspace") {
    const r = JSON.parse(
      stdout
        .split("\n")
        .find((x) => x.startsWith("WORKSPACE_RESULT:"))
        .slice(17),
    );
    if (!r.ok) throw new Error(r.error);
    return r.result;
  }
  const r = JSON.parse(stdout);
  if (!r.ok) throw new Error(r.error);
  return r.result;
}
const snapshot = call(signer, ["workspace"], { op: "status" });
const billing = call(supplier, ["supplier", "rpc"], {
  op: "billing",
  before: null,
});
const details = {};
for (const i of billing.invoices)
  details[i.invoice_id] = call(supplier, ["supplier", "rpc"], {
    op: "billing_invoice",
    invoice_id: i.invoice_id,
  });
const id = billing.agreement.agreement_id;
snapshot.overview.agreements = snapshot.overview.agreements.filter(
  (a) => a.envelope.payload.agreement_id === id,
);
snapshot.overview.payments = snapshot.overview.payments.filter(
  (p) => p.agreement_id === id,
);
snapshot.fundingReady = false;
const pack = {
  schema: 1,
  exported_at: Math.floor(Date.now() / 1000),
  snapshot,
  billing,
  details,
};
const encoded = JSON.stringify(pack, null, 2);
if (/"(?:seed|password|spending_key|secret_key|ufvk)"\s*:/.test(encoded))
  throw new Error("Unexpected private field in evidence");
await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
await writeFile(output, encoded, { mode: 0o600 });
console.log(
  `Exported ${billing.invoices.length} recorded invoices; no wallet keys exported.`,
);
