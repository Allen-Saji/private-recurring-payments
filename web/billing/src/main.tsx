import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { BillingList, InvoiceDetail, InvoiceRow } from "./types";
import { amount, csvCell, date, download, shortId, stateLabel } from "./format";
import "./style.css";
import { WorkspaceApp, useWorkspace } from "../../shared/workspace";

async function request<T>(
  route: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(route, {
    credentials: "same-origin",
    ...options,
  });
  const body = await response.json();
  if (!response.ok || !body.ok)
    throw new Error(body.error || "Billing service unavailable");
  return body.result;
}
const write = {
  method: "POST",
  headers: { "X-Tandem-Request": "1", "Content-Type": "application/json" },
  body: "{}",
};
function Status({ state }: { state: string }) {
  return (
    <span className={`status ${state}`}>
      <span />
      {stateLabel(state)}
    </span>
  );
}
function App() {
  const { workspace, readOnly } = useWorkspace();
  const [data, setData] = useState<BillingList | null>(null),
    [rows, setRows] = useState<InvoiceRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null),
    [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [filter, setFilter] = useState("all"),
    [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false),
    [checking, setChecking] = useState(false),
    [detailBusy, setDetailBusy] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [detailError, setDetailError] = useState("");
  const detailGeneration = useRef(0);
  async function load(append = false) {
    const page = await request<BillingList>(
      "/api/billing" +
        (append && data?.next_cursor ? `?before=${data.next_cursor}` : ""),
    );
    setData(page);
    setRows((old) =>
      append
        ? [
            ...old,
            ...page.invoices.filter(
              (i) => !old.some((x) => x.invoice_id === i.invoice_id),
            ),
          ]
        : page.invoices,
    );
    setSelected((old) => old || page.invoices[0]?.invoice_id || null);
  }
  useEffect(() => {
    if (!["queued", "running"].includes(workspace.state))
      load().catch((e) => setError(e.message));
  }, [workspace.state, workspace.updatedAt]);
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      await load();
      if (selected) await loadDetail(selected);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function loadDetail(id: string) {
    const generation = ++detailGeneration.current;
    setDetailBusy(true);
    setDetailError("");
    try {
      const d = await request<InvoiceDetail>(`/api/billing/invoices/${id}`);
      if (generation === detailGeneration.current) setDetail(d);
    } catch (e) {
      if (generation === detailGeneration.current) {
        setDetail(null);
        setDetailError((e as Error).message);
      }
    } finally {
      if (generation === detailGeneration.current) setDetailBusy(false);
    }
  }
  useEffect(() => {
    if (selected) {
      setDetail(null);
      setNotice("");
      void loadDetail(selected);
    }
  }, [selected]);
  async function recheck() {
    if (!selected) return;
    setChecking(true);
    setNotice("");
    try {
      await request(`/api/invoices/${selected}/recheck`, write);
      setNotice("Payment receipt verified.");
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      await refresh();
      setChecking(false);
    }
  }
  function exportCsv() {
    const fields = [
      "invoice_number",
      "period_id",
      "issued_at_utc",
      "service_from_utc",
      "service_until_utc",
      "amount_zatoshis",
      "amount_taz",
      "payment_state",
      "collection_state",
      "txid",
    ];
    const records = rows.map((i) => [
      i.invoice_number,
      i.period_id,
      date(i.issued_at, true),
      date(i.service_from, true),
      date(i.service_until, true),
      i.amount_zatoshis,
      amount(i.amount_zatoshis),
      i.payment_state,
      i.collection_state,
      i.txid,
    ]);
    download(
      "billing-ledger.csv",
      [fields, ...records].map((r) => r.map(csvCell).join(",")).join("\r\n"),
      "text/csv;charset=utf-8",
    );
  }
  const visible = rows.filter(
    (i) =>
      (filter === "all" || i.payment_state === filter) &&
      `${i.invoice_number} ${i.invoice_id} ${i.period_id}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <div className="workspace t-enter">
      <main>
        <section className="billing-heading no-print">
          <p className="t-eyebrow">YOUR BILLING RECORDS</p>
          <h1 className="t-title">
            Invoices &amp; <em>receipts.</em>
          </h1>
          <p className="t-subtitle">
            Review charges, payment status, and signed records for your
            workspace.
          </p>
        </section>
        <>
          <section className="summary no-print" aria-label="Billing summary">
            <div>
              <p>Total invoiced</p>
              <strong>
                {data ? amount(data.totals.billed_zatoshis, true) : "--"}{" "}
                <small>TAZ</small>
              </strong>
              <span>{data?.totals.invoice_count ?? 0} recorded invoices</span>
            </div>
            <div>
              <p>Paid</p>
              <strong>
                {data ? amount(data.totals.paid_zatoshis, true) : "--"}{" "}
                <small>TAZ</small>
              </strong>
              <span>
                {data?.totals.paid_count ?? 0} supplier-verified receipts
              </span>
            </div>
            <div>
              <p>Awaiting verification</p>
              <strong>
                {data ? amount(data.totals.pending_zatoshis, true) : "--"}{" "}
                <small>TAZ</small>
              </strong>
              <span>{data?.totals.pending_count ?? 0} pending records</span>
            </div>
            <div>
              <p>Unpaid</p>
              <strong>
                {data ? amount(data.totals.unpaid_zatoshis, true) : "--"}{" "}
                <small>TAZ</small>
              </strong>
              <span>
                {data?.totals.unpaid_count ?? 0} without a verified receipt
              </span>
            </div>
          </section>
          {data?.agreement && (
            <section className="agreement-strip no-print">
              <div className="agreement-icon" aria-hidden="true">
                =
              </div>
              <div>
                <span className="eyebrow">RECURRING AGREEMENT</span>
                <h2>{data.agreement.agreement_id}</h2>
                <p>
                  {amount(data.agreement.amount_zatoshis, true)} TAZ /{" "}
                  {data.agreement.schedule.kind === "calendar_month"
                    ? "calendar month"
                    : `${(data.agreement.schedule.interval_secs || 0) / 60} minutes`}
                  <span> / </span>
                  {data.agreement.buyer_company_id}
                </p>
              </div>
              <div className="agreement-state">
                <span
                  className={
                    data.agreement.revoked
                      ? "collection-stopped"
                      : "collection-open"
                  }
                >
                  {data.agreement.revoked
                    ? "Collection stopped"
                    : "Collection enabled"}
                </span>
                <p>
                  {data.agreement.revoked
                    ? "Cancellation preserves paid history."
                    : "Every period follows the approved terms."}
                </p>
              </div>
            </section>
          )}
          <div className="billing-layout">
            <section className="ledger no-print" aria-label="Invoice ledger">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">THE BILLING RECORD</p>
                  <h2>
                    Invoices <span>{data?.totals.invoice_count ?? 0}</span>
                  </h2>
                </div>
                <button
                  className="text-button"
                  onClick={refresh}
                  disabled={busy || checking}
                >
                  {busy ? "Refreshing..." : "Refresh records"}
                </button>
              </div>
              <div className="filters">
                <div className="tabs" aria-label="Payment status filter">
                  {[
                    ["all", "All"],
                    ["paid", "Paid"],
                    ["verification_pending", "Pending"],
                    ["unpaid", "Unpaid"],
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      aria-pressed={filter === value}
                      className={filter === value ? "active" : ""}
                      onClick={() => setFilter(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <label className="search">
                  <span className="sr-only">Search loaded invoices</span>
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Find an invoice"
                    type="search"
                  />
                </label>
              </div>
              <div className="invoice-list">
                <div className="list-labels">
                  <span>Invoice / service period</span>
                  <span>Amount / status</span>
                </div>
                {visible.map((i) => (
                  <button
                    key={i.invoice_id}
                    className={`invoice-row ${selected === i.invoice_id ? "selected" : ""}`}
                    onClick={() => setSelected(i.invoice_id)}
                    aria-pressed={selected === i.invoice_id}
                  >
                    <span>
                      <strong>{i.invoice_number}</strong>
                      <small>{date(i.service_from, true)} UTC</small>
                      <span className="row-sub">
                        {i.period_id.replace("interval:", "Period ")}
                        <span> / </span>
                        {i.collection_state === "stopped"
                          ? "Collection stopped"
                          : i.collection_state === "window_closed"
                            ? "Payment window closed"
                            : "Payment window open"}
                      </span>
                    </span>
                    <span className="row-amount">
                      <strong>
                        {amount(i.amount_zatoshis, true)} <small>TAZ</small>
                      </strong>
                      <Status state={i.payment_state} />
                    </span>
                  </button>
                ))}
                {!visible.length && (
                  <div className="empty">
                    <h3>
                      {rows.length
                        ? "No matching invoices"
                        : "Your invoices will appear here"}
                    </h3>
                    <p>
                      {rows.length
                        ? "Try another number or payment status."
                        : "Create an agreement to start receiving supplier invoices."}
                    </p>
                  </div>
                )}
              </div>
              <div className="ledger-footer">
                <span>
                  Showing {visible.length} of {data?.totals.invoice_count ?? 0}
                </span>
                <button
                  className="text-button"
                  onClick={exportCsv}
                  disabled={!rows.length}
                >
                  Export loaded CSV
                </button>
              </div>
              {data?.next_cursor && (
                <button
                  className="secondary wide"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await load(true);
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Load older invoices
                </button>
              )}
              <aside className="privacy-note">
                <span className="eyebrow">WHAT STAYS PRIVATE</span>
                <p>
                  Names, invoice items, and billing records stay off-chain. A
                  shielded memo binds each payment to its signed request.
                </p>
                <p>
                  These records are visible to the parties and their operators.
                  The network provider can still observe connection metadata.
                </p>
              </aside>
            </section>
            <section
              className="document-panel"
              aria-label="Selected invoice"
              aria-busy={detailBusy}
            >
              {detailBusy ? (
                <div className="loading">Opening invoice...</div>
              ) : detail ? (
                <InvoiceSheet
                  detail={detail}
                  checking={checking}
                  recheck={recheck}
                />
              ) : (
                <div className="empty">
                  <h2>
                    {detailError ? "Invoice unavailable" : "Choose an invoice"}
                  </h2>
                  <p>
                    {detailError ||
                      "Its signed terms and payment record will open here."}
                  </p>
                </div>
              )}
              {notice && (
                <p className="notice no-print" role="status">
                  {notice}
                </p>
              )}
            </section>
          </div>
          <p className="observation-note no-print">
            Last updated {data ? `${date(data.as_of, true)} UTC` : "--"}.{" "}
            {readOnly
              ? "Receipt observations in the review workspace are historical."
              : "Recheck receipt to verify a payment against the network."}
          </p>
        </>
        {error && (
          <p className="error no-print" role="alert">
            {error}
            <button onClick={refresh} className="text-button">
              Try again
            </button>
          </p>
        )}
      </main>
    </div>
  );
}
function InvoiceSheet({
  detail,
  checking,
  recheck,
}: {
  detail: InvoiceDetail;
  checking: boolean;
  recheck: () => void;
}) {
  const { readOnly } = useWorkspace();
  const i = detail.issued.envelope.payload,
    d = detail.billing_document?.payload,
    r = detail.receipt;
  return (
    <article className="invoice-sheet">
      <div className="document-tools no-print">
        <span>
          {detail.document_signature_verified
            ? "SUPPLIER SIGNATURE VERIFIED"
            : "ORIGINAL REQUEST VERIFIED"}
        </span>
        <button
          className="text-button"
          onClick={() =>
            download(
              `${detail.invoice_number}.json`,
              JSON.stringify(detail, null, 2),
              "application/json",
            )
          }
        >
          Export signed JSON
        </button>
        <button
          className="text-button"
          onClick={() => window.print()}
          aria-label="Download selected invoice as PDF"
        >
          Download PDF
        </button>
      </div>
      <div className="sheet-inner">
        <header className="sheet-heading">
          <div>
            <span className="eyebrow">PAYMENT INVOICE</span>
            <h2>{detail.invoice_number}</h2>
          </div>
          <Status state={detail.payment_state} />
        </header>
        <div className="parties">
          <div>
            <span className="eyebrow">FROM</span>
            <h3>Network telemetry</h3>
            <p>Supplier identity</p>
            <code
              title={
                d?.supplier_key || detail.issued.envelope.signatures[0]?.key
              }
            >
              {shortId(
                d?.supplier_key ||
                  detail.issued.envelope.signatures[0]?.key ||
                  "",
              )}
            </code>
          </div>
          <div>
            <span className="eyebrow">BILL TO</span>
            <h3>{d?.buyer_company_id || i.context.company_id}</h3>
            <p>Agreement</p>
            <code>{i.agreement_id}</code>
          </div>
        </div>
        <dl className="dates">
          <div>
            <dt>Payment request issued</dt>
            <dd>{date(i.issued_at, true)} UTC</dd>
          </div>
          <div>
            <dt>Payable before</dt>
            <dd>{date(i.expires_at, true)} UTC</dd>
          </div>
          <div>
            <dt>Service period</dt>
            <dd>
              {date(detail.issued.period_start, true)}
              <br />
              to {date(detail.issued.service_until, true)} UTC
            </dd>
          </div>
          <div>
            <dt>Billing record issued</dt>
            <dd>
              {d ? `${date(d.document_created_at, true)} UTC` : "Not issued"}
            </dd>
          </div>
        </dl>
        <table className="line-items">
          <thead>
            <tr>
              <th>Item</th>
              <th>Qty</th>
              <th>Amount</th>
            </tr>
          </thead>
          <tbody>
            {(
              d?.line_items || [
                {
                  description: `Recurring service / ${i.period_id}`,
                  quantity: 1,
                  unit_amount_zatoshis: i.amount_zatoshis,
                },
              ]
            ).map((item, n) => (
              <tr key={n}>
                <td>{item.description}</td>
                <td>{item.quantity}</td>
                <td>
                  {amount(
                    (
                      BigInt(item.unit_amount_zatoshis) * BigInt(item.quantity)
                    ).toString(),
                    true,
                  )}{" "}
                  TAZ
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="invoice-total">
          <div>
            <p>Total</p>
            <span>Tax not calculated</span>
          </div>
          <strong>
            {amount(i.amount_zatoshis, true)} <small>TAZ</small>
          </strong>
        </div>
        <section className="receipt">
          <div className="receipt-heading">
            <span className="eyebrow">
              {r ? "PAYMENT RECEIPT" : "PAYMENT STATUS"}
            </span>
            {!readOnly && (r || detail.payment_candidate) && (
              <button
                className="text-button no-print"
                onClick={recheck}
                disabled={checking || readOnly}
              >
                {checking ? "Verifying..." : "Recheck receipt"}
              </button>
            )}
          </div>
          {r ? (
            <>
              <h3>
                {detail.payment_state === "paid"
                  ? "Received in shielded TAZ"
                  : "Receipt requires verification"}
              </h3>
              <dl>
                <div>
                  <dt>Amount received</dt>
                  <dd>{amount(r.amount_zatoshis, true)} TAZ</dd>
                </div>
                <div>
                  <dt>Recorded confirmations</dt>
                  <dd>
                    {r.confirmations} at block{" "}
                    {r.verified_tip.toLocaleString("en-US")}
                  </dd>
                </div>
                <div>
                  <dt>Last observation</dt>
                  <dd>{date(r.observed_at, true)} UTC</dd>
                </div>
                <div>
                  <dt>Transaction</dt>
                  <dd>
                    <a
                      href={`https://testnet.zcashexplorer.app/transactions/${r.txid}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {shortId(r.txid)} <span aria-hidden="true">&gt;</span>
                    </a>
                  </dd>
                </div>
              </dl>
              <p>
                Receipt matched by the supplier's wallet to this invoice's exact
                amount and memo.
              </p>
            </>
          ) : (
            <>
              <h3>No verified receipt yet</h3>
              <p>
                {detail.collection_state === "stopped"
                  ? "The company stopped collection. Previously authorized payments may still settle."
                  : detail.collection_state === "window_closed"
                    ? "This payment window has closed. It cannot be retried as a new invoice for the same period."
                    : "The invoice is waiting for payment and independent supplier verification."}
              </p>
            </>
          )}
        </section>
        <ServiceAccess
          key={i.invoice_id}
          invoiceId={i.invoice_id}
          until={detail.issued.service_until}
          paid={detail.payment_state === "paid"}
        />
        <details className="binding no-print">
          <summary>Inspect the authorization binding</summary>
          <dl>
            <dt>Signed payment request</dt>
            <dd>{i.invoice_id}</dd>
            <dt>Approved agreement digest</dt>
            <dd>{i.agreement_digest}</dd>
            <dt>Shielded memo binding</dt>
            <dd>{detail.issued.payment_memo}</dd>
          </dl>
          <p>
            {d
              ? "The billing signature covers the items, total, dates and original signed request."
              : "This older invoice retains its original signed request. No billing-document signature is implied."}
          </p>
        </details>
        <footer className="document-footer">
          <p>Network fees are separate from the service charge shown here.</p>
          <p>
            Testnet billing record. Service access ends at the original period
            boundary, even when an agreement is cancelled.
          </p>
          <p>
            Supplier-signed billing details do not expand the company's approved
            payment authority.
          </p>
        </footer>
      </div>
    </article>
  );
}
function ServiceAccess({
  invoiceId,
  until,
  paid,
}: {
  invoiceId: string;
  until: number;
  paid: boolean;
}) {
  const [data, setData] = useState<{
    height: number;
    consensus_branch: string;
    latest_block_time: number;
    observed_at: number;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const expired = Date.now() / 1000 >= until;
  async function load() {
    setBusy(true);
    setError("");
    try {
      const result = await request<{ data: NonNullable<typeof data> }>(
        `/api/invoices/${invoiceId}/resource`,
      );
      setData(result.data);
    } catch (e) {
      setData(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="receipt no-print">
      <div className="receipt-heading">
        <span className="eyebrow">YOUR SERVICE</span>
        <button
          className="text-button"
          disabled={busy || !paid || expired}
          onClick={load}
        >
          {busy ? "Checking access..." : "Open network feed"}
        </button>
      </div>
      <p>
        {expired
          ? "This service period has ended. Your invoice and receipt remain available."
          : paid
            ? "Your paid period includes access to live NU7 network telemetry."
            : "The feed becomes available after the supplier verifies payment."}
      </p>
      {data && (
        <dl>
          <div>
            <dt>Network height</dt>
            <dd>{data.height.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Consensus branch</dt>
            <dd>{data.consensus_branch}</dd>
          </div>
          <div>
            <dt>Observed</dt>
            <dd>{date(data.observed_at, true)} UTC</dd>
          </div>
        </dl>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
createRoot(document.getElementById("root")!).render(
  <WorkspaceApp page="invoices">
    <App />
  </WorkspaceApp>,
);
