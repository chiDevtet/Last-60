import { createCipheriv, createDecipheriv, randomBytes, randomInt, timingSafeEqual, createHmac } from "node:crypto";

/**
 * AES-256-GCM sealing for private scheduler values. The associated data binds a ciphertext to
 * its round, so a ciphertext cannot be copied onto another round.
 */
export function seal(key: Buffer, plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const enc = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return `v1.${iv.toString("base64")}.${enc.toString("base64")}.${c.getAuthTag().toString("base64")}`;
}

export function unseal(key: Buffer, sealed: string, aad: string): string {
  const [v, iv, enc, tag] = sealed.split(".");
  if (v !== "v1" || !iv || !enc || !tag) throw new Error("unsupported sealed value");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(enc, "base64")), d.final()]).toString("utf8");
}

/** Uniform CSPRNG integer in [min, max). */
export function secureRandomInt(min: number, max: number): number {
  if (max <= min) return min;
  return randomInt(min, max);
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

export function hmac(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
