import http from "node:http";
import { readFile } from "node:fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import { request as rpc } from "../agent/client.mjs";

export function createApi({
  token,
  port = 4318,
  origins = [],
  signer,
  supplier,
}) {
  const hash = (value) => createHash("sha256").update(value).digest();
  const expected = hash(token);
  let active = 0;
  return http.createServer(
    { requestTimeout: 10000, headersTimeout: 5000, maxHeaderSize: 8192 },
    async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      const send = (status, value) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (
        ![`localhost:${port}`, `127.0.0.1:${port}`].includes(req.headers.host)
      )
        return send(403, { error: "Host not allowed" });
      if (req.headers.origin) {
        if (!origins.includes(req.headers.origin))
          return send(403, { error: "Origin not allowed" });
        res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
        res.setHeader("Vary", "Origin");
      }
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Authorization, Content-Type",
        );
        return send(204, {});
      }
      if (req.url === "/health" && req.method === "GET")
        return send(200, { ok: true, network: "zcash-testnet" });
      const authorization = req.headers.authorization || "";
      if (
        !authorization.startsWith("Bearer ") ||
        !timingSafeEqual(hash(authorization.slice(7)), expected)
      )
        return send(401, { error: "Authentication required" });
      if (active >= 8) return send(503, { error: "Backend busy; retry" });
      active++;
      try {
        let body = {};
        if (req.method === "POST") {
          if (req.headers["content-type"]?.split(";")[0] !== "application/json")
            return send(415, { error: "Use application/json" });
          let bytes = Buffer.alloc(0);
          for await (const chunk of req) {
            bytes = Buffer.concat([bytes, chunk]);
            if (bytes.length > 32768)
              return send(413, { error: "Request too large" });
          }
          try {
            body = JSON.parse(bytes.toString());
          } catch {
            return send(400, { error: "Invalid JSON" });
          }
          if (!body || Array.isArray(body) || typeof body !== "object")
            return send(400, { error: "Expected a JSON object" });
        }
        const exact = (keys) =>
          Object.keys(body).sort().join(",") === [...keys].sort().join(",");
        const url = new URL(req.url, "http://localhost");
        if (url.search)
          return send(400, { error: "Query parameters are not supported" });
        let result;
        if (req.method === "GET" && url.pathname === "/v1/overview") {
          const [a, b] = await Promise.all([
            signer({ op: "overview" }),
            supplier({ op: "overview" }),
          ]);
          if (!a.ok || !b.ok)
            return send(503, { error: "Overview temporarily unavailable" });
          return send(200, {
            ok: true,
            result: { signer: a.result, supplier: b.result },
          });
        }
        if (
          req.method === "POST" &&
          url.pathname === "/v1/invoices/current" &&
          exact([])
        )
          result = await supplier({ op: "invoice" });
        else if (
          req.method === "POST" &&
          url.pathname === "/v1/payments" &&
          exact(["invoice"])
        )
          result = await signer({ op: "submit", invoice: body.invoice });
        else if (
          req.method === "GET" &&
          /^\/v1\/payments\/[a-f0-9]{64}$/.test(url.pathname)
        )
          result = await signer({
            op: "status",
            payment_id: url.pathname.split("/").at(-1),
          });
        else if (
          req.method === "POST" &&
          /^\/v1\/invoices\/[a-f0-9]{64}\/settlement$/.test(url.pathname) &&
          exact(["txid"])
        )
          result = await supplier({
            op: "settle",
            invoice_id: url.pathname.split("/")[3],
            txid: body.txid,
          });
        else if (
          req.method === "GET" &&
          /^\/v1\/invoices\/[a-f0-9]{64}\/resource$/.test(url.pathname)
        )
          result = await supplier({
            op: "access",
            invoice_id: url.pathname.split("/")[3],
          });
        else return send(404, { error: "Unknown route or request fields" });
        return send(result.ok ? 200 : 409, result);
      } catch {
        return send(503, {
          error: "Backend unavailable; retain and retry the exact invoice",
        });
      } finally {
        active--;
      }
    },
  );
}

if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
) {
  const {
    API_TOKEN_FILE,
    SIGNER_SOCKET,
    SIGNER_TOKEN_FILE,
    SUPPLIER_SOCKET,
    SUPPLIER_TOKEN_FILE,
  } = process.env;
  if (
    !API_TOKEN_FILE ||
    !SIGNER_SOCKET ||
    !SIGNER_TOKEN_FILE ||
    !SUPPLIER_SOCKET ||
    !SUPPLIER_TOKEN_FILE
  )
    throw new Error("Backend paths and API capability required");
  const token = (await readFile(API_TOKEN_FILE, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid API capability");
  const port = Number(process.env.API_PORT || 4318);
  const origins = (
    process.env.API_ALLOWED_ORIGINS ||
    "http://localhost:4173,http://localhost:5173"
  )
    .split(",")
    .filter(Boolean);
  createApi({
    token,
    port,
    origins,
    signer: (action) => rpc(SIGNER_SOCKET, SIGNER_TOKEN_FILE, action),
    supplier: (action) => rpc(SUPPLIER_SOCKET, SUPPLIER_TOKEN_FILE, action),
  }).listen(port, "127.0.0.1", () =>
    console.log(`Backend API ready at http://127.0.0.1:${port}`),
  );
}
