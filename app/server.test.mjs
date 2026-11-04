import test from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Accounts } from "./store.mjs";
import { createApplication } from "./server.mjs";
import { createBackend } from "./backend.mjs";

const origin = "https://tandem.example";
test("account sessions isolate wallets, jobs and invoice reads across HTTP", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "tandem-auth-"));
  const accounts = new Accounts(root),
    calls = [];
  const backend = {
    async execute(id, action) {
      calls.push({ id, action });
      if (action.op === "initialize")
        return {
          ready: true,
          operating: { address: id },
          overview: { agreements: [], payments: [] },
        };
      if (action.op === "billing_invoice") throw new Error("Foreign invoice");
      if (action.op === "billing") return { invoices: [], owner: id };
      return { proposal_id: "1".repeat(32) };
    },
  };
  const app = createApplication({
    accounts,
    backend,
    origin,
    background: false,
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  const url = `http://127.0.0.1:${app.server.address().port}`;
  async function request(
    route,
    {
      body,
      token,
      headers = {},
      method = body === undefined ? "GET" : "POST",
    } = {},
  ) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        url + route,
        {
          method,
          headers: {
            host: "tandem.example",
            origin,
            "X-Tandem-Request": "1",
            "Content-Type": "application/json",
            ...(token ? { cookie: token } : {}),
            ...headers,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              body: JSON.parse(data),
              cookie: res.headers["set-cookie"]?.[0],
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  assert.equal((await request("/api/workspace")).status, 401);
  const healthHeaders = { host: "healthcheck.railway.app" };
  assert.deepEqual(
    (await request("/healthz", { headers: healthHeaders })).body,
    { ok: true },
  );
  assert.equal((await request("/healthz")).status, 200);
  for (const route of ["/session", "/api/workspace", "/healthz?private=1"]) {
    assert.equal((await request(route, { headers: healthHeaders })).status, 403);
  }
  assert.equal(
    (await request("/healthz", { headers: healthHeaders, body: {} })).status,
    403,
  );
  assert.equal(
    (await request("/healthz", { headers: { host: "attacker.example" } })).status,
    403,
  );
  assert.equal(
    (await request("/session", { headers: { host: "attacker.example" } }))
      .status,
    403,
  );
  assert.equal(
    (
      await request("/session", {
        headers: { origin: "https://attacker.example" },
      })
    ).status,
    403,
  );
  const password = randomBytes(24).toString("hex");
  const a = await request("/api/auth/register", {
    body: { username: "alice", password },
  });
  assert.equal(a.status, 200);
  assert.match(a.cookie, /HttpOnly/);
  assert.match(a.cookie, /SameSite=Strict/);
  assert.match(a.cookie, /; Secure/);
  const tokenA = a.cookie.split(";")[0];
  const b = await request("/api/auth/register", {
    body: { username: "bob", password: randomBytes(24).toString("hex") },
  });
  assert.equal(b.status, 200);
  const tokenB = b.cookie.split(";")[0];
  await app.runOne();
  await app.runOne();
  const wa = (await request("/api/workspace", { token: tokenA })).body.result;
  const wb = (await request("/api/workspace", { token: tokenB })).body.result;
  assert.notEqual(wa.id, wb.id);
  assert.equal(wa.snapshot.operating.address, wa.id);
  assert.equal(wb.snapshot.operating.address, wb.id);
  assert.equal(
    (await request("/api/workspace?workspace_id=" + wb.id, { token: tokenA }))
      .body.result.id,
    wa.id,
  );
  assert.equal(
    (await request("/api/billing", { token: tokenA })).body.result.owner,
    wa.id,
  );
  assert.equal(
    (
      await request("/api/billing/invoices/" + "a".repeat(64), {
        token: tokenB,
      })
    ).status,
    404,
  );
  assert.equal(calls.at(-1).id, wb.id);
  assert.equal(
    (
      await request("/api/agreements/propose", {
        token: tokenA,
        body: { payments: 1, interval_secs: 600, state_dir: wb.id },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request("/api/wallet/sync", {
        token: tokenA,
        body: {},
        headers: { "X-Tandem-Request": "" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/api/wallet/sync", {
        token: tokenA,
        body: {},
        headers: { "sec-fetch-site": "cross-site" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/api/agreements/propose", {
        token: tokenA,
        body: { payments: 1, interval_secs: 600 },
      })
    ).status,
    202,
  );
  assert.equal(
    (await request("/api/wallet/sync", { token: tokenA, body: {} })).status,
    409,
  );
  await app.runOne();
  assert.equal(calls.at(-1).id, wa.id);
  assert.equal(
    (await request("/api/workspace", { token: tokenB })).body.result.job_result
      .proposal_id,
    undefined,
  );
  assert.equal(
    (
      await request("/api/auth/login", {
        body: { username: "alice", password: "wrong-password" },
      })
    ).status,
    401,
  );
  const stored = accounts.db
    .prepare("SELECT password_hash FROM users WHERE username=?")
    .get("alice");
  assert.notEqual(stored.password_hash, password);
  const digest = accounts.db
    .prepare("SELECT digest FROM sessions LIMIT 1")
    .get().digest;
  assert.notEqual(digest, tokenA.split("=")[1]);
  assert.equal(
    (await request("/api/logout", { token: tokenA, body: {} })).status,
    200,
  );
  assert.equal(
    (await request("/api/workspace", { token: tokenA })).status,
    401,
  );
  assert.equal(
    (await request("/api/workspace", { token: tokenB })).status,
    200,
  );
  assert.equal(
    (await request("/wallets/" + wb.id + "/seed.bin", { token: tokenB }))
      .status,
    404,
  );
});

test("restart preserves session ownership and retries the exact interrupted workspace job", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "tandem-restart-"));
  let accounts = new Accounts(root);
  const user = await accounts.register(
    "restart",
    randomBytes(24).toString("hex"),
  );
  const token = accounts.session(user.id),
    w = accounts.workspace(user.id),
    action = {
      op: "approve",
      proposal_id: "a".repeat(32),
      digest: "b".repeat(64),
    };
  accounts.enqueue(user.id, action);
  accounts.running(w.id);
  accounts.retry(w.id, "Interrupted");
  assert.deepEqual(JSON.parse(accounts.next().job), action);
  accounts.running(w.id);
  accounts.close();
  accounts = new Accounts(root);
  assert.equal(accounts.user(token).id, user.id);
  assert.equal(accounts.next().id, w.id);
  assert.deepEqual(JSON.parse(accounts.next().job), action);
  accounts.db.prepare("UPDATE sessions SET expires=0").run();
  assert.equal(accounts.user(token), null);
  accounts.close();
});

test("backend rejects client-controlled filesystem identities before spawning a process", async () => {
  const backend = createBackend({ root: tmpdir(), binary: "/does-not-run" });
  await assert.rejects(backend.execute("../other", { op: "status" }));
  await assert.rejects(backend.execute("/root", { op: "status" }));
});

test("public release requires a canonical HTTPS origin", () => {
  for (const origin of [
    "http://tandem.example",
    "https://tandem.example/path",
    "https://tandem.example/",
  ]) {
    assert.throws(() =>
      createApplication({
        accounts: {},
        backend: {},
        origin,
        background: false,
      }),
    );
  }
});

test("simultaneous registration cannot exceed the account limit", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "tandem-cap-"));
  const accounts = new Accounts(root);
  const outcomes = await Promise.allSettled([
    accounts.register("first", randomBytes(24).toString("hex"), 1),
    accounts.register("second", randomBytes(24).toString("hex"), 1),
  ]);
  assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(accounts.db.prepare("SELECT count(*) n FROM users").get().n, 1);
  accounts.close();
});
