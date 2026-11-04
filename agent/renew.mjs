import { mkdir, readFile, open, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { request } from "./client.mjs";

const {
  SIGNER_SOCKET,
  SIGNER_TOKEN_FILE,
  SUPPLIER_SOCKET,
  SUPPLIER_TOKEN_FILE,
  AGENT_STATE,
} = process.env;
if (
  !SIGNER_SOCKET ||
  !SIGNER_TOKEN_FILE ||
  !SUPPLIER_SOCKET ||
  !SUPPLIER_TOKEN_FILE ||
  !AGENT_STATE
)
  throw new Error("Signer, supplier and agent state configuration required");
const once = process.argv.includes("--once");
const value = (flag) =>
  process.argv.indexOf(flag) >= 0
    ? process.argv[process.argv.indexOf(flag) + 1]
    : undefined;
const max = Number(value("--max-payments") || 0),
  poll = Number(value("--poll-seconds") || 15);
if (
  !Number.isInteger(max) ||
  max < 0 ||
  !Number.isInteger(poll) ||
  poll < 2 ||
  poll > 300
)
  throw new Error("Invalid scheduler bounds");
await mkdir(AGENT_STATE, { recursive: true, mode: 0o700 });
// Durable files retain the exact signed invoice before any signer request.
async function save(file, data) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.next`;
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(data, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
  const dir = await open(AGENT_STATE, "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
let state;
const file = path.join(AGENT_STATE, "renewals.json");
try {
  state = JSON.parse(await readFile(file, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  state = { invoices: {}, completed: 0 };
}
async function processInvoice(issued) {
  const id = issued.envelope.payload.invoice_id;
  let item = state.invoices[id];
  if (!item) {
    item = state.invoices[id] = { issued, state: "collected" };
    await save(file, state);
  }
  if (item.state === "delivered" || item.state === "refused") return;
  const result = await request(SIGNER_SOCKET, SIGNER_TOKEN_FILE, {
    op: "submit",
    invoice: item.issued.envelope,
  });
  if (!result.ok) {
    item.error = result.error;
    // A busy worker or unavailable network does not authorize a replacement.
    if (
      /revoked|budget exhausted|outside|not for the current|issuance or expiry|changes approved|another invoice/i.test(
        result.error,
      )
    )
      item.state = "refused";
    await save(file, state);
    console.log(
      JSON.stringify({
        invoice_id: id,
        state: item.state,
        error: result.error,
      }),
    );
    return;
  }
  item.payment = result.result;
  item.state = "submitted";
  await save(file, state);
  if (!item.payment.txid) return;
  // Supplier verification is authoritative for delivery; signer confirmation is
  // useful telemetry, but never a substitute for recipient-side decryption.
  const settled = await request(SUPPLIER_SOCKET, SUPPLIER_TOKEN_FILE, {
    op: "settle",
    invoice_id: id,
    txid: item.payment.txid,
  });
  if (!settled.ok) {
    console.log(
      JSON.stringify({
        invoice_id: id,
        state: "awaiting_supplier",
        error: settled.error,
      }),
    );
    return;
  }
  item.receipt = settled.result.receipt;
  item.state = "received";
  await save(file, state);
  try {
    const observed = await request(SIGNER_SOCKET, SIGNER_TOKEN_FILE, {
      op: "status",
      payment_id: item.payment.payment_id,
    });
    if (observed.ok) item.payment = observed.result;
  } catch {
    /* Supplier receipt remains independently authoritative. */
  }
  if (!settled.result.entitlement_active) {
    item.state = "period_expired";
    await save(file, state);
    return;
  }
  const access = await request(SUPPLIER_SOCKET, SUPPLIER_TOKEN_FILE, {
    op: "access",
    invoice_id: id,
  });
  if (!access.ok) {
    console.log(
      JSON.stringify({
        invoice_id: id,
        state: "awaiting_access",
        error: access.error,
      }),
    );
    return;
  }
  item.state = "delivered";
  item.service = access.result;
  state.completed++;
  await save(file, state);
  console.log(
    JSON.stringify({
      invoice_id: id,
      state: "delivered",
      txid: item.payment.txid,
      service: access.result,
    }),
  );
}
// Multiple schedulers still cannot double-pay, but serialize this local journal
// with a kernel lock supplied by the launcher (flock). No stale PID lock files.
do {
  if (max && state.completed >= max) break;
  try {
    for (const item of Object.values(state.invoices))
      if (!["delivered", "refused", "period_expired"].includes(item.state))
        await processInvoice(item.issued);
    if (max && state.completed >= max) break;
    const due = await request(SUPPLIER_SOCKET, SUPPLIER_TOKEN_FILE, {
      op: "invoice",
    });
    if (due.ok) await processInvoice(due.result);
    else console.log(JSON.stringify({ state: "waiting", error: due.error }));
  } catch (error) {
    console.log(
      JSON.stringify({ state: "retry_same_invoice", error: error.message }),
    );
    if (once) process.exitCode = 1;
  }
  if (once || (max && state.completed >= max)) break;
  await delay(poll * 1000);
} while (true);
