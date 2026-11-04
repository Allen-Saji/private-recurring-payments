import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Accounts } from "./store.mjs";
import { createBackend } from "./backend.mjs";
import {
  catalog,
  service,
  reviewAccess,
  publicDocument,
  pageMetadata,
} from "./discovery.mjs";
import { loadReview, reviewRead } from "./review.mjs";

export function createApplication({
  accounts,
  backend,
  origin = "http://localhost:4176",
  assets = fileURLToPath(new URL("../web/dist-product/", import.meta.url)),
  maxAccounts = 50,
  background = true,
  review = null,
}) {
  const publicOrigin = new URL(origin);
  if (
    publicOrigin.origin !== origin ||
    publicOrigin.pathname !== "/" ||
    (publicOrigin.protocol !== "https:" &&
      !["localhost", "127.0.0.1"].includes(publicOrigin.hostname))
  )
    throw new Error("Use a canonical HTTPS origin for public testing.");
  const secure = publicOrigin.protocol === "https:",
    cookie = "tandem_session";
  let authBusy = 0,
    workerBusy = false,
    closed = false;
  const serial = new Set();
  const credential = (req) =>
    req.headers.cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(cookie + "="))
      ?.slice(cookie.length + 1);
  const publicWorkspace = (w) => ({
    id: w.id,
    name: w.name,
    state: w.state,
    error: w.error,
    snapshot: w.snapshot,
    job_result: w.job_result,
    automation: !!w.automation,
    updatedAt: w.updated_at,
  });
  const run = async () => {
    if (workerBusy || closed) return;
    const job = accounts.next();
    if (!job || serial.has(job.id)) return;
    workerBusy = true;
    serial.add(job.id);
    accounts.running(job.id);
    try {
      const action = JSON.parse(job.job);
      const result = await backend.execute(job.id, action);
      accounts.finish(job.id, result, action);
    } catch (error) {
      const action = JSON.parse(job.job);
      if (closed || error.message.startsWith("Wallet operation interrupted."))
        accounts.retry(
          job.id,
          "Operation interrupted; retrying the saved request.",
        );
      else if (
        action.op === "verify_funding" &&
        /not mined|unavailable|timed out|behind/i.test(error.message)
      )
        accounts.finish(job.id, { pending_funding: action.txid }, action);
      else accounts.fail(job.id, error.message);
    } finally {
      serial.delete(job.id);
      workerBusy = false;
    }
  };
  const timer = background
    ? setInterval(() => {
        for (const w of accounts.scheduled()) {
          const previous = w.job_result ? JSON.parse(w.job_result) : {};
          if (previous.pending_funding) {
            accounts.enqueue(w.user_id, {
              op: "verify_funding",
              txid: previous.pending_funding,
            });
            continue;
          }
          const snap = w.snapshot ? JSON.parse(w.snapshot) : {};
          const a = snap.overview?.agreements?.[0];
          if (
            a?.revoked ||
            a?.envelope?.payload?.expires_at * 1000 < Date.now() - 3600000
          )
            continue;
          accounts.enqueue(w.user_id, { op: "tick" });
        }
        void run();
      }, 1000)
    : null;
  timer?.unref();
  const server = http.createServer(
    { requestTimeout: 15000, headersTimeout: 5000, maxHeaderSize: 8192 },
    async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      );
      const send = (status, body) => {
        if (!res.headersSent) {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(body));
        }
      };
      // Railway probes use their own Host. Exempt only this data-free endpoint.
      if (
        req.url === "/healthz" &&
        ["GET", "HEAD"].includes(req.method) &&
        [publicOrigin.host, "healthcheck.railway.app"].includes(req.headers.host)
      )
        return send(closed ? 503 : 200, { ok: !closed });
      if (req.headers.host !== publicOrigin.host)
        return send(403, { error: "Host not allowed" });
      if (req.headers.origin && req.headers.origin !== origin)
        return send(403, { error: "Origin not allowed" });
      let url;
      try {
        url = new URL(req.url, origin);
      } catch {
        return send(400, { error: "Invalid request" });
      }
      const protectedRequest =
        url.pathname.startsWith("/api/") || url.pathname === "/session";
      if (
        protectedRequest &&
        ["cross-site", "same-site"].includes(req.headers["sec-fetch-site"])
      )
        return send(403, { error: "Origin not allowed" });
      if (["GET", "HEAD"].includes(req.method)) {
        const document = publicDocument(url.pathname, origin, !!review);
        if (document) {
          res.writeHead(200, {
            "Content-Type": document.type,
            Link: '</llms.txt>; rel="describedby"',
          });
          res.end(document.body);
          return;
        }
        if (url.pathname === "/api/catalog")
          return send(200, { ok: true, result: catalog });
        if (url.pathname === "/api/catalog/" + service.id)
          return send(200, { ok: true, result: service });
        if (url.pathname.startsWith("/api/catalog/"))
          return send(404, { error: "Service not found" });
      }
      try {
        let body = {};
        if (req.method === "POST") {
          if (
            req.headers.origin !== origin ||
            req.headers["x-tandem-request"] !== "1"
          )
            return send(403, { error: "Request origin rejected" });
          if (req.headers["content-type"]?.split(";")[0] !== "application/json")
            return send(415, { error: "Use application/json" });
          let raw = Buffer.alloc(0);
          for await (const chunk of req) {
            raw = Buffer.concat([raw, chunk]);
            if (raw.length > 8192)
              return send(413, { error: "Request too large" });
          }
          try {
            body = JSON.parse(raw.toString());
          } catch {
            return send(400, { error: "Invalid JSON" });
          }
          if (!body || Array.isArray(body) || typeof body !== "object")
            return send(400, { error: "Expected a JSON object" });
        }
        const exact = (keys) =>
          Object.keys(body).sort().join(",") === [...keys].sort().join(",");
        const token = credential(req),
          user = accounts.user(token);
        if (req.method === "GET" && url.pathname === "/session")
          return send(200, {
            ok: true,
            result: {
              unlocked: !!user,
              user: user ? { username: user.username, role: user.role } : null,
            },
          });
        if (
          req.method === "POST" &&
          ["/api/auth/register", "/api/auth/login"].includes(url.pathname)
        ) {
          if (!exact(["username", "password"]))
            return send(400, { error: "Unexpected account fields" });
          if (
            authBusy >= 2 ||
            !accounts.rate("auth:global", 60) ||
            !accounts.rate(
              "auth:" + String(body.username).slice(0, 32).toLowerCase(),
              10,
            )
          )
            return send(429, {
              error: "Too many attempts. Try again in a minute.",
            });
          authBusy++;
          try {
            const registering = url.pathname.endsWith("/register");
            if (registering && !accounts.rate("registration:global", 10, 3600))
              return send(429, {
                error: "Registration is busy. Try again later.",
              });
            const identity = registering
              ? await accounts.register(
                  body.username,
                  body.password,
                  maxAccounts,
                )
              : await accounts.login(body.username, body.password);
            if (!identity)
              return send(401, { error: "Username or password is incorrect." });
            const session = accounts.session(identity.id);
            res.setHeader(
              "Set-Cookie",
              `${cookie}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure ? "; Secure" : ""}`,
            );
            const workspace = accounts.workspace(identity.id);
            if (identity.role !== "reviewer" && workspace.state === "new")
              accounts.enqueue(identity.id, {
                op: "initialize",
                company: identity.username,
                signer_id: "ws-" + workspace.id,
              });
            return send(200, {
              ok: true,
              result: { username: identity.username, role: identity.role },
            });
          } catch (error) {
            return send(400, { error: error.message });
          } finally {
            authBusy--;
          }
        }
        if (url.pathname.startsWith("/api/")) {
          if (!user) return send(401, { error: "Sign in to your workspace." });
          const workspace = accounts.workspace(user.id);
          if (
            req.method === "POST" &&
            url.pathname === "/api/logout" &&
            exact([])
          ) {
            accounts.logout(token);
            res.setHeader(
              "Set-Cookie",
              `${cookie}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? "; Secure" : ""}`,
            );
            return send(200, { ok: true });
          }
          if (user.role === "reviewer") {
            if (req.method !== "GET")
              return send(403, {
                error:
                  "Review access is read-only. Create your own workspace to authorize payments.",
              });
            if (!review)
              return send(503, {
                error: "Recorded review evidence is not configured.",
              });
            if (url.search)
              return send(400, {
                error: "Review records do not accept query overrides.",
              });
            const result = reviewRead(review, url);
            if (result === undefined)
              return send(404, {
                error: "This record is not available in the review workspace.",
              });
            return send(
              200,
              url.pathname === "/api/status" ? result : { ok: true, result },
            );
          }
          if (req.method === "GET" && url.pathname === "/api/workspace")
            return send(200, { ok: true, result: publicWorkspace(workspace) });
          if (req.method === "GET" && url.pathname === "/api/status") {
            if (!workspace.snapshot)
              return send(503, {
                error: "Your workspace wallet is being prepared.",
              });
            return send(200, workspace.snapshot);
          }
          let action;
          if (
            req.method === "POST" &&
            url.pathname === "/api/workspace/initialize" &&
            exact([])
          )
            action = {
              op: "initialize",
              company: user.username,
              signer_id: "ws-" + workspace.id,
            };
          else if (
            req.method === "POST" &&
            url.pathname === "/api/wallet/sync" &&
            exact([])
          )
            action = { op: "sync" };
          else if (
            req.method === "POST" &&
            url.pathname === "/api/wallet/verify" &&
            exact(["txid"]) &&
            /^[a-f0-9]{64}$/.test(body.txid)
          )
            action = { op: "verify_funding", txid: body.txid };
          else if (
            req.method === "POST" &&
            url.pathname === "/api/agreements/propose" &&
            (exact(["payments", "interval_secs"]) ||
              (exact(["service_id", "payments", "interval_secs"]) &&
                body.service_id === service.id)) &&
            Number.isInteger(body.payments) &&
            Number.isInteger(body.interval_secs)
          )
            action = {
              op: "propose",
              service_id: service.id,
              payments: body.payments,
              interval_secs: body.interval_secs,
            };
          else if (
            req.method === "POST" &&
            url.pathname === "/api/agreements/approve" &&
            exact(["proposal_id", "digest"]) &&
            /^[a-f0-9]{32}$/.test(body.proposal_id) &&
            /^[a-f0-9]{64}$/.test(body.digest)
          )
            action = { op: "approve", ...body };
          else if (
            req.method === "POST" &&
            url.pathname === "/api/agreements/cancel" &&
            exact([])
          )
            action = { op: "cancel" };
          else if (
            req.method === "POST" &&
            url.pathname === "/api/payments/run" &&
            exact([])
          )
            action = { op: "tick" };
          if (action) {
            if (!accounts.rate("mutation:" + user.id, 15))
              return send(429, {
                error: "Too many requests. Try again shortly.",
              });
            if (!workspace.snapshot && action.op !== "initialize")
              return send(409, {
                error: "Wait for your wallet to finish setup.",
              });
            if (!accounts.enqueue(user.id, action))
              return send(409, {
                error: "Your workspace is already processing an operation.",
              });
            return send(202, { ok: true, result: { state: "queued" } });
          }
          if (
            ["queued", "running"].includes(workspace.state) ||
            serial.has(workspace.id)
          )
            return send(503, {
              error: "Your workspace is updating. Try again shortly.",
            });
          if (!workspace.snapshot)
            return send(409, { error: "Set up your workspace wallet first." });
          if (req.method === "GET" && url.pathname === "/api/billing") {
            const cursor = url.searchParams.get("before");
            if (
              [...url.searchParams].some(([k]) => k !== "before") ||
              [...url.searchParams].length > 1 ||
              (cursor !== null &&
                (!/^[1-9][0-9]{0,15}$/.test(cursor) ||
                  !Number.isSafeInteger(Number(cursor))))
            )
              return send(400, { error: "Invalid cursor" });
            action = {
              op: "billing",
              before: cursor === null ? null : Number(cursor),
            };
          } else if (
            req.method === "GET" &&
            /^\/api\/billing\/invoices\/[a-f0-9]{64}$/.test(url.pathname) &&
            !url.search
          )
            action = {
              op: "billing_invoice",
              invoice_id: url.pathname.split("/").at(-1),
            };
          else if (
            req.method === "GET" &&
            url.pathname === "/api/overview" &&
            !url.search
          )
            return send(200, {
              ok: true,
              result: { signer: workspace.snapshot.overview },
            });
          else if (
            req.method === "POST" &&
            /^\/api\/invoices\/[a-f0-9]{64}\/recheck$/.test(url.pathname) &&
            exact([])
          )
            action = { op: "recheck", invoice_id: url.pathname.split("/")[3] };
          else if (
            req.method === "GET" &&
            /^\/api\/invoices\/[a-f0-9]{64}\/resource$/.test(url.pathname) &&
            !url.search
          )
            action = { op: "access", invoice_id: url.pathname.split("/")[3] };
          else return send(404, { error: "Not found" });
          serial.add(workspace.id);
          try {
            return send(200, {
              ok: true,
              result: await backend.execute(workspace.id, action),
            });
          } catch {
            return send(404, {
              error: "This record is unavailable in your workspace.",
            });
          } finally {
            serial.delete(workspace.id);
          }
        }
        if (!["GET", "HEAD"].includes(req.method))
          return send(405, { error: "Method not allowed" });
        const pages = {
          "/": "landing/index.html",
          "/app": "hub/index.html",
          "/app/services": "hub/index.html",
          "/services": "hub/index.html",
          "/services/network-telemetry": "hub/index.html",
          "/agents": "hub/index.html",
          "/app/agreements": "workspace/index.html",
          "/app/wallet": "index.html",
          "/app/invoices": "billing/index.html",
        };
        const file =
          pages[url.pathname] ||
          (/^\/(assets|fonts)\/[a-zA-Z0-9_.-]+\.(js|css|ttf)$/.test(
            url.pathname,
          )
            ? url.pathname.slice(1)
            : [
                  "/mark.svg",
                  "/favicon.svg",
                  "/favicon.ico",
                  "/apple-touch-icon.png",
                  "/tandem-logo.svg",
                  "/tandem-logo.png",
                  "/og-tandem.png",
                  "/sealed-sculpture.png",
                ].includes(url.pathname)
              ? url.pathname.slice(1)
              : null);
        if (!file) return send(404, { error: "Page not found" });
        const mime = {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript",
          ".css": "text/css",
          ".ttf": "font/ttf",
          ".svg": "image/svg+xml",
          ".png": "image/png",
          ".ico": "image/x-icon",
        };
        try {
          let bytes = await readFile(path.join(assets, file));
          if (file.endsWith(".html")) {
            const page = pageMetadata(bytes.toString(), url.pathname, origin);
            bytes = Buffer.from(page.html);
            res.setHeader(
              "Content-Security-Policy",
              res
                .getHeader("Content-Security-Policy")
                .replace(
                  "script-src 'self'",
                  `script-src 'self' 'sha256-${page.hash}'`,
                ),
            );
            res.setHeader(
              "Link",
              '</llms.txt>; rel="describedby", </openapi.json>; rel="service-desc"',
            );
          }
          res.writeHead(200, {
            "Content-Type":
              mime[path.extname(file)] || "application/octet-stream",
          });
          res.end(bytes);
        } catch {
          return send(503, {
            error: "The application is being updated. Try again shortly.",
          });
        }
      } catch {
        return send(500, { error: "The request could not be completed." });
      }
    },
  );
  return {
    server,
    runOne: run,
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      backend.stop?.();
      await new Promise((resolve) => server.close(resolve));
      while (workerBusy || serial.size) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      accounts.close();
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
) {
  if (!process.env.APP_STATE_DIR || !process.env.PRP_BINARY)
    throw new Error("APP_STATE_DIR and PRP_BINARY are required.");
  const accounts = new Accounts(process.env.APP_STATE_DIR),
    backend = createBackend({
      root: process.env.APP_STATE_DIR,
      binary: process.env.PRP_BINARY,
    });
  const review = await loadReview(process.env.JUDGE_EVIDENCE_FILE);
  if (review) await accounts.ensureReviewer(reviewAccess);
  const app = createApplication({
    accounts,
    backend,
    review,
    origin: process.env.APP_ORIGIN || "http://localhost:4176",
    maxAccounts: Number(process.env.MAX_ACCOUNTS || 50),
  });
  app.server.listen(
    Number(process.env.APP_PORT || process.env.PORT || 4176),
    process.env.APP_HOST || "127.0.0.1",
    () => console.log("Tandem application ready."),
  );
  process.on("SIGTERM", () => {
    void app.close().then(() => process.exit(0));
  });
}
