import { readFile } from "node:fs/promises";
export async function loadReview(file) {
  if (!file) return null;
  const pack = JSON.parse(await readFile(file, "utf8"));
  if (
    pack.schema !== 1 ||
    !pack.snapshot?.overview ||
    !pack.billing?.invoices ||
    !pack.details
  )
    throw new Error("Invalid review evidence pack");
  return pack;
}
export function reviewWorkspace(pack) {
  return {
    id: "review",
    name: "Verified testnet workspace",
    state: "ready",
    error: null,
    readOnly: true,
    automation: false,
    updatedAt: pack.exported_at * 1000,
    job_result: null,
    snapshot: { ...pack.snapshot, fundingReady: false },
    evidence: {
      exportedAt: pack.exported_at,
      notice:
        "Recorded NU7 testnet activity. Read-only access; confirmation counts reflect the saved observation.",
    },
  };
}
export function reviewRead(pack, url) {
  if (url.pathname === "/api/workspace") return reviewWorkspace(pack);
  if (url.pathname === "/api/status")
    return { ...pack.snapshot, fundingReady: false };
  if (url.pathname === "/api/overview")
    return { signer: pack.snapshot.overview };
  if (url.pathname === "/api/billing") return pack.billing;
  const m = url.pathname.match(/^\/api\/billing\/invoices\/([a-f0-9]{64})$/);
  if (m && Object.hasOwn(pack.details, m[1])) return pack.details[m[1]];
  return undefined;
}
