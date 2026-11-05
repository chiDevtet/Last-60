import mongoose from "mongoose";

const { Decimal128 } = mongoose.Types;
export type Dec = mongoose.Types.Decimal128;

/** bigint → Decimal128 (exact; Decimal128 holds 34 significant digits, u64 needs 20). */
export function dec(v: bigint | number | string): Dec {
  const s = typeof v === "bigint" ? v.toString() : String(v);
  if (!/^-?\d+$/.test(s)) throw new Error(`dec(): not an integer: ${s}`);
  return Decimal128.fromString(s);
}

/**
 * Decimal128 (or its string form, possibly in exponent notation produced by aggregation) → bigint.
 * Throws if the value is not integral, so fractional garbage can never silently enter accounting.
 */
export function big(v: Dec | string | number | bigint | null | undefined): bigint {
  if (v === null || v === undefined) return 0n;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error(`big(): unsafe number ${v}`);
    return BigInt(v);
  }
  const s = typeof v === "string" ? v : v.toString();
  const m = /^(-)?(\d+)(?:\.(\d+))?(?:E([+-]?\d+))?$/i.exec(s.trim());
  if (!m) throw new Error(`big(): cannot parse "${s}"`);
  const [, neg, intPart = "0", frac = "", expStr] = m;
  const exp = expStr ? Number(expStr) : 0;
  let digits = intPart + frac;
  let scale = frac.length - exp; // value = digits * 10^-scale
  if (scale > 0) {
    const tail = digits.slice(digits.length - scale);
    if (/[^0]/.test(tail)) throw new Error(`big(): non-integral value ${s}`);
    digits = digits.slice(0, digits.length - scale) || "0";
    scale = 0;
  }
  const result = BigInt(digits) * 10n ** BigInt(-scale);
  return neg ? -result : result;
}

export const ZERO = () => dec(0n);
