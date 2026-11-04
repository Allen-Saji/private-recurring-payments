import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceApp, useWorkspace } from "../../shared/workspace";
import { amount, date, shortId } from "../../billing/src/format";
function Agreements() {
  const { workspace, action, readOnly } = useWorkspace();
  function savedChoice(key: string, fallback: number, allowed: number[]) {
    try {
      const value = JSON.parse(
        sessionStorage.getItem("tandem:plan:" + workspace.id) || "{}",
      )[key];
      return allowed.includes(value) ? value : fallback;
    } catch {
      return fallback;
    }
  }
  const [payments, setPayments] = useState(() =>
      savedChoice("payments", 3, [1, 2, 3]),
    ),
    [interval, setInterval] = useState(() =>
      savedChoice("interval", 600, [600, 3600, 86400]),
    ),
    [accepted, setAccepted] = useState(false),
    [cancelling, setCancelling] = useState(false),
    [error, setError] = useState("");
  const snapshot = workspace.snapshot,
    current = snapshot?.overview?.agreements?.[0],
    a = current?.envelope?.payload;
  const candidate = workspace.job_result?.proposal_id
    ? workspace.job_result
    : null;
  const proposal =
    candidate &&
    candidate.terms.schedule.interval_secs === interval &&
    candidate.terms.expires_at - candidate.terms.valid_from ===
      payments * interval
      ? candidate
      : null;
  const busy = ["queued", "running"].includes(workspace.state);
  const available = BigInt(
    snapshot?.operating?.ironwoodSpendableZatoshis || "0",
  );
  useEffect(() => setAccepted(false), [proposal?.proposal_id]);
  useEffect(() => {
    if (!readOnly)
      sessionStorage.setItem(
        "tandem:plan:" + workspace.id,
        JSON.stringify({ payments, interval }),
      );
  }, [payments, interval, workspace.id, readOnly]);
  const run = async (url: string, body: unknown = {}) => {
    setError("");
    try {
      await action(url, body);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const cadence = (n: number) =>
    n === 600 ? "Every 10 minutes" : n === 3600 ? "Every hour" : "Every day";
  return (
    <main className="t-main t-enter">
      <p className="t-eyebrow">YOUR AGREEMENTS</p>
      <h1 className="t-title">
        Approved once.
        <br />
        <em>Checked every time.</em>
      </h1>
      <p className="t-subtitle">
        Set a spending limit and a schedule. Your workspace checks each invoice
        before a payment is signed.
      </p>
      {!a && (
        <>
          <a className="t-muted-link" href="/services/network-telemetry">
            Network Telemetry / service details
          </a>
          <div className="t-setup-steps">
            <span>
              <b>01</b>Choose your schedule
            </span>
            <span>
              <b>02</b>Fund your wallet
            </span>
            <span>
              <b>03</b>Review &amp; authorize
            </span>
          </div>
        </>
      )}
      {readOnly && (
        <p className="t-route-note">
          This is a recorded agreement from the verified testnet run. Explore
          its invoice history, or{" "}
          <a href="/app?create">create your own workspace</a> to set up a new
          subscription.
        </p>
      )}
      {a ? (
        <>
          <span className="t-tag">
            {current.revoked
              ? "Cancelled"
              : Date.now() / 1000 >= a.expires_at
                ? "Ended"
                : "Authorized"}
          </span>
          <div className="t-stats">
            <div>
              <span>Per invoice</span>
              <strong>
                {amount(a.amount_zatoshis, true)} <small>TAZ</small>
              </strong>
            </div>
            <div>
              <span>Total spending limit, including fees</span>
              <strong>
                {amount(a.lifetime_limit_zatoshis, true)} <small>TAZ</small>
              </strong>
            </div>
            <div>
              <span>Remaining allowance</span>
              <strong>
                {amount(current.remaining_allowance_zatoshis, true)}{" "}
                <small>TAZ</small>
              </strong>
            </div>
          </div>
          <div className="t-grid">
            <section className="t-panel">
              <div className="t-service">
                <span aria-hidden="true">~</span>
                <div>
                  <h2>Network telemetry</h2>
                  <p>Live Zcash network data</p>
                </div>
              </div>
              <dl className="t-terms">
                <div>
                  <dt>Schedule</dt>
                  <dd>{cadence(a.schedule.interval_secs)}</dd>
                </div>
                <div>
                  <dt>Ends</dt>
                  <dd>{date(a.expires_at, true)} UTC</dd>
                </div>
                <div>
                  <dt>Maximum fee per payment</dt>
                  <dd>{amount(a.max_fee_zatoshis, true)} TAZ</dd>
                </div>
              </dl>
              <p>
                Each paid period unlocks the supplier's network feed. Invoices
                and received payments stay in your history after cancellation.
              </p>
              <a className="t-muted-link" href="/app/invoices">
                View invoices and receipts
              </a>
            </section>
            <section className="t-panel">
              <h2>Payment activity</h2>
              <p>
                {busy
                  ? "Your workspace is processing an operation."
                  : "The payment worker checks for due invoices automatically."}
              </p>
              {snapshot.overview.payments.length ? (
                <dl className="t-terms">
                  {snapshot.overview.payments.slice(0, 5).map((p: any) => (
                    <div key={p.payment_id}>
                      <dt>{p.period_id.replace("interval:", "Period ")}</dt>
                      <dd>
                        {p.state === "confirmed"
                          ? "Confirmed"
                          : p.state === "broadcast_unknown"
                            ? "Submitted"
                            : p.state.replaceAll("_", " ")}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p>
                  Your first invoice will appear when its payment window opens.
                </p>
              )}
              {!readOnly && !current.revoked && (
                <div className="t-actions">
                  <button
                    className="t-button outline"
                    disabled={busy}
                    onClick={() => run("/api/payments/run")}
                  >
                    Check due payment
                  </button>
                  <button
                    className="t-link-button"
                    onClick={() => setCancelling(!cancelling)}
                  >
                    Stop future payments
                  </button>
                </div>
              )}
              {cancelling && !readOnly && !current.revoked && (
                <div className="t-notice">
                  <p>
                    Cancellation stops new authorizations. Payments already
                    authorized may still settle. This agreement cannot be
                    reactivated.
                  </p>
                  <button
                    className="t-button outline"
                    disabled={busy}
                    onClick={() => run("/api/agreements/cancel")}
                  >
                    Confirm cancellation
                  </button>
                </div>
              )}
              <details className="t-details">
                <summary>Agreement identity</summary>
                <p>{a.agreement_id}</p>
                <p>Supplier key: {shortId(a.supplier_key)}</p>
              </details>
            </section>
          </div>
        </>
      ) : (
        <div className="t-grid">
          <section className="t-panel t-enter">
            <div className="t-service">
              <span aria-hidden="true">~</span>
              <div>
                <h2>Network telemetry</h2>
                <p>Live Zcash network data</p>
              </div>
            </div>
            <p>
              A recurring feed of chain height, consensus version, and block
              timestamps. Each invoice costs 0.01 TAZ.
            </p>
            <div className="t-field">
              <label htmlFor="schedule">Payment schedule</label>
              <select
                id="schedule"
                value={interval}
                onChange={(e) => setInterval(Number(e.target.value))}
              >
                <option value={600}>Every 10 minutes</option>
                <option value={3600}>Every hour</option>
                <option value={86400}>Every day</option>
              </select>
            </div>
            <div className="t-field">
              <label htmlFor="payments">Number of payments</label>
              <select
                id="payments"
                value={payments}
                onChange={(e) => setPayments(Number(e.target.value))}
              >
                {[1, 2, 3].map((n) => (
                  <option key={n} value={n}>
                    {n} {n === 1 ? "payment" : "payments"}
                  </option>
                ))}
              </select>
            </div>
            <p className="t-plan-total">
              <span>Maximum total with fees</span>
              <strong>
                {amount((BigInt(payments) * 1100000n).toString(), true)} TAZ
              </strong>
            </p>
            {available < 1100000n && (
              <p className="t-route-note">
                Your wallet needs at least 0.011 TAZ before you can authorize.{" "}
                <a href="/app/wallet">Fund with Noir</a>, then return to this
                review. Your schedule selection is saved in this tab.
              </p>
            )}
            <button
              className="t-button"
              disabled={busy}
              onClick={() =>
                run("/api/agreements/propose", {
                  service_id: "network-telemetry",
                  payments,
                  interval_secs: interval,
                })
              }
            >
              {busy ? "Preparing..." : "Review agreement"}
            </button>
          </section>
          <section className="t-panel t-enter">
            <h2>
              {proposal
                ? "Review your authorization"
                : "A clear spending boundary"}
            </h2>
            {proposal ? (
              <>
                <dl className="t-terms">
                  <div>
                    <dt>Amount per invoice</dt>
                    <dd>0.01 TAZ</dd>
                  </div>
                  <div>
                    <dt>Schedule</dt>
                    <dd>{cadence(proposal.terms.schedule.interval_secs)}</dd>
                  </div>
                  <div>
                    <dt>Maximum total, including fees</dt>
                    <dd>
                      {amount(proposal.terms.lifetime_limit_zatoshis, true)} TAZ
                    </dd>
                  </div>
                  <div>
                    <dt>Agreement ends</dt>
                    <dd>{date(proposal.terms.expires_at, true)} UTC</dd>
                  </div>
                </dl>
                <p>
                  Approval enables automatic payments after you leave this page.
                  The signer enforces the amount, recipient, schedule, and total
                  limit.
                </p>
                <details className="t-details">
                  <summary>Supplier identity and payment destination</summary>
                  <p className="t-code">{proposal.terms.recipient}</p>
                  <p className="t-code">
                    Supplier signing key: {proposal.terms.supplier_key}
                  </p>
                  <p className="t-code">Agreement digest: {proposal.digest}</p>
                </details>
                <label className="t-check">
                  <input
                    type="checkbox"
                    checked={accepted}
                    onChange={(e) => setAccepted(e.target.checked)}
                  />
                  I authorize these recurring testnet payments within the
                  displayed limits.
                </label>
                {available < 1100000n && (
                  <p className="t-notice">
                    Add at least 0.011 TAZ before authorizing.{" "}
                    <a href="/app/wallet">Open your wallet</a>.
                  </p>
                )}
                <button
                  className="t-button"
                  disabled={
                    busy ||
                    !accepted ||
                    available < 1100000n ||
                    Date.now() / 1000 >= proposal.review_expires_at
                  }
                  onClick={() =>
                    run("/api/agreements/approve", {
                      proposal_id: proposal.proposal_id,
                      digest: proposal.digest,
                    })
                  }
                >
                  Authorize payments
                </button>
                <p className="t-route-note">
                  This review expires after five minutes. If it expires, request
                  a new review.
                </p>
              </>
            ) : (
              <>
                <p>
                  Only matching supplier invoices can be paid. A changed
                  recipient or amount is refused, and a retry cannot create a
                  second payment for the same period.
                </p>
                <p>
                  The fee allowance is 0.001 TAZ per payment. Unused allowance
                  stays reserved; it does not raise the invoice amount.
                </p>
                <a className="t-muted-link" href="/app/wallet">
                  Fund your workspace
                </a>
              </>
            )}
          </section>
        </div>
      )}
      {(error || workspace.error) && (
        <p className="t-error" role="alert">
          {error || workspace.error}
        </p>
      )}
      <p className="t-route-note">
        This release supports one network-telemetry agreement per workspace.
        Workspace signing and authorization keys are managed by the service. Use
        testnet TAZ only.
      </p>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <WorkspaceApp page="agreements">
    <Agreements />
  </WorkspaceApp>,
);
