/**
 * End-to-end encrypted export of a generated Last-60 wallet key (browser ⇄ rewards worker).
 *
 * The private key of a wallet generated from the admin console lives only in the rewards worker, encrypted
 * at rest. To back it up (or import the creator wallet into Phantom to launch from it), the admin page:
 *   1. creates a one-time X25519 key pair in the browser;
 *   2. has the admin WALLET sign an export intent naming the wallet, the request id, that browser key and an
 *      expiry (so nobody relaying the request — API, database — can substitute their own key);
 *   3. the rewards worker checks the signature against ADMIN_WALLETS in its own environment, then seals the
 *      secret key to the browser key (X25519 → HKDF-SHA256 → AES-256-GCM);
 *   4. the browser opens it. The API and the database only ever see ciphertext.
 *
 * Browser-safe: WebCrypto (HKDF, AES-GCM) and @noble/curves (X25519) only. Used by the web app and the worker.
 */
import { x25519 } from "@noble/curves/ed25519.js";

export type ExportWalletRole = "payout" | "creator";
export const EXPORT_INFO = "last60/wallet-export/v1";
/** Longest validity an export intent may claim. */
export const EXPORT_MAX_TTL_MS = 5 * 60_000;
const TITLE = "LAST60 wallet key export";
const WARNING = "Signing reveals this wallet's private key to the browser that created this request, and only to it.";

export interface ExportIntent {
  site: string;
  role: ExportWalletRole;
  address: string;
  /** 32 lowercase hex chars, chosen by the browser. */
  requestId: string;
  /** The browser's one-time X25519 public key, 64 lowercase hex chars. */
  browserKey: string;
  /** ISO-8601 expiry. */
  expiresAt: string;
}

const HEX32 = /^[0-9a-f]{64}$/;
const HEX16 = /^[0-9a-f]{32}$/;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The exact text the admin wallet signs (one field per line, fixed order). */
export function exportIntentMessage(i: ExportIntent): string {
  return [TITLE, WARNING, `Site: ${i.site}`, `Wallet: ${i.role}`, `Address: ${i.address}`, `Request: ${i.requestId}`, `Browser key: ${i.browserKey}`, `Expires: ${i.expiresAt}`].join("\n");
}

/** Parse a signed intent; null unless it is exactly the canonical message. */
export function parseExportIntentMessage(message: string): ExportIntent | null {
  const lines = message.split("\n");
  if (lines.length !== 8 || lines[0] !== TITLE || lines[1] !== WARNING) return null;
  const field = (n: number, k: string) => (lines[n]!.startsWith(`${k}: `) ? lines[n]!.slice(k.length + 2) : null);
  const i = { site: field(2, "Site"), role: field(3, "Wallet"), address: field(4, "Address"), requestId: field(5, "Request"), browserKey: field(6, "Browser key"), expiresAt: field(7, "Expires") };
  if (Object.values(i).some((v) => v === null)) return null;
  if (i.role !== "payout" && i.role !== "creator") return null;
  if (!B58.test(i.address!) || !HEX16.test(i.requestId!) || !HEX32.test(i.browserKey!) || Number.isNaN(Date.parse(i.expiresAt!))) return null;
  const parsed = i as ExportIntent;
  return exportIntentMessage(parsed) === message ? parsed : null;
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const buf = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/** A fresh request id and one-time X25519 key pair (keep `secret` in memory only). */
export function newExportRequest(): { requestId: string; secret: Uint8Array; browserKey: string } {
  const secret = x25519.utils.randomSecretKey();
  return { requestId: toHex(crypto.getRandomValues(new Uint8Array(16))), secret, browserKey: toHex(x25519.getPublicKey(secret)) };
}

async function aesKey(secret: Uint8Array, peerPublicHex: string, requestId: string, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  const shared = x25519.getSharedSecret(secret, fromHex(peerPublicHex));
  const ikm = await crypto.subtle.importKey("raw", buf(shared), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: buf(fromHex(requestId)), info: buf(new TextEncoder().encode(EXPORT_INFO)) }, ikm, { name: "AES-GCM", length: 256 }, false, [usage]);
}

export interface SealedExport {
  workerKey: string;
  iv: string;
  ciphertext: string;
}

/** Worker side: seal `secretKey` (64-byte Solana secret key) to the browser's key. */
export async function sealExport(secretKey: Uint8Array, browserKey: string, requestId: string): Promise<SealedExport> {
  const eph = x25519.utils.randomSecretKey();
  const key = await aesKey(eph, browserKey, requestId, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(iv), additionalData: buf(fromHex(requestId)) }, key, buf(secretKey)));
  const workerKey = toHex(x25519.getPublicKey(eph));
  eph.fill(0); // one-time: forgotten as soon as the export is sealed
  return { workerKey, iv: toB64(iv), ciphertext: toB64(ct) };
}

/** Browser side: open a sealed export with the one-time secret; returns the 64-byte secret key. */
export async function openExport(secret: Uint8Array, sealed: SealedExport, requestId: string): Promise<Uint8Array> {
  const key = await aesKey(secret, sealed.workerKey, requestId, "decrypt");
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(fromB64(sealed.iv)), additionalData: buf(fromHex(requestId)) }, key, buf(fromB64(sealed.ciphertext))));
}
