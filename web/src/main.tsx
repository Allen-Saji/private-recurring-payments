import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  getNoirWallet,
  type ZcashConnectResult,
  type ZcashBalanceResult,
} from "@noir-wallet/sdk";
import {
  assertTestnet,
  fundingRequest,
  FUNDING_AMOUNT,
  formatZatoshis,
} from "./policy.mjs";
import "./style.css";
import { WorkspaceApp, useWorkspace } from "../shared/workspace";

type WalletStatus = {
  address: string;
  chainTip?: number;
  scannedHeight?: number;
  totalZatoshis?: string;
  ironwoodSpendableZatoshis?: string;
};
type Receipt = {
  txid: string;
  confirmations: number;
  mined_height: number;
  verified_tip: number;
  pool: string;
};
type Status = {
  network: string;
  fundingReady?: boolean;
  operating: WalletStatus;
  updatedAtUnix: number;
  receipts?: { funding?: Receipt; supplier?: Receipt };
};
function App() {
  const { workspace, action, readOnly } = useWorkspace();
  const [status, setStatus] = useState<Status | null>(null);
  const [account, setAccount] = useState<ZcashConnectResult | null>(null);
  const [balance, setBalance] = useState<ZcashBalanceResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(
    "Connect Noir to fund your workspace wallet.",
  );
  const [error, setError] = useState("");
  const [funding, setFunding] = useState("");
  const [checkedHistory, setCheckedHistory] = useState(false);
  const [recoveryTx, setRecoveryTx] = useState("");
  const inFlight = useRef(false);
  async function refresh() {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok)
      throw new Error("Your wallet is updating. Try again shortly.");
    const next: Status = await response.json();
    if (next.network !== "testnet")
      throw new Error("This wallet must use NU7 testnet.");
    assertTestnet(next.operating.address);
    setStatus(next);
    setFunding(localStorage.getItem(`funding:${next.operating.address}`) || "");
  }
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, [workspace.updatedAt]);
  useEffect(() => {
    function changed(event: StorageEvent) {
      if (status && event.key === `funding:${status.operating.address}`)
        setFunding(event.newValue || "");
    }
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [status]);
  async function connect() {
    setBusy(true);
    setError("");
    try {
      const wallet = getNoirWallet();
      if (!wallet)
        throw new Error(
          "Noir was not detected. Install the testnet extension and reload this page.",
        );
      const accounts =
        (await wallet.zcash.getAccounts()) ?? (await wallet.zcash.connect());
      assertTestnet(accounts.shielded);
      setAccount(accounts);
      setBalance(await wallet.zcash.getBalance());
      setMessage(
        "Connected. Review the destination below before opening Noir.",
      );
    } catch (e) {
      setAccount(null);
      setBalance(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function fund() {
    if (!status?.fundingReady || !account || inFlight.current || funding)
      return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    let requested = false;
    try {
      if (!navigator.locks)
        throw new Error(
          "This browser cannot safely coordinate wallet requests. Use a current Brave version.",
        );
      await navigator.locks.request(
        `funding:${status.operating.address}`,
        { ifAvailable: true },
        async (lock) => {
          if (
            !lock ||
            localStorage.getItem(`funding:${status.operating.address}`)
          )
            throw new Error(
              "A funding request already exists. Check Noir history.",
            );
          const wallet = getNoirWallet();
          if (!wallet) throw new Error("Noir is unavailable.");
          const current = await wallet.zcash.getAccounts();
          if (!current || current.shielded !== account.shielded)
            throw new Error("Your wallet account changed. Connect again.");
          const request = fundingRequest(
            status.operating.address,
            current.shielded,
          );
          localStorage.setItem(
            `funding:${status.operating.address}`,
            "pending",
          );
          setFunding("pending");
          requested = true;
          const txid = await wallet.zcash.sendTransaction({
            ...request,
            fundingSource: "shielded",
          });
          if (!/^[0-9a-f]{64}$/i.test(txid))
            throw new Error(
              "Noir returned an unexpected result. Check its transaction history.",
            );
          localStorage.setItem(`funding:${status.operating.address}`, txid);
          setFunding(txid);
          setMessage(
            "Funding submitted. Your workspace will verify the receipt.",
          );
          await action("/api/wallet/verify", { txid: txid.toLowerCase() });
        },
      );
    } catch (e) {
      setError(
        `${(e as Error).message}${requested ? " Check Noir history before another funding attempt; this request may have been submitted." : ""}`,
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  const primaryBalance = balance?.accounts.find(
    (a) => a.id === account?.accounts[0]?.id,
  );
  const confirmedFunding =
    status?.receipts?.funding?.txid === funding &&
    (status?.receipts?.funding?.confirmations ?? 0) > 0;
  if (readOnly)
    return (
      <main className="t-main t-enter">
        <p className="t-eyebrow">RECORDED WALLET ACTIVITY</p>
        <h1 className="t-title">
          Shielded funding.
          <br />
          <em>A verified receipt.</em>
        </h1>
        <p className="t-subtitle">
          This workspace preserves a real Noir funding receipt and
          recurring-payment records. It cannot receive new deposits through
          review access.
        </p>
        <section className="t-panel">
          <h2>Noir funding / 0.05 TAZ</h2>
          {workspace.snapshot.receipts?.funding ? (
            <>
              <p className="t-code">
                {workspace.snapshot.receipts.funding.txid}
              </p>
              <dl className="t-terms">
                <div>
                  <dt>Mined height</dt>
                  <dd>{workspace.snapshot.receipts.funding.mined_height}</dd>
                </div>
                <div>
                  <dt>Recorded confirmations</dt>
                  <dd>{workspace.snapshot.receipts.funding.confirmations}</dd>
                </div>
                <div>
                  <dt>Received pool</dt>
                  <dd>Ironwood / NU7 testnet</dd>
                </div>
              </dl>
              <p>
                The receiving wallet decrypted the exact amount and funding
                memo. Confirmation counts reflect the recorded observation.
              </p>
            </>
          ) : (
            <p>No funding receipt is included in this evidence pack.</p>
          )}
          <div className="t-actions">
            <a className="t-button outline" href="/app/invoices">
              Inspect paid invoices
            </a>
            <a className="t-muted-link" href="/app?create">
              Fund your own workspace
            </a>
          </div>
        </section>
        <p className="t-route-note">
          The earlier diagnostic supplier payment preceded Noir funding. The
          invoice history is a separate recurring-payment run. These records are
          not a replay of a newly funded account.
        </p>
      </main>
    );
  return (
    <main className="t-main t-enter">
      <p className="t-eyebrow">YOUR WORKSPACE WALLET</p>
      <h1 className="t-title">
        Fund the routine.
        <br />
        <em>Keep control.</em>
      </h1>
      <p className="t-subtitle">
        Add shielded TAZ from Noir to the dedicated wallet used for your
        approved recurring payments.
      </p>
      <div className="t-grid">
        <section className="t-panel t-enter">
          <div className="t-service">
            <span aria-hidden="true">N</span>
            <div>
              <h2>Your Noir wallet</h2>
              <p>Funding stays under your approval</p>
            </div>
          </div>
          <p>
            Connect your testnet wallet. Noir will ask you to review the
            recipient, amount, and fee before sending.
          </p>
          {account && (
            <>
              <p className="t-eyebrow">CONNECTED ADDRESS</p>
              <p className="t-code">{account.shielded}</p>
              <div className="wallet-balance">
                <span>Available in Noir</span>
                <strong>
                  {primaryBalance?.synced
                    ? (balance?.available ??
                      balance?.spendable ??
                      "Unavailable")
                    : "Syncing"}{" "}
                  <small>TAZ</small>
                </strong>
              </div>
            </>
          )}
          <button
            className="t-button outline"
            disabled={busy}
            onClick={connect}
          >
            {account ? "Refresh connection" : "Connect Noir"}
          </button>
          <details className="t-details">
            <summary>Wallet setup</summary>
            <p>
              Use a NU7-compatible Noir testnet extension. Mainnet and testnet
              are separate builds. If the wrong wallet answers, disable the
              mainnet extension while testing.
            </p>
            <p>
              <a
                href="https://github.com/NoirWallet/noir-wallet/pull/53"
                target="_blank"
                rel="noreferrer"
              >
                NU7 testnet build information
              </a>
            </p>
          </details>
        </section>
        <section className="t-panel t-enter">
          <div className="t-service">
            <span aria-hidden="true">T</span>
            <div>
              <h2>Workspace wallet</h2>
              <p>Private to your account</p>
            </div>
          </div>
          <p className="t-eyebrow">SHIELDED FUNDING ADDRESS</p>
          <p className="t-code">
            {status?.operating.address ?? "Preparing your address..."}
          </p>
          <div className="wallet-balance">
            <span>Funding amount</span>
            <strong>
              {FUNDING_AMOUNT} <small>TAZ</small>
            </strong>
          </div>
          <p>
            Network fees are additional. This deposit funds only your workspace;
            it does not approve a subscription.
          </p>
          <button
            className="t-button wallet-fund"
            disabled={!account || !status?.fundingReady || busy || !!funding}
            onClick={fund}
          >
            {busy
              ? "Waiting for Noir..."
              : funding
                ? "Funding request recorded"
                : `Review ${FUNDING_AMOUNT} TAZ in Noir`}
          </button>
          <p className="t-route-note">
            The service manages this workspace wallet's signing keys. Noir keeps
            the keys to your funding wallet.
          </p>
        </section>
      </div>
      <section className="wallet-receipt">
        <div className="wallet-section-title">
          <div>
            <p className="t-eyebrow">BALANCE &amp; FUNDING</p>
            <h2>Ready for the next invoice.</h2>
          </div>
          <button
            className="t-link-button"
            disabled={busy || ["queued", "running"].includes(workspace.state)}
            onClick={() =>
              action("/api/wallet/sync").catch((e) => setError(e.message))
            }
          >
            Sync balance
          </button>
        </div>
        <div className="t-stats">
          <div>
            <span>Workspace balance</span>
            <strong>
              {formatZatoshis(status?.operating.totalZatoshis)}{" "}
              <small>TAZ</small>
            </strong>
          </div>
          <div>
            <span>Spendable</span>
            <strong>
              {formatZatoshis(status?.operating.ironwoodSpendableZatoshis)}{" "}
              <small>TAZ</small>
            </strong>
          </div>
          <div>
            <span>Last update</span>
            <strong className="wallet-time">
              {status?.updatedAtUnix
                ? new Date(status.updatedAtUnix * 1000).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                : "Updating"}
            </strong>
          </div>
        </div>
        <p role="status">
          {confirmedFunding ? "Funding received and verified." : message}
        </p>
        {(error || workspace.error) && (
          <p className="t-error" role="alert">
            {error || workspace.error}
          </p>
        )}
        {funding && (
          <>
            <p className="t-eyebrow">
              {confirmedFunding ? "VERIFIED FUNDING" : "FUNDING REQUEST"}
            </p>
            <p className="t-code">
              {funding === "pending"
                ? "Check Noir history before trying again."
                : funding}
            </p>
            {funding !== "pending" && !confirmedFunding && (
              <button
                className="t-button outline"
                disabled={["queued", "running"].includes(workspace.state)}
                onClick={() =>
                  action("/api/wallet/verify", {
                    txid: funding.toLowerCase(),
                  }).catch((e) => setError(e.message))
                }
              >
                Check funding receipt
              </button>
            )}
          </>
        )}
        {funding === "pending" && !busy && (
          <div className="t-notice">
            <div className="t-field">
              <label htmlFor="funding-recovery">
                Already sent? Paste the transaction ID from Noir history.
              </label>
              <input
                id="funding-recovery"
                value={recoveryTx}
                maxLength={64}
                onChange={(e) => setRecoveryTx(e.target.value.trim())}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                className="t-button outline"
                disabled={!/^[a-f0-9]{64}$/i.test(recoveryTx)}
                onClick={async () => {
                  if (!status || !navigator.locks) return;
                  try {
                    await navigator.locks.request(
                      `funding:${status.operating.address}`,
                      { ifAvailable: true },
                      async (lock) => {
                        if (!lock)
                          throw new Error(
                            "Another tab still has an active Noir request.",
                          );
                        const txid = recoveryTx.toLowerCase();
                        localStorage.setItem(
                          `funding:${status.operating.address}`,
                          txid,
                        );
                        setFunding(txid);
                        await action("/api/wallet/verify", { txid });
                      },
                    );
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                Verify existing transfer
              </button>
            </div>
            <label className="t-check">
              <input
                type="checkbox"
                checked={checkedHistory}
                onChange={(e) => setCheckedHistory(e.target.checked)}
              />
              I checked Noir history and no funding transfer was submitted.
            </label>
            <button
              className="t-button outline"
              disabled={!checkedHistory}
              onClick={async () => {
                if (!status || !navigator.locks) return;
                await navigator.locks.request(
                  `funding:${status.operating.address}`,
                  { ifAvailable: true },
                  async (lock) => {
                    if (!lock) {
                      setError("Another tab still has an active Noir request.");
                      return;
                    }
                    if (
                      localStorage.getItem(
                        `funding:${status.operating.address}`,
                      ) !== "pending"
                    ) {
                      await refresh();
                      return;
                    }
                    localStorage.removeItem(
                      `funding:${status.operating.address}`,
                    );
                    setFunding("");
                    setCheckedHistory(false);
                    setError("");
                  },
                );
              }}
            >
              Allow a new request
            </button>
          </div>
        )}
        <div className="t-actions">
          <a className="t-muted-link" href="/app/agreements">
            Review your agreement
          </a>
          <a className="t-muted-link" href="/app/invoices">
            View invoices
          </a>
        </div>
        <p className="t-route-note">
          Use TAZ on NU7 testnet only. A transaction ID means submitted; a
          verified receipt means received.
        </p>
      </section>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <WorkspaceApp page="wallet">
    <App />
  </WorkspaceApp>,
);
