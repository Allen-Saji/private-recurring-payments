import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { schemas, attachResponseContracts } from "./contracts.mjs";
export const catalog = JSON.parse(
  readFileSync(new URL("../shared/catalog.json", import.meta.url)),
);
export const reviewAccess = JSON.parse(
  readFileSync(new URL("../shared/review-access.json", import.meta.url)),
);
export const service = catalog.services[0];
export const description =
  "Private recurring supplier payments and invoicing on Zcash NU7 testnet. Approve exact limits; agents execute matching invoices; suppliers verify shielded receipts.";
export function discovery(origin, reviewEnabled) {
  return {
    name: "Tandem",
    description,
    network: "zcash-testnet",
    consensus: "NU7",
    custody: "Service-managed testnet wallets and approval keys",
    catalog: origin + "/api/catalog",
    documentation: origin + "/agents",
    instructions: origin + "/llms.txt",
    openapi: origin + "/openapi.json",
    review: reviewEnabled
      ? { ...reviewAccess, login: origin + "/api/auth/login" }
      : null,
    workflow: [
      "discover_service",
      "sign_in_or_create_workspace",
      "fund_with_noir",
      "propose_agreement",
      "review_exact_terms",
      "explicitly_authorize",
      "poll_workspace",
      "read_invoices_and_verified_receipts",
      "access_paid_service",
      "cancel_future_payments",
    ],
    limits: {
      agreements_per_workspace: 1,
      payments_per_agreement: [1, 2, 3],
      currency: "TAZ",
      mainnet: false,
    },
    authority:
      "Public discovery grants no payment authority. Reviewer sessions are read-only. Obtain owner authorization before funding, approving recurring payments or cancelling an agreement.",
    mcp: {
      transport: "stdio",
      entry: "agent/mcp.mjs",
      scope:
        "Separately deployed lower-level signer/supplier services; not a public remote MCP endpoint.",
    },
  };
}
export function guide(origin, reviewEnabled) {
  return `# Tandem

> ${description}

## Start here

- [Browse the connected service](${origin}/services)
- [Open the workspace](${origin}/app)
- [Create your own workspace](${origin}/app?create)
- [Agent guide](${origin}/agents)
- [Service catalog JSON](${origin}/api/catalog)
- [API contract](${origin}/openapi.json)
- [Discovery JSON](${origin}/.well-known/tandem.json)

## Review without a wallet

${reviewEnabled ? `The login form prefills public review credentials: username \`${reviewAccess.username}\`, password \`${reviewAccess.password}\`. This is read-only access to genuine recorded NU7 invoices, signed terms and supplier receipts. It cannot fund, approve, cancel or mutate a wallet. Recorded confirmation counts are historical observations.` : "Review access has not been configured on this installation. Create your own workspace or ask the operator to enable the recorded evidence pack."}

## Company workflow

1. Read GET /api/catalog. The only connected supplier is Tandem-operated Network Telemetry (service_id: network-telemetry), not an independent third-party marketplace.
2. Create an owner account through the website. For API registration, POST /api/auth/register with username (3-32 characters, leading letter) and password (12-128 characters). Preserve the HttpOnly tandem_session cookie. GET /session identifies your role.
3. Poll GET /api/workspace until state is ready. New wallets need network initialization. A dedicated shielded address appears in snapshot.operating.address. Use the Wallet page and Noir to approve the fixed 0.05 TAZ deposit. The browser never supplies wallet keys to the server. A separate faucet deposit also funds the balance but is not a Noir funding receipt.
4. POST /api/agreements/propose with {"service_id":"network-telemetry","payments":1,"interval_secs":600}. Allowed payment counts: 1, 2, 3. Intervals: 600, 3600, 86400 seconds. Each service invoice is 1000000 zatoshis (0.01 TAZ), with 100000 zatoshis (0.001 TAZ) maximum fee allowance. One TAZ = 100000000 zatoshis; use integer/string amounts.
5. Poll the workspace. job_result contains proposal_id, digest, exact terms and review_expires_at. Present the recipient, supplier key, amount, cadence, total cap and expiry to the owner. Review expires after five minutes. Do not treat discovering this API as permission to spend.
6. Only after explicit owner authorization, POST /api/agreements/approve with the exact proposal_id and digest. At least 0.011 TAZ spendable is required. Approval enables unattended scheduled payments after the browser closes. The approved plan starts at its recorded anchor; missed periods do not extend it.
7. Poll GET /api/workspace for state and error. POST mutations return 202 queued, not completion. Serialize operations per workspace; 409/503 can mean an operation is still running. Never blindly recreate a payment on timeout: read the workspace and existing invoice first. Payment execution persists and reuses its occurrence/outbox.
8. GET /api/billing and GET /api/billing/invoices/{invoice_id} return signed records. A txid means submission, not verified payment. payment_state=paid requires supplier verification. POST /api/invoices/{invoice_id}/recheck reobserves settlement; GET /api/invoices/{invoice_id}/resource rechecks payment and service expiry before returning live telemetry.
9. With owner authorization, POST /api/agreements/cancel with {}. Cancellation is permanent for this agreement. Already authorized transactions can still settle. Paid service ends at its original boundary. This release supports one agreement per workspace, including after cancellation.

