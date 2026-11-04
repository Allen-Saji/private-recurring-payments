export function amount(zatoshis: string, short = false): string {
  const n = BigInt(zatoshis),
    whole = n / 100000000n,
    decimals = (n % 100000000n).toString().padStart(8, "0");
  return `${whole}.${short ? decimals.replace(/0+$/, "").padEnd(2, "0") : decimals}`;
}
export function date(time: number, withTime = false): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(new Date(time * 1000));
}
export const shortId = (id: string) => `${id.slice(0, 9)}...${id.slice(-7)}`;
export const stateLabel = (state: string) =>
  ({
    paid: "Paid",
    verification_pending: "Verification pending",
    unpaid: "Unpaid",
  })[state] || state;
export function download(name: string, contents: string, type: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function csvCell(value: unknown) {
  let text = String(value ?? "");
  if (/^[=+@\t\r-]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
