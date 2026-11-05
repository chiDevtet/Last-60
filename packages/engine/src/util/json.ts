/** Deep-converts bigint → string and Buffer → base64 so values can be JSON-serialised safely. */
export function jsonSafe<T>(v: T): any {
  if (typeof v === "bigint") return v.toString();
  if (Buffer.isBuffer(v)) return "[binary]";
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === "object") {
    if (typeof (v as any).toHexString === "function") return String(v); // ObjectId
    if ((v as any)._bsontype === "Decimal128") return String(v);
    return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, jsonSafe(x)]));
  }
  return v;
}
