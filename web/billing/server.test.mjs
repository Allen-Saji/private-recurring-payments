import { test } from "node:test";
import assert from "node:assert/strict";
import { createBillingServer } from "./server.mjs";

test("local session keeps backend capability server-side and refuses cross-origin access and arbitrary operations", async () => {
  const port = 18439,
    token = "b".repeat(64),
    calls = [];
  const server = createBillingServer({
    token,
    accessCode: "c".repeat(64),
    port,
    fetchBackend: async (url, options) => {
      calls.push({ url, options });
      return new Response(
        JSON.stringify({ ok: true, result: { invoices: [] } }),
        { status: 200 },
      );
    },
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(base + "/api/billing")).status, 401);
    assert.equal(
      (
        await fetch(base + "/session", {
          method: "POST",
          headers: {
            Origin: "https://hostile.example",
            "X-Billing-Request": "1",
          },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + "/session", {
          method: "POST",
          headers: { Origin: base, "X-Billing-Request": "1" },
          body: JSON.stringify({ access_code: "wrong" }),
        })
      ).status,
      401,
    );
    const session = await fetch(base + "/session", {
      method: "POST",
      headers: { Origin: base, "X-Billing-Request": "1" },
      body: JSON.stringify({ access_code: "c".repeat(64) }),
    });
    assert.equal(session.status, 200);
    const raw = session.headers.get("set-cookie");
    assert(raw.includes("HttpOnly") && raw.includes("SameSite=Strict"));
    assert(!raw.includes(token));
    const cookie = raw.split(";")[0];
    assert.equal(
      (
        await fetch(base + "/session", { headers: { Cookie: cookie } }).then(
          (r) => r.json(),
        )
      ).result.unlocked,
      true,
    );

    const result = await fetch(base + "/api/billing", {
      headers: { Cookie: cookie },
    });
    assert.equal(result.status, 200);
    assert(!(await result.text()).includes(token));
    assert.equal(calls[0].options.headers.Authorization, `Bearer ${token}`);
    assert.equal(
      (
        await fetch(base + "/api/billing", {
          headers: { Cookie: cookie, Origin: "https://hostile.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + "/api/payments", {
          method: "POST",
          headers: { Cookie: cookie, Origin: base, "X-Billing-Request": "1" },
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(base + "/api/admin/export_seed", {
          headers: { Cookie: cookie },
        })
      ).status,
      404,
    );
    assert.equal((await fetch(base + "/api.token")).status, 404);
    assert.equal(
      (
        await fetch(base + "/api/lock", {
          method: "POST",
          headers: { Cookie: cookie, Origin: base, "X-Billing-Request": "1" },
        })
      ).status,
      200,
    );
    assert.equal(
      (await fetch(base + "/api/billing", { headers: { Cookie: cookie } }))
        .status,
      401,
    );
    assert.equal(
      (
        await fetch(base + "/session", { headers: { Cookie: cookie } }).then(
          (r) => r.json(),
        )
      ).result.unlocked,
      false,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
