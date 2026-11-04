import http from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Local owner console. The capability stays in this process; browser sessions
// cannot invoke arbitrary upstream routes or owner administration commands.
export function createBillingServer({
  token,
  accessCode,
  port = 4175,
  backend = "http://127.0.0.1:4318",
  root = fileURLToPath(new URL("../dist-billing/", import.meta.url)),
  fetchBackend = fetch,
}) {
  if (!/^[a-f0-9]{64}$/.test(accessCode || ""))
    throw new Error("A separate workspace access code is required");
  const hash = (value) => createHash("sha256").update(value).digest();
  const accessHash = hash(accessCode);
  const sessions = new Map();
  let attempts = 0,
    attemptWindow = Date.now();
  const hostAllowed = (host) =>
    [`localhost:${port}`, `127.0.0.1:${port}`].includes(host);
  const cookieName = "billing_session";
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".css": "text/css",
    ".ttf": "font/ttf",
    ".svg": "image/svg+xml",
  };
  return http.createServer(
    { requestTimeout: 10000, headersTimeout: 5000, maxHeaderSize: 8192 },
    async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
      );
      const send = (status, data) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (
        !hostAllowed(req.headers.host) ||
        (req.headers.origin &&
          req.headers.origin !== `http://${req.headers.host}`) ||
        ["cross-site", "same-site"].includes(req.headers["sec-fetch-site"])
      )
        return send(403, {
          error: "This workspace is local to this browser origin",
        });
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && url.pathname === "/session") {
        const session = req.headers.cookie
          ?.split(";")
          .map((x) => x.trim())
          .find((x) => x.startsWith(`${cookieName}=`))
          ?.slice(cookieName.length + 1);
        return send(200, {
          ok: true,
          result: {
            unlocked:
              !!session &&
              sessions.has(session) &&
              sessions.get(session) > Date.now(),
          },
        });
      }
      if (req.method === "POST" && url.pathname === "/session") {
        if (
          req.headers.origin !== `http://${req.headers.host}` ||
          req.headers["x-billing-request"] !== "1"
        )
          return send(403, { error: "Open the local workspace first" });
        if (Date.now() - attemptWindow > 60000) {
          attempts = 0;
          attemptWindow = Date.now();
        }
        if (++attempts > 10)
          return send(429, {
            error: "Too many unlock attempts; try again in a minute",
          });
        let bytes = Buffer.alloc(0);
        for await (const chunk of req) {
          bytes = Buffer.concat([bytes, chunk]);
          if (bytes.length > 512)
            return send(413, { error: "Unlock request too large" });
        }
        let credentials;
        try {
          credentials = JSON.parse(bytes.toString());
        } catch {
          return send(401, { error: "Enter the workspace access code" });
        }
        if (
          typeof credentials?.access_code !== "string" ||
          Object.keys(credentials).length !== 1 ||
          !timingSafeEqual(hash(credentials.access_code), accessHash)
        )
          return send(401, { error: "Workspace access code is incorrect" });
        attempts = 0;
        for (const [id, expires] of sessions)
          if (expires < Date.now()) sessions.delete(id);
        if (sessions.size >= 32)
          return send(429, { error: "Too many local sessions" });
        const session = randomBytes(32).toString("hex");
        sessions.set(session, Date.now() + 8 * 60 * 60 * 1000);
        res.setHeader(
          "Set-Cookie",
          `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
        );
        return send(200, { ok: true });
      }
      if (url.pathname.startsWith("/api/")) {
        const session = req.headers.cookie
          ?.split(";")
          .map((x) => x.trim())
          .find((x) => x.startsWith(`${cookieName}=`))
          ?.slice(cookieName.length + 1);
        if (
          !session ||
          !sessions.has(session) ||
          sessions.get(session) < Date.now()
        )
          return send(401, { error: "Open your local workspace to continue" });
        if (req.method === "POST" && url.pathname === "/api/lock") {
          if (
            req.headers.origin !== `http://${req.headers.host}` ||
            req.headers["x-billing-request"] !== "1"
          )
            return send(403, { error: "Request origin rejected" });
          sessions.delete(session);
          res.setHeader(
            "Set-Cookie",
            `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
          );
          return send(200, { ok: true });
        }
        let route;
        if (req.method === "GET" && url.pathname === "/api/billing")
          route = "/v1/billing" + url.search;
        else if (
          req.method === "GET" &&
          /^\/api\/billing\/invoices\/[a-f0-9]{64}$/.test(url.pathname) &&
          !url.search
        )
          route = url.pathname.replace("/api/", "/v1/");
        else if (
          req.method === "GET" &&
          url.pathname === "/api/overview" &&
          !url.search
        )
          route = "/v1/overview";
        else if (
          req.method === "POST" &&
          /^\/api\/invoices\/[a-f0-9]{64}\/recheck$/.test(url.pathname) &&
          !url.search
        ) {
          if (
            req.headers.origin !== `http://${req.headers.host}` ||
            req.headers["x-billing-request"] !== "1"
          )
            return send(403, { error: "Request origin rejected" });
          // The server selects the existing txid, not a browser-provided receipt.
          const id = url.pathname.split("/")[3];
          try {
            const detail = await fetchBackend(
              `${backend}/v1/billing/invoices/${id}`,
              {
                headers: { Authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(10000),
              },
            ).then((r) => r.json());
            if (
              !detail.ok ||
              !(detail.result.txid || detail.result.payment_candidate?.txid)
            )
              return send(409, { error: "No recorded payment to recheck" });
            const response = await fetchBackend(
              `${backend}/v1/invoices/${id}/settlement`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  txid:
                    detail.result.txid || detail.result.payment_candidate?.txid,
                }),
                signal: AbortSignal.timeout(170000),
              },
            );
            return send(response.status, await response.json());
          } catch {
            return send(503, {
              error:
                "Receipt verification unavailable. The previous observation is not a fresh confirmation.",
            });
          }
        } else return send(404, { error: "Unknown workspace operation" });
        try {
          const response = await fetchBackend(backend + route, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15000),
          });
          return send(response.status, await response.json());
        } catch {
          return send(503, {
            error:
              "Billing service unavailable. Try again without creating a replacement invoice.",
          });
        }
      }
      if (req.method !== "GET")
        return send(405, { error: "Method not allowed" });
      let file;
      if (url.pathname === "/") file = "index.html";
      else if (
        /^\/assets\/[a-zA-Z0-9_.-]+\.(js|css)$/.test(url.pathname) ||
        /^\/fonts\/[a-zA-Z0-9_.-]+\.ttf$/.test(url.pathname) ||
        url.pathname === "/mark.svg"
      )
        file = url.pathname.slice(1);
      else return send(404, { error: "Not found" });
      try {
        res.setHeader(
          "Content-Type",
          types[path.extname(file)] || "application/octet-stream",
        );
        res.end(await readFile(path.join(root, file)));
      } catch {
        return send(503, { error: "Build the billing app before opening it" });
      }
    },
  );
}
if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
) {
  if (!process.env.API_TOKEN_FILE)
    throw new Error("Set API_TOKEN_FILE for the local billing server");
  const token = (await readFile(process.env.API_TOKEN_FILE, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid API capability");
  if (!process.env.BILLING_ACCESS_FILE)
    throw new Error(
      "Set BILLING_ACCESS_FILE to a separate private workspace access code",
    );
  const accessCode = (
    await readFile(process.env.BILLING_ACCESS_FILE, "utf8")
  ).trim();
  createBillingServer({ token, accessCode }).listen(4175, "127.0.0.1", () =>
    console.log("Billing workspace: http://localhost:4175"),
  );
}
