import React, { createContext, useContext, useEffect, useState } from "react";
import "./theme.css";
import "./product.css";
import reviewAccess from "../../shared/review-access.json";
class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export async function api<T = any>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    credentials: "same-origin",
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined
        ? {}
        : { "Content-Type": "application/json", "X-Tandem-Request": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok || !j.ok)
    throw new RequestError(
      j.error || "This request could not be completed.",
      r.status,
    );
  return j.result;
}
type Context = {
  username: string;
  workspace: any;
  readOnly: boolean;
  refresh: () => Promise<void>;
  action: (url: string, body?: unknown) => Promise<void>;
};
const WorkspaceContext = createContext<Context | null>(null);
export const useWorkspace = () => useContext(WorkspaceContext)!;
export function Mark() {
  return (
    <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <path d="M5 15 35 3v12L17 23v13L5 29Z" fill="currentColor" />
      <path
        d="m43 19-12-7v13l-18 8v12l30-12Z"
        fill="currentColor"
        opacity=".65"
      />
    </svg>
  );
}
export function WorkspaceApp({
  page,
  children,
}: {
  page: "overview" | "services" | "agreements" | "wallet" | "invoices";
  children: React.ReactNode;
}) {
  const [username, setUsername] = useState(""),
    [workspace, setWorkspace] = useState<any>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [quiet, setQuiet] = useState(
    () => localStorage.getItem("tandem:motion") === "off",
  );
  async function refresh() {
    try {
      const w = await api("/api/workspace");
      setWorkspace(w);
    } catch (error) {
      if (error instanceof RequestError && error.status === 401) {
        setUsername("");
        setWorkspace(null);
      } else throw error;
    }
  }
  async function session() {
    const s = await api("/session");
    const params = new URLSearchParams(location.search);
    if (
      s.unlocked &&
      !(params.has("review") && s.user.role !== "reviewer") &&
      !(
        s.user.role === "reviewer" &&
        (params.has("create") || params.has("owner"))
      )
    ) {
      setUsername(s.user.username);
      await refresh();
    } else {
      setUsername("");
      setWorkspace(null);
    }
    setLoading(false);
  }
  useEffect(() => {
    session().catch((e) => {
      setError(e.message);
      setLoading(false);
    });
  }, []);
  useEffect(() => {
    if (!username) return;
    const timer = setInterval(() => refresh().catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, [username]);
  useEffect(() => {
    document
      .querySelector('.t-nav a[aria-current="page"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [username, page]);
  async function action(url: string, body: unknown = {}) {
    await api(url, body);
    await refresh();
  }
  const busy = workspace && ["queued", "running"].includes(workspace.state);
  return (
    <div className={quiet ? "t-quiet" : ""}>
      <header className="t-header t-no-print">
        <a className="t-brand" href="/" aria-label="Tandem home">
          <Mark />
          <span>
            tandem<i>.</i>
          </span>
        </a>
        {username && (
          <nav className="t-nav" aria-label="Workspace navigation">
            {[
              ["", "Overview"],
              ["services", "Services"],
              ["agreements", "Agreements"],
              ["wallet", "Wallet"],
              ["invoices", "Invoices"],
            ].map(([route, label]) => (
              <a
                key={route}
                href={route ? "/app/" + route : "/app"}
                aria-current={
                  page === (route || "overview") ? "page" : undefined
                }
              >
                {label}
              </a>
            ))}
          </nav>
        )}
        <div className="t-meta">
          <span className="t-network">Zcash NU7 testnet</span>
          {username && <span className="t-account">{username}</span>}
          <button
            className="t-link-button"
            onClick={() => {
              setQuiet(!quiet);
              localStorage.setItem("tandem:motion", quiet ? "on" : "off");
            }}
          >
            {quiet ? "Motion off" : "Pause motion"}
          </button>
          {username && (
            <button
              className="t-link-button"
              onClick={async () => {
                await api("/api/logout", {});
                setUsername("");
                setWorkspace(null);
                location.href = "/";
              }}
            >
              Sign out
            </button>
          )}
        </div>
      </header>
      {loading ? (
        <main className="t-loading">
          <span className="t-pulse" />
          <p>Opening your workspace...</p>
        </main>
      ) : !username ? (
        <Auth onSuccess={session} />
      ) : !workspace?.snapshot ? (
        <main className="t-loading">
          <span className="t-pulse" />
          <h1>Your workspace is taking shape.</h1>
          <p>A dedicated shielded wallet is being prepared for your account.</p>
          {workspace?.error && (
            <>
              <p className="t-error">
                Setup could not finish. Your existing wallet state has been
                kept.
              </p>
              <button
                className="t-button"
                disabled={busy}
                onClick={() => action("/api/workspace/initialize")}
              >
                Retry setup
              </button>
            </>
          )}
        </main>
      ) : (
        <WorkspaceContext.Provider
          value={{
            username,
            workspace,
            readOnly: !!workspace.readOnly,
            refresh,
            action,
          }}
        >
          {workspace.readOnly && (
            <div className="t-review-banner t-no-print">
              <span>
                <strong>Review workspace</strong> Real recorded NU7 payments.
                Read-only access.
              </span>
              <a href="/app?create">Create your own workspace</a>
            </div>
          )}
          {children}
        </WorkspaceContext.Provider>
      )}
      {error && (
        <p className="t-error" role="alert">
          {error}
        </p>
      )}
      <footer className="t-footer t-no-print">
        <span>Private payments. On your terms.</span>
        <a href="/#privacy">Privacy &amp; trust</a>
        <a href="/agents">For agents</a>
        <span>Testnet release</span>
      </footer>
    </div>
  );
}
function Auth({ onSuccess }: { onSuccess: () => Promise<void> }) {
  const params = new URLSearchParams(location.search);
  const [mode, setMode] = useState<"review" | "owner" | "create">(
    params.has("create") ? "create" : params.has("owner") ? "owner" : "review",
  );
  const [username, setUsername] = useState(
      params.has("create") || params.has("owner") ? "" : reviewAccess.username,
    ),
    [password, setPassword] = useState(
      params.has("create") || params.has("owner") ? "" : reviewAccess.password,
    );
  const [accepted, setAccepted] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [reviewAvailable, setReviewAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    fetch("/.well-known/tandem.json")
      .then((r) => r.json())
      .then((d) => setReviewAvailable(!!d.review))
      .catch(() => setReviewAvailable(false));
  }, []);
  function choose(next: "review" | "owner" | "create") {
    setMode(next);
    setUsername(next === "review" ? reviewAccess.username : "");
    setPassword(next === "review" ? reviewAccess.password : "");
    setError("");
    setAccepted(false);
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(mode === "create" ? "/api/auth/register" : "/api/auth/login", {
        username,
        password,
      });
      setPassword("");
      const destination = new URL(location.href);
      for (const key of ["review", "owner", "create"])
        destination.searchParams.delete(key);
      history.replaceState(null, "", destination.pathname + destination.search);
      await onSuccess();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="t-auth t-enter">
      <div>
        <p className="t-eyebrow">PRIVATE PAYMENTS, MADE CLEAR</p>
        <h1 className="t-title">
          {mode === "review" ? "See it" : "Make it"}
          <br />
          <em>{mode === "review" ? "in practice." : "your workspace."}</em>
        </h1>
        <p className="t-subtitle">
          {mode === "review"
            ? "Explore a signed agreement, settled invoices, and their shielded receipts. No wallet setup needed."
            : "Discover a supplier, approve a spending limit, and keep every invoice in one place."}
        </p>
        <div className="t-auth-tabs" role="group" aria-label="Choose access">
          <button
            aria-pressed={mode === "review"}
            onClick={() => choose("review")}
          >
            Judge access
          </button>
          <button
            aria-pressed={mode === "owner" || mode === "create"}
            onClick={() => choose("owner")}
          >
            Company sign in
          </button>
        </div>
        <form onSubmit={submit}>
          <div className="t-field">
            <label htmlFor="username">Username</label>
            <input
              id="username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              pattern="[a-zA-Z][a-zA-Z0-9_-]{2,31}"
              maxLength={32}
            />
          </div>
          <div className="t-field">
            <label htmlFor="password">
              Password{mode === "create" ? " / at least 12 characters" : ""}
            </label>
            <input
              id="password"
              type={mode === "review" ? "text" : "password"}
              autoComplete={
                mode === "create" ? "new-password" : "current-password"
              }
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={mode === "create" ? 12 : 1}
              maxLength={128}
              required
            />
          </div>
          {mode === "review" && (
            <p className="t-access-note">
              Public review credentials are prefilled. This account cannot send
              funds or change agreements.{" "}
              {reviewAvailable === false
                ? "Review evidence is not configured on this installation."
                : ""}
            </p>
          )}
          {mode === "create" && (
            <label className="t-check">
              <input
                type="checkbox"
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
              />
              I understand this is a NU7 testnet workspace and Tandem manages
              its payment and approval keys.
            </label>
          )}
          {error && (
            <p className="t-error" role="alert">
              {error}
            </p>
          )}
          <button
            className="t-button"
            disabled={
              busy ||
              (mode === "create" && !accepted) ||
              (mode === "review" && reviewAvailable !== true)
            }
          >
            {busy
              ? "Opening workspace..."
              : mode === "review"
                ? "Explore the review workspace"
                : mode === "create"
                  ? "Create private workspace"
                  : "Sign in"}
          </button>
          <small>
            {mode === "create"
              ? "Already registered?"
              : "Ready to try your own agreement?"}{" "}
            <button
              type="button"
              className="t-auth-switch"
              onClick={() => choose(mode === "create" ? "owner" : "create")}
            >
              {mode === "create"
                ? "Company sign in"
                : "Create a private workspace"}
            </button>
          </small>
        </form>
        <a className="t-auth-guide" href="/agents">
          Using an agent? Read the connection guide
        </a>
      </div>
      <div className="t-auth-art" aria-hidden="true">
        <img src="/sealed-sculpture.png" alt="" />
        <p>Clear terms. A private record.</p>
      </div>
    </main>
  );
}
