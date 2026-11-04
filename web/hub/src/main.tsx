import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceApp, useWorkspace, Mark, api } from "../../shared/workspace";
import catalog from "../../../shared/catalog.json";
import { amount, date } from "../../billing/src/format";
import "../../shared/product.css";
const service = catalog.services[0];
function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-public">
      <header className="t-header">
        <a className="t-brand" href="/" aria-label="Tandem home">
          <Mark />
          <span>
            tandem<i>.</i>
          </span>
        </a>
        <nav className="t-nav" aria-label="Main navigation">
          <a href="/services">Services</a>
          <a href="/agents">For agents</a>
          <a href="/#privacy">Privacy</a>
        </nav>
        <div className="t-meta">
          <span className="t-network">NU7 testnet</span>
          <a className="t-button outline" href="/app">
            Open workspace
          </a>
        </div>
      </header>
      {children}
      <footer className="t-footer">
        <span>Private payments. On your terms.</span>
        <a href="/agents">For agents</a>
        <a href="/#privacy">Privacy &amp; trust</a>
      </footer>
    </div>
  );
}
function SupplierSymbol() {
  return (
    <div className="h-service-symbol" aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}
function ServiceCard({ inWorkspace = false }: { inWorkspace?: boolean }) {
  return (
    <article className="h-service-card">
      <div className="h-service-body">
        <div className="h-provider">
          <SupplierSymbol />
          <span>TANDEM / INFRASTRUCTURE</span>
          <span className="h-available">Connected</span>
        </div>
        <h2>
          Network
          <br />
          <em>Telemetry.</em>
        </h2>
        <p>{service.summary}</p>
        <div className="h-chips">
          <span>NU7 shielded settlement</span>
          <span>Signed invoices</span>
          <span>Receipt-gated access</span>
        </div>
        <a href="/services/network-telemetry" className="t-muted-link">
          View service and payment terms
        </a>
      </div>
      <aside className="h-service-price">
        <p className="t-eyebrow">PER SERVICE PERIOD</p>
        <strong>
          0.01 <small>TAZ</small>
        </strong>
        <p>
          Choose 10 minutes, one hour, or one day. Authorize up to three
          payments.
        </p>
        <dl>
          <div>
            <dt>Maximum network fee</dt>
            <dd>0.001 TAZ / payment</dd>
          </div>
          <div>
            <dt>Supplier</dt>
            <dd>Tandem-operated</dd>
          </div>
        </dl>
        <a className="t-button" href={service.links.subscribe}>
          {inWorkspace ? "Set up subscription" : "Create your workspace"}
        </a>
        <span className="t-route-note">
          Testnet TAZ only. Exact limits before approval.
        </span>
      </aside>
    </article>
  );
}
function Catalog({ inWorkspace = false }: { inWorkspace?: boolean }) {
  return (
    <main className="t-main h-main t-enter">
      <div className="h-heading">
        <div>
          <p className="t-eyebrow">THE SERVICE DIRECTORY</p>
          <h1 className="t-title">
            Find the service.
            <br />
            <em>Set your terms.</em>
          </h1>
        </div>
        <p className="t-subtitle">
          A curated starting point for private supplier payments. Every listed
          service has a connected payment and receipt flow.
        </p>
      </div>
      <div className="h-directory-bar">
        <span>
          All services <b>01</b>
        </span>
        <span>Infrastructure</span>
        <a href="/agents">Agent-readable catalog</a>
      </div>
      <ServiceCard inWorkspace={inWorkspace} />
      <div className="h-bottom-note">
        <h3>Who is on the other side?</h3>
        <p>
          Tandem operates this first reference supplier. You receive a separate
          agreement and invoice record in your workspace. Independent supplier
          integrations will appear here when they are connected and verified.
        </p>
      </div>
    </main>
  );
}
function ServiceDetail() {
  return (
    <main className="t-main h-main t-enter">
      <a className="h-back" href="/services">
        Back to services
      </a>
      <div className="h-detail-top">
        <div>
          <div className="h-provider">
            <SupplierSymbol />
            <span>TANDEM / INFRASTRUCTURE</span>
          </div>
          <h1 className="t-title">
            Network
            <br />
            <em>Telemetry.</em>
          </h1>
          <p className="t-subtitle">
            Pay for an agreed period of network data. Keep the payment details
            shielded and the supplier relationship explicit.
          </p>
          <div className="h-chips">
            <span>Available on NU7 testnet</span>
            <span>Tandem-operated supplier</span>
          </div>
        </div>
        <aside className="h-detail-quote">
          <span className="t-eyebrow">FIXED PER PERIOD</span>
          <strong>
            0.01 <small>TAZ</small>
          </strong>
          <p>Up to 0.001 TAZ network fee per payment.</p>
          <a className="t-button" href={service.links.subscribe}>
            Set up subscription
          </a>
          <a className="t-muted-link" href="/app?review">
            Inspect a settled agreement first
          </a>
        </aside>
      </div>
      <div className="h-detail-grid">
        <section>
          <p className="t-eyebrow">WHAT YOU RECEIVE</p>
          <h2>
            A network observation.
            <br />
            <em>Backed by a receipt.</em>
          </h2>
          <p>{service.description}</p>
          <ul className="h-deliverables">
            {service.delivers.map((item, i) => (
              <li key={item}>
                <span>0{i + 1}</span>
                {item}
              </li>
            ))}
          </ul>
        </section>
        <section>
          <p className="t-eyebrow">HOW THE SUBSCRIPTION WORKS</p>
          <ol className="h-flow">
            <li>
              <b>Choose the schedule</b>
              <p>
                Every 10 minutes, hour or day. Select one to three payments.
              </p>
            </li>
            <li>
              <b>Fund your own workspace</b>
              <p>
                Approve a 0.05 TAZ deposit in Noir. Funding alone does not
                authorize a subscription.
              </p>
            </li>
            <li>
              <b>Review and authorize</b>
              <p>
                See the amount, recipient, supplier key, total cap and expiry.
                Then explicitly enable recurring payments.
              </p>
            </li>
            <li>
              <b>Open your paid service</b>
              <p>
                The worker collects due invoices. After receipt verification,
                open the live feed from your invoice.
              </p>
            </li>
          </ol>
        </section>
      </div>
      <div className="h-terms-strip">
        <div>
          <span>Three-payment maximum</span>
          <strong>0.033 TAZ</strong>
          <small>Includes the full fee allowance</small>
        </div>
        <div>
          <span>Cancellation</span>
          <strong>Stop future signing</strong>
          <small>Existing payments may still settle</small>
        </div>
        <div>
          <span>Data access</span>
          <strong>Original period only</strong>
          <small>A late payment does not extend service</small>
        </div>
      </div>
      <div className="h-bottom-note">
        <h3>Privacy &amp; operation</h3>
        <p>
          Tandem manages the operating wallet and both approval keys in this
          testnet release. The supplier and payment service share an operator.
          Your invoices are private to your account, but visible to that
          operator. No mainnet funds.
        </p>
      </div>
    </main>
  );
}
function Overview() {
  const { workspace, username, readOnly } = useWorkspace();
  const [billing, setBilling] = useState<any>(null);
  useEffect(() => {
    if (!["queued", "running"].includes(workspace.state))
      api("/api/billing")
        .then(setBilling)
        .catch(() => {});
  }, [workspace.updatedAt, workspace.state]);
  const snapshot = workspace.snapshot,
    a = snapshot.overview.agreements[0],
    funded =
      BigInt(snapshot.operating.ironwoodSpendableZatoshis || "0") >= 1100000n;
  const next = readOnly
    ? {
        title: "Start with the signed agreement",
        copy: "Then inspect its two invoices and the independently verified shielded receipts. Receipt observations include their verification time.",
        href: "/app/agreements",
        label: "Inspect agreement",
      }
    : a
      ? {
          title: "Follow your payment",
          copy: "The worker checks due invoices against your approved limits. Open invoices to see submission, verification and service access.",
          href: "/app/invoices",
          label: "Open invoices",
        }
      : funded
        ? {
            title: "Review your first agreement",
            copy: "Your wallet has spendable testnet funds. Choose a schedule and review the exact amount and total before authorizing.",
            href: "/app/agreements?service=network-telemetry",
            label: "Review terms",
          }
        : {
            title: "Discover your first supplier",
            copy: "Start with Network Telemetry. See what it delivers, choose your schedule, then fund and authorize your own agreement.",
            href: "/app/services",
            label: "Explore services",
          };
  return (
    <main className="t-main h-main t-enter">
      <div className="h-heading">
        <div>
          <p className="t-eyebrow">
            {readOnly
              ? "VERIFIED TESTNET WORKSPACE"
              : `${username.toUpperCase()}'S WORKSPACE`}
          </p>
          <h1 className="t-title">
            A clear view.
            <br />
            <em>Of every payment.</em>
          </h1>
        </div>
        <p className="t-subtitle">
          {readOnly
            ? "Explore the complete record: approved terms, settled invoices and their recorded receipts. No wallet or funds required."
            : "Your supplier relationships, spending limits and billing records, together. Each payment starts with terms you approve."}
        </p>
      </div>
      <section className="h-next">
        <div>
          <span className="t-eyebrow">
            {readOnly ? "A GOOD PLACE TO START" : "YOUR NEXT STEP"}
          </span>
          <h2>{next.title}</h2>
          <p>{next.copy}</p>
          <a className="t-button" href={next.href}>
            {next.label}
          </a>
        </div>
        <div className="h-next-art" aria-hidden="true">
          <img src="/sealed-sculpture.png" alt="" />
        </div>
      </section>
      <div className="h-summary">
        <div>
          <span>Agreements</span>
          <strong>
            {snapshot.overview.agreements.length.toString().padStart(2, "0")}
          </strong>
          <small>
            {a?.revoked
              ? "Collection stopped"
              : a
                ? "Approved terms"
                : "Choose a service to begin"}
          </small>
        </div>
        <div>
          <span>Paid invoices</span>
          <strong>
            {billing
              ? String(billing.totals.paid_count).padStart(2, "0")
              : "--"}
          </strong>
          <small>
            {billing
              ? amount(billing.totals.paid_zatoshis, true) + " TAZ received"
              : "Loading billing records"}
          </small>
        </div>
        <div>
          <span>{readOnly ? "Settlement network" : "Spendable balance"}</span>
          <strong>
            {readOnly
              ? "NU7"
              : amount(
                  snapshot.operating.ironwoodSpendableZatoshis || "0",
                  true,
                )}
          </strong>
          <small>
            {readOnly
              ? "Recipient-verified receipts"
              : "TAZ / testnet funds only"}
          </small>
        </div>
      </div>
      <section className="h-journey">
        <div>
          <p className="t-eyebrow">FROM SERVICE TO RECEIPT</p>
          <h2>
            One relationship.
            <br />
            <em>A complete record.</em>
          </h2>
        </div>
        <ol>
          {[
            [
              "01",
              "Find a service",
              "Understand the supplier, price and delivered service.",
              "/app/services",
            ],
            [
              "02",
              "Fund & authorize",
              "Use your own workspace wallet and approve exact limits.",
              "/app/agreements",
            ],
            [
              "03",
              "Receive & verify",
              "Follow numbered invoices to a shielded receipt and paid service.",
              "/app/invoices",
            ],
          ].map(([n, title, copy, href]) => (
            <li key={n}>
              <a href={href}>
                <span>{n}</span>
                <div>
                  <h3>{title}</h3>
                  <p>{copy}</p>
                </div>
                <b aria-hidden="true">&gt;</b>
              </a>
            </li>
          ))}
        </ol>
      </section>
      <div className="h-bottom-note">
        <h3>
          {readOnly ? "Try an agreement of your own" : "Bring your agent"}
        </h3>
        <p>
          {readOnly
            ? "The public review account is read-only. Create your own private workspace to fund a wallet and authorize payments."
            : "Your agent can discover services and read the API contract. Payment authorization stays an explicit owner decision."}
        </p>
        <a className="t-muted-link" href={readOnly ? "/app?create" : "/agents"}>
          {readOnly ? "Create a private workspace" : "Read the agent guide"}
        </a>
      </div>
    </main>
  );
}
function Agents() {
  const [origin] = useState(location.origin),
    [copied, setCopied] = useState(false);
  const command = `curl ${origin}/api/catalog`;
  return (
    <main className="t-main h-main t-enter">
      <div className="h-heading">
        <div>
          <p className="t-eyebrow">FOR AGENTS &amp; DEVELOPERS</p>
          <h1 className="t-title">
            Understand first.
            <br />
            <em>Act within limits.</em>
          </h1>
        </div>
        <p className="t-subtitle">
          Discover the service, inspect exact terms, and read verified receipts.
          The same product flow, with a documented HTTP contract.
        </p>
      </div>
      <div className="h-agent-links">
        <a href="/llms.txt">
          <span>Start here</span>
          <strong>llms.txt</strong>
          <p>Product, workflow and authority boundaries.</p>
        </a>
        <a href="/openapi.json">
          <span>API contract</span>
          <strong>OpenAPI</strong>
          <p>Routes, request bodies and session requirements.</p>
        </a>
        <a href="/.well-known/tandem.json">
          <span>Discovery</span>
          <strong>Capabilities</strong>
          <p>Network, limits, review access and next actions.</p>
        </a>
      </div>
      <section className="h-agent-start">
        <div>
          <p className="t-eyebrow">ONE REQUEST TO START</p>
          <h2>
            Read before
            <br />
            <em>you connect.</em>
          </h2>
          <p>
            No authentication is needed to discover the catalog. Sign in for
            account-specific records. The prefilled judge account only permits
            reads.
          </p>
          <a className="t-muted-link" href="/app?review">
            Open review access
          </a>
        </div>
        <div className="h-code">
          <div>
            <span>GET /api/catalog</span>
            <button
              onClick={() =>
                navigator.clipboard
                  .writeText(command)
                  .then(() => setCopied(true))
              }
            >
              {copied ? "Copied" : "Copy request"}
            </button>
          </div>
          <pre>{command}</pre>
          <p>
            Response: service ID, operator, integer-denominated price,
            schedules, requirements and setup links.
          </p>
        </div>
      </section>
      <ol className="h-agent-flow">
        {[
          [
            "Discover",
            "GET /api/catalog",
            "Read the service and its operator. Use service_id: network-telemetry.",
          ],
          [
            "Authenticate",
            "POST /api/auth/login",
            "Preserve the session cookie. GET /session tells you whether access is owner or read-only reviewer.",
          ],
          [
            "Prepare",
            "POST /api/agreements/propose",
            "Choose 1-3 payments and 600, 3600 or 86400 seconds. Poll the workspace for the exact proposal and digest.",
          ],
          [
            "Authorize",
            "POST /api/agreements/approve",
            "Present the exact terms and get owner authorization first. Approval enables unattended payments.",
          ],
          [
            "Observe",
            "GET /api/billing",
            "A transaction ID is not a receipt. Check payment_state and the independently verified supplier record.",
          ],
        ].map(([title, path, copy], i) => (
          <li key={title}>
            <span>0{i + 1}</span>
            <div>
              <h3>{title}</h3>
              <p>{copy}</p>
            </div>
            <code>{path}</code>
          </li>
        ))}
      </ol>
      <div className="h-detail-grid">
        <section>
          <h2>
            Requests have
            <br />
            <em>clear boundaries.</em>
          </h2>
          <p>
            POST requests need the configured Origin, application/json,
            X-Tandem-Request: 1 and a session cookie. A 202 response means
            queued; poll /api/workspace until the operation completes. Serialize
            requests and inspect saved state after a timeout.
          </p>
          <p>
            Only an owner can authorize or cancel. Public descriptions and
            shared judge credentials confer no spending authority. Never send
            wallet seeds or private keys.
          </p>
        </section>
        <section>
          <h2>
            HTTP for the app.
            <br />
            <em>MCP for operators.</em>
          </h2>
          <p>
            The hosted workspace uses the HTTP contract above. The repository
            also includes eight stdio MCP tools for the separate signer and
            supplier deployment. That adapter requires local execution
            capabilities and Unix sockets.
          </p>
          <p>
            There is no public remote MCP endpoint. The built-in renewal worker
            is deterministic; an external model provider sees any records you
            send it.
          </p>
          <a className="t-muted-link" href="/agents.md">
            Read the full agent instructions
          </a>
        </section>
      </div>
    </main>
  );
}
const path = location.pathname;
const view =
  path === "/app" ? (
    <WorkspaceApp page="overview">
      <Overview />
    </WorkspaceApp>
  ) : path === "/app/services" ? (
    <WorkspaceApp page="services">
      <Catalog inWorkspace />
    </WorkspaceApp>
  ) : (
    <PublicShell>
      {path === "/agents" ? (
        <Agents />
      ) : path === "/services/network-telemetry" ? (
        <ServiceDetail />
      ) : (
        <Catalog />
      )}
    </PublicShell>
  );
createRoot(document.getElementById("root")!).render(view);
