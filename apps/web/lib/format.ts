import { formatSol, formatUnits, shortAddress } from "@last60/shared";

export { shortAddress, formatSol };

export function sol(lamports: string | bigint | null | undefined, max = 4, min = 2) {
  if (lamports === null || lamports === undefined || lamports === "") return "—";
  return formatSol(lamports, max, min);
}

export function amount(v: string, decimals: number, max = 4) {
  return formatUnits(v, decimals, { maxFraction: max, minFraction: 2 });
}

/** Display-only float for animation interpolation (exact values are always shown at rest). */
export function lamportsToFloat(l: string | bigint): number {
  const b = typeof l === "bigint" ? l : BigInt(l || "0");
  return Number(b / 1_000_000n) / 1000 + Number(b % 1_000_000n) / 1e9;
}

export function clockTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function dateTime(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function relative(iso: string | null, now: number) {
  if (!iso) return "pending";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

export function compactNumber(n: number) {
  return new Intl.NumberFormat(undefined, { notation: n >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(n);
}
