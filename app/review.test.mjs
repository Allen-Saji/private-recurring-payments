import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Accounts } from "./store.mjs";
import { createApplication } from "./server.mjs";
import { reviewAccess, catalog, openapi, pageMetadata } from "./discovery.mjs";

test("review credentials open only recorded evidence and never reach a wallet mutation", async (t) => {
  const accounts = new Accounts(
    mkdtempSync(path.join(tmpdir(), "tandem-review-")),
  );
  await accounts.ensureReviewer(reviewAccess);
  let calls = 0;
  const id = "a".repeat(64);
  const pack = {
    schema: 1,
    exported_at: 123,
    snapshot: {
      ready: true,
      operating: { address: "review-address" },
      overview: { agreements: [], payments: [] },
    },
    billing: { invoices: [{ invoice_id: id }], totals: { paid_count: 1 } },
    details: { [id]: { invoice_id: id, payment_state: "paid" } },
  };
  const app = createApplication({
    accounts,
    backend: {
      async execute() {
        calls++;
        throw new Error("Unexpected wallet call");
      },
    },
    review: pack,
    background: false,
    origin: "http://localhost:4176",
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(() => app.close());
  const request = (url, body, cookie) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: app.server.address().port,
          path: url,
          method: body ? "POST" : "GET",
          headers: {
            Host: "localhost:4176",
            Origin: "http://localhost:4176",
            "Content-Type": "application/json",
            "X-Tandem-Request": "1",
            ...(cookie ? { Cookie: cookie } : {}),
          },
        },
        (res) => {
          let text = "";
          res.on("data", (x) => (text += x));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              body: JSON.parse(text),
              cookie: res.headers["set-cookie"]?.[0].split(";")[0],
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  const login = await request("/api/auth/login", {
    username: reviewAccess.username,
    password: reviewAccess.password,
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.result.role, "reviewer");
  const cookie = login.cookie;
  assert.equal(
    (await request("/api/workspace", null, cookie)).body.result.readOnly,
    true,
  );
  assert.equal(
    (await request("/api/billing/invoices/" + id, null, cookie)).body.result
      .payment_state,
    "paid",
  );
  assert.equal(
    (await request("/api/billing/invoices/" + "b".repeat(64), null, cookie))
      .status,
    404,
  );
  assert.equal(
    (await request("/api/workspace?state_dir=other", null, cookie)).status,
    400,
  );
  for (const [route, body] of [
    ["/api/wallet/sync", {}],
    ["/api/workspace/initialize", {}],
    [
      "/api/agreements/propose",
      { service_id: "network-telemetry", payments: 1, interval_secs: 600 },
    ],
    ["/api/agreements/approve", { proposal_id: "b".repeat(32), digest: id }],
    ["/api/agreements/cancel", {}],
    ["/api/payments/run", {}],
    ["/api/invoices/" + id + "/recheck", {}],
  ])
    assert.equal((await request(route, body, cookie)).status, 403, route);
  assert.equal(calls, 0);
  assert.equal(accounts.next(), undefined);
  const catalogResponse = await request("/api/catalog");
  assert.equal(catalogResponse.status, 200);
  assert.deepEqual(catalogResponse.body.result, catalog);
  assert.equal(
    (await request("/.well-known/tandem.json")).body.review.role,
    "reviewer",
  );
  assert.equal(
    (
      await request("/api/auth/register", {
        username: "judge",
        password: "not-a-public-password",
      })
    ).status,
    400,
  );
  assert.equal((await request("/api/logout", {}, cookie)).status, 200);
  assert.equal((await request("/api/workspace", null, cookie)).status, 401);
});

test("agent contract binds service selection, queued writes and session authority", () => {
  const spec = openapi("https://tandem.example");
  const propose = spec.paths["/api/agreements/propose"].post;
  assert.equal(
    propose.requestBody.content["application/json"].schema.properties.service_id
      .const,
    catalog.services[0].id,
  );
  assert.deepEqual(
    propose.requestBody.content["application/json"].schema.properties
      .interval_secs.enum,
    catalog.services[0].intervals.map((x) => x.seconds),
  );
  assert.ok(propose.responses["202"]);
  assert.deepEqual(propose.security, [{ session: [] }]);
  assert.deepEqual(spec.paths["/api/catalog"].get.security, []);
  for (const [route, item] of Object.entries(spec.paths)) {
    for (const match of route.matchAll(/\{(.*?)\}/g))
      assert.ok(item.parameters.some((x) => x.name === match[1] && x.required));
  }
});

test("metadata uses configured origin and excludes private pages from indexing", () => {
  const page = pageMetadata(
    "<html><head><title>x</title></head><body></body></html>",
    "/services",
    "https://tandem.example",
  );
  assert.match(page.html, /https:\/\/tandem.example\/og-tandem.png/);
  assert.match(page.html, /application\/ld\+json/);
  assert.match(page.html, /<noscript>/);
  assert.match(page.html, /rel="alternate" type="text\/markdown"/);
  assert.match(
    pageMetadata("<head></head>", "/app/invoices", "https://tandem.example")
      .html,
    /noindex,nofollow/,
  );
});
