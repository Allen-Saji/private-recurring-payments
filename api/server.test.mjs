import { test } from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import { createApi } from "./server.mjs";

test("HTTP bridge authenticates requests, rejects browser injection and keeps administration private", async () => {
  const calls = [];
  const handler = async (action) => {
    calls.push(action);
    return { ok: true, result: { state: "test" } };
  };
  const port = 18438,
    token = "a".repeat(64);
  const server = createApi({
    port,
    token,
    origins: ["http://localhost:4173"],
    signer: handler,
    supplier: handler,
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(base + "/v1/overview")).status, 401);
    const auth = { Authorization: `Bearer ${token}` };
    assert.equal(
      (
        await fetch(base + "/v1/overview", {
          headers: { ...auth, Origin: "https://hostile.example" },
        })
      ).status,
      403,
    );
    const badHost = await new Promise((resolve, reject) => {
      const r = http.get(
        base + "/v1/overview",
        { headers: { ...auth, Host: "hostile.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      r.on("error", reject);
    });
    assert.equal(badHost, 403);
    assert.equal(
      (
        await fetch(base + "/v1/admin/install", {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(base + "/v1/invoices/current", {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/json" },
          body: '{"amount":1}',
        })
      ).status,
      404,
    );
    assert.equal(calls.length, 0);
    assert.equal(
      (
        await fetch(base + "/v1/invoices/current", {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      200,
    );
    assert.deepEqual(calls, [{ op: "invoice" }]);
    assert.equal(
      (await fetch(base + "/v1/billing?before=10", { headers: auth })).status,
      200,
    );
    assert.deepEqual(calls.at(-1), { op: "billing", before: 10 });
    assert.equal(
      (await fetch(base + "/v1/billing?before=0", { headers: auth })).status,
      400,
    );
    assert.equal(
      (await fetch(base + "/v1/billing?before=1&before=2", { headers: auth }))
        .status,
      400,
    );
    assert.equal(
      (
        await fetch(base + "/v1/billing?before=9007199254740992", {
          headers: auth,
        })
      ).status,
      400,
    );
    const invoiceId = "1".repeat(64);
    assert.equal(
      (
        await fetch(base + "/v1/billing/invoices/" + invoiceId, {
          headers: auth,
        })
      ).status,
      200,
    );
    assert.deepEqual(calls.at(-1), {
      op: "billing_invoice",
      invoice_id: invoiceId,
    });

    assert.equal(
      (
        await fetch(base + "/v1/payments", {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/json" },
          body: JSON.stringify({ invoice: "x".repeat(33000) }),
        })
      ).status,
      413,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
