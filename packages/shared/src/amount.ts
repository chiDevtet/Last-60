/**
 * Exact integer amount helpers. On-chain amounts travel as decimal strings of base units and are
 * only ever converted with bigint arithmetic — never floating point.
 */

export function parseUnits(value: string, decimals: number): bigint {
  const s = value.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid decimal amount: "${value}"`);
  const [whole = "0", frac = ""] = s.split(".");
  if (frac.length > decimals) {
    if (/[^0]/.test(frac.slice(decimals))) {
      throw new Error(`Amount "${value}" has more than ${decimals} decimal places`);
    }
  }
  const fracPadded = (frac.slice(0, decimals) + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fracPadded || "0");
}

/** Format base units as a decimal string, trimming trailing zeros but keeping `minFraction` digits. */
export function formatUnits(amount: bigint | string, decimals: number, opts: { maxFraction?: number; minFraction?: number } = {}): string {
  let v = typeof amount === "string" ? BigInt(amount) : amount;
  const negative = v < 0n;
  if (negative) v = -v;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  let frac = (v % base).toString().padStart(decimals, "0");
  const maxFraction = opts.maxFraction ?? decimals;
  if (maxFraction < decimals) frac = frac.slice(0, maxFraction); // truncation (display only)
  frac = frac.replace(/0+$/, "");
  const minFraction = Math.min(opts.minFraction ?? 0, maxFraction);
  if (frac.length < minFraction) frac = frac.padEnd(minFraction, "0");
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${wholeStr}${frac ? "." + frac : ""}`;
}

export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const SOL_DECIMALS = 9;

export function formatSol(lamports: bigint | string, maxFraction = 4, minFraction = 2): string {
  return formatUnits(lamports, SOL_DECIMALS, { maxFraction, minFraction });
}

/** Percentage given in basis points, e.g. 7500 → "75". */
export function formatBps(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = Math.abs(bps % 100);
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}`;
}