## HTTP conventions

Base URL: ${origin}. All POST requests require Origin: ${origin}, X-Tandem-Request: 1 and Content-Type: application/json. Supply the current session cookie; cookies are Secure on HTTPS. JSON responses use {ok:true,result:...}, except GET /api/status, which returns the wallet snapshot directly. Errors use {error:"..."}. POST bodies reject extra fields. The server derives ownership; never submit state directories, wallet seeds or arbitrary recipients. Logout is POST /api/logout with {}. Password reset and MFA are not implemented.

## Privacy and trust

Payments are shielded on-chain. The app operator holds workspace wallet and both approval keys and can read hosted business records. Two signatures are not two independent human approvals. Buyer and supplier services are both operated by Tandem in this release. testnet.zec.rocks provides lightwalletd and can observe our network requests. No Nym/Tor integration or encrypted-at-rest custody is claimed. No AI model is needed by the deterministic built-in worker. If an external model reads invoices, its provider becomes another disclosure boundary. Testnet TAZ only; mainnet is disabled.

## MCP

The repository includes eight stdio MCP tools for the separate signer/supplier deployment. They need locally configured execution capabilities and Unix sockets. There is no unauthenticated or public remote MCP endpoint. Use this documented HTTP workflow for the hosted account application.
`;
}
const object = (properties, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const str = { type: "string" },
  hex64 = { type: "string", pattern: "^[a-f0-9]{64}$" },
  hex32 = { type: "string", pattern: "^[a-f0-9]{32}$" };
export function openapi(origin) {
  const paths = {},
    get = (p, id, summary, anonymous = false) =>
      (paths[p] = {
        get: {
          operationId: id,
          summary,
          security: anonymous ? [] : [{ session: [] }],
          responses: {
            200: {
              description: "Successful result",
              content: { "application/json": { schema: { type: "object" } } },
            },
            401: { description: "Sign in required" },
            404: { description: "Record unavailable in this workspace" },
            503: { description: "Workspace operation in progress" },
          },
        },
      });
  const post = (p, id, summary, body, queued = true, anonymous = false) =>
    (paths[p] = {
      post: {
        operationId: id,
        summary,
        security: anonymous ? [] : [{ session: [] }],
        parameters: [
          {
            in: "header",
            name: "Origin",
            required: true,
            schema: { type: "string", const: origin },
          },
          {
            in: "header",
            name: "X-Tandem-Request",
            required: true,
            schema: { type: "string", const: "1" },
          },
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: body } },
        },
        responses: {
          [queued ? "202" : "200"]: {
            description: queued
              ? "Queued. Poll GET /api/workspace; acceptance is not completion."
              : "Successful result",
          },
          400: { description: "Invalid request" },
          401: { description: "Sign in required" },
          403: { description: "Read-only reviewer or invalid origin" },
          409: { description: "Workspace busy or not ready" },
          429: { description: "Rate limited" },
        },
      },
    });
  get("/api/catalog", "listServices", "Connected curated services", true);
  get(
    "/api/catalog/{service_id}",
    "getService",
    "Service price, schedules and operator",
    true,
  );
  get("/session", "getSession", "Session role and identity", true);
  get(
    "/api/workspace",
    "getWorkspace",
    "Owner workspace or read-only recorded review workspace",
  );
  get("/api/status", "getWalletStatus", "Wallet snapshot (unwrapped JSON)");
  get("/api/overview", "getOverview", "Signer overview");
  get("/api/billing", "listInvoices", "Invoices and whole-ledger totals");
  get(
    "/api/billing/invoices/{invoice_id}",
    "getInvoice",
    "Signed invoice and supplier receipt",
  );
  get(
    "/api/invoices/{invoice_id}/resource",
    "accessService",
    "Live telemetry for an unexpired independently verified paid period",
  );
  for (const op of ["register", "login"])
    post(
      "/api/auth/" + op,
      op + "Account",
      op === "register"
        ? "Create a private owner workspace"
        : "Sign in; capture the session cookie",
      object({
        username: { type: "string", minLength: 3, maxLength: 32 },
        password: {
          type: "string",
          maxLength: 128,
          minLength: op === "register" ? 12 : 1,
        },
      }),
      false,
      true,
    );
  for (const [p, id, summary] of [
    [
      "/api/workspace/initialize",
      "initializeWallet",
      "Retry wallet initialization",
    ],
    ["/api/wallet/sync", "syncWallet", "Sync the operating wallet"],
    [
      "/api/payments/run",
      "runDuePayment",
      "Check the current authorized payment period",
    ],
    [
      "/api/agreements/cancel",
      "cancelAgreement",
      "Permanently stop new signing; requires owner authorization",
    ],
  ])
    post(p, id, summary, object({}));
  post(
    "/api/wallet/verify",
    "verifyFunding",
    "Verify exact Noir funding output and memo",
    object({ txid: hex64 }),
  );
  post(
    "/api/agreements/propose",
    "proposeAgreement",
    "Prepare exact terms without authorizing payment",
    object({
      service_id: { type: "string", const: service.id },
      payments: { type: "integer", enum: service.payment_counts },
      interval_secs: {
        type: "integer",
        enum: service.intervals.map((x) => x.seconds),
      },
    }),
  );
  post(
    "/api/agreements/approve",
    "approveAgreement",
    "Enable recurring execution; requires explicit owner authorization",
    object({ proposal_id: hex32, digest: hex64 }),
  );
  post(
    "/api/invoices/{invoice_id}/recheck",
    "recheckReceipt",
    "Reobserve supplier payment",
    object({}),
    false,
  );
  post("/api/logout", "logout", "Invalidate this session", object({}), false);
  for (const [p, item] of Object.entries(paths)) {
    if (p.includes("{invoice_id}"))
      item.parameters = [
        { in: "path", name: "invoice_id", required: true, schema: hex64 },
      ];
    if (p.includes("{service_id}"))
      item.parameters = [
        { in: "path", name: "service_id", required: true, schema: str },
      ];
  }
  paths["/api/billing"].get.parameters = [
    {
      in: "query",
      name: "before",
      schema: { type: "integer", minimum: 1 },
      description:
        "Cursor returned as next_cursor; totals still cover all invoices",
    },
  ];
  attachResponseContracts(paths);
  return {
    openapi: "3.1.1",
    info: {
      title: "Tandem workspace API",
      version: "0.1.0",
      description:
        description +
        " Read-only reviewer credentials cannot authorize actions. Read /agents.md for workflow and trust boundaries.",
    },
    servers: [{ url: origin }],
    components: {
      schemas,
      securitySchemes: {
        session: { type: "apiKey", in: "cookie", name: "tandem_session" },
      },
    },
    paths,
  };
}
export function publicDocument(pathname, origin, reviewEnabled) {
  if (
    [
      "/llms.txt",
      "/agents.md",
      "/index.md",
      "/services.md",
      "/services/network-telemetry.md",
    ].includes(pathname)
  )
    return {
      type: "text/markdown; charset=utf-8",
      body: guide(origin, reviewEnabled),
    };
  if (pathname === "/.well-known/tandem.json")
    return {
      type: "application/json",
      body: JSON.stringify(discovery(origin, reviewEnabled)),
    };
  if (pathname === "/openapi.json")
    return { type: "application/json", body: JSON.stringify(openapi(origin)) };
  if (pathname === "/robots.txt")
    return {
      type: "text/plain",
      body: `User-agent: *\nAllow: /\nDisallow: /app\nDisallow: /api/\nAllow: /api/catalog\nSitemap: ${origin}/sitemap.xml\n`,
    };
  if (pathname === "/sitemap.xml")
    return {
      type: "application/xml",
      body: `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${["/", "/services", "/services/network-telemetry", "/agents"].map((p) => `<url><loc>${origin + p}</loc></url>`).join("")}</urlset>`,
    };
}
const esc = (s) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
export function pageMetadata(html, pathname, origin) {
  const privatePage = pathname.startsWith("/app");
  const titles = {
    "/": "Tandem - Private payments. On your terms.",
    "/agents": "For agents | Tandem",
    "/services": "Services | Tandem",
    "/services/network-telemetry": "Network Telemetry | Tandem",
    "/app": "Overview | Tandem",
    "/app/services": "Services | Tandem",
    "/app/agreements": "Agreements | Tandem",
    "/app/wallet": "Wallet | Tandem",
    "/app/invoices": "Invoices | Tandem",
  };
  const title = titles[pathname] || "Tandem";
  const canonical = origin + pathname,
    markdown =
      pathname === "/"
        ? "/index.md"
        : pathname.startsWith("/services")
          ? pathname + ".md"
          : "/agents.md";
  const ld = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Tandem",
    description,
    url: origin,
    applicationCategory: "FinanceApplication",
    operatingSystem: "Web",
    featureList: [
      "NU7 shielded payments",
      "Recurring supplier agreements",
      "Signed invoices and verified receipts",
      "Read-only review workspace",
    ],
  });
  const hash = createHash("sha256").update(ld).digest("base64");
  html = html
    .replace(/<title>.*?<\/title>/s, `<title>${title}</title>`)
    .replace(/<meta\s+name="description"[^>]*>/g, "");
  const tags = `<meta name="description" content="${esc(description)}"><meta name="robots" content="${privatePage ? "noindex,nofollow" : "index,follow"}"><link rel="canonical" href="${esc(canonical)}"><link rel="describedby" href="/llms.txt"><link rel="alternate" type="text/markdown" href="${markdown}"><link rel="service-desc" type="application/vnd.oai.openapi+json" href="/openapi.json"><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="icon" sizes="any" href="/favicon.ico"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><meta name="theme-color" content="#f8f7f3"><meta property="og:title" content="${title}"><meta property="og:description" content="${esc(description)}"><meta property="og:type" content="website"><meta property="og:url" content="${esc(canonical)}"><meta property="og:image" content="${esc(origin)}/og-tandem.png"><meta property="og:image:alt" content="Tandem. Private payments. On your terms. Cobalt sculptural enclosure on warm paper."><meta property="og:site_name" content="Tandem"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${title}"><meta name="twitter:description" content="${esc(description)}"><meta name="twitter:image" content="${esc(origin)}/og-tandem.png"><script type="application/ld+json">${ld}</script>`;
  html = html.replace("</head>", tags + "</head>");
  if (!privatePage)
    html = html.replace(
      "</body>",
      `<noscript><main><h1>${title}</h1><p>${esc(description)}</p><p>Discover Network Telemetry, create a private workspace, fund with Noir, review exact terms, authorize recurring payments, and inspect verified invoices. Testnet TAZ only; workspace keys are managed by Tandem.</p><nav><a href="/services">Services</a> <a href="/app">Open workspace</a> <a href="/agents.md">Agent instructions</a> <a href="/api/catalog">Service catalog JSON</a></nav></main></noscript></body>`,
    );
  return { html, hash };
}
