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
import { ed25519, x25519 } from "@noble/curves/ed25519.js";

export type ExportWalletRole = "payout" | "creator";
export const EXPORT_INFO = "last60/wallet-export/v1";
/** Longest validity an export intent may claim. */
export const EXPORT_MAX_TTL_MS = 5 * 60_000;
const TITLE = "Asteroid Protocol wallet key export";
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

async function aesKey(secret: Uint8Array, peerPublicHex: string, requestId: string, usage: "encrypt" | "decrypt", info = EXPORT_INFO): Promise<CryptoKey> {
  const shared = x25519.getSharedSecret(secret, fromHex(peerPublicHex));
  const ikm = await crypto.subtle.importKey("raw", buf(shared), "HKDF", false, ["deriveKey"]);
  shared.fill(0);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: buf(fromHex(requestId)), info: buf(new TextEncoder().encode(info)) }, ikm, { name: "AES-GCM", length: 256 }, false, [usage]);
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

// ── import (browser → rewards worker) ────────────────────────────────────────────────────────
//
// The reverse direction: the browser seals a private key the admin pasted to the rewards worker's IMPORT
// public key (an X25519 key the worker derives from its vault key and publishes). A separate HKDF label
// keeps import ciphertexts from ever being usable as export ciphertexts and vice versa. The admin wallet
// signs an import intent naming the wallet, the address being imported and the worker key the browser
// encrypted to, so nobody relaying the request can store a key of their own as a Last-60 wallet.

export const IMPORT_INFO = "last60/wallet-import/v1";
const IMPORT_TITLE = "Asteroid Protocol wallet key import";
const IMPORT_WARNING = "Signing stores this wallet's private key, encrypted, as an Asteroid Protocol wallet. Only sign for an address you control.";

export interface ImportIntent {
  site: string;
  role: ExportWalletRole;
  /** The address the pasted key derives (shown to the admin in the signing prompt). */
  address: string;
  requestId: string;
  /** The worker import key the browser encrypted to (64 hex chars). */
  workerKey: string;
  expiresAt: string;
}

export interface SealedImport {
  /** The browser's one-time X25519 public key (64 hex chars). */
  senderKey: string;
  iv: string;
  ciphertext: string;
}

/** The exact text the admin wallet signs for an import (one field per line, fixed order). */
export function importIntentMessage(i: ImportIntent): string {
  return [IMPORT_TITLE, IMPORT_WARNING, `Site: ${i.site}`, `Wallet: ${i.role}`, `Address: ${i.address}`, `Request: ${i.requestId}`, `Worker key: ${i.workerKey}`, `Expires: ${i.expiresAt}`].join("\n");
}

/** Parse a signed import intent; null unless it is exactly the canonical message. */
export function parseImportIntentMessage(message: string): ImportIntent | null {
  const lines = message.split("\n");
  if (lines.length !== 8 || lines[0] !== IMPORT_TITLE || lines[1] !== IMPORT_WARNING) return null;
  const field = (n: number, k: string) => (lines[n]!.startsWith(`${k}: `) ? lines[n]!.slice(k.length + 2) : null);
  const i = { site: field(2, "Site"), role: field(3, "Wallet"), address: field(4, "Address"), requestId: field(5, "Request"), workerKey: field(6, "Worker key"), expiresAt: field(7, "Expires") };
  if (Object.values(i).some((v) => v === null)) return null;
  if (i.role !== "payout" && i.role !== "creator") return null;
  if (!B58.test(i.address!) || !HEX16.test(i.requestId!) || !HEX32.test(i.workerKey!) || Number.isNaN(Date.parse(i.expiresAt!))) return null;
  const parsed = i as ImportIntent;
  return importIntentMessage(parsed) === message ? parsed : null;
}

/** Browser side: seal a 64-byte secret key to the worker's import key with a fresh one-time key. */
export async function sealImport(secretKey: Uint8Array, workerKey: string, requestId: string): Promise<SealedImport> {
  const eph = x25519.utils.randomSecretKey();
  const key = await aesKey(eph, workerKey, requestId, "encrypt", IMPORT_INFO);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(iv), additionalData: buf(fromHex(requestId)) }, key, buf(secretKey)));
  const senderKey = toHex(x25519.getPublicKey(eph));
  eph.fill(0);
  return { senderKey, iv: toB64(iv), ciphertext: toB64(ct) };
}

/** Worker side: open a sealed import with the worker's import secret; returns the 64-byte secret key. */
export async function openImport(workerSecret: Uint8Array, sealed: SealedImport, requestId: string): Promise<Uint8Array> {
  const key = await aesKey(workerSecret, sealed.senderKey, requestId, "decrypt", IMPORT_INFO);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(fromB64(sealed.iv)), additionalData: buf(fromHex(requestId)) }, key, buf(fromB64(sealed.ciphertext))));
}

/** The worker's public import key from its 32-byte import secret. */
export const importPublicKey = (workerSecret: Uint8Array) => toHex(x25519.getPublicKey(workerSecret));

/** Short, comparable fingerprint of a worker import key (shown in the admin page and by the CLI). */
export function keyFingerprint(hexKey: string): string {
  return (hexKey.match(/.{4}/g) ?? []).slice(0, 4).join(":");
}

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s: string): Uint8Array | null {
  let n = 0n;
  for (const c of s) {
    const v = B58_ALPHABET.indexOf(c);
    if (v < 0) return null;
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}
function b58encode(b: Uint8Array): string {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let out = "";
  while (n > 0n) {
    out = B58_ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    out = "1" + out;
  }
  return out;
}

/**
 * Parse a Solana private key as wallets export it — a base58 64-byte secret key (Phantom, Solflare) or the
 * Solana CLI JSON array of 64 bytes — and check that its public half matches its seed. Returns the secret
 * key and the address it controls, or an error message. Runs entirely in the browser.
 */
export function parseSolanaSecretKey(text: string): { secretKey: Uint8Array; address: string } | { error: string } {
  const t = text.trim();
  let bytes: Uint8Array | null = null;
  if (t.startsWith("[")) {
    try {
      const arr = JSON.parse(t);
      if (Array.isArray(arr) && arr.length === 64 && arr.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) bytes = Uint8Array.from(arr);
    } catch {
      /* invalid */
    }
    if (!bytes) return { error: "not a JSON array of 64 bytes" };
  } else {
    bytes = b58decode(t);
    if (!bytes) return { error: "not base58 (or a JSON array)" };
    if (bytes.length !== 64) return { error: `base58 key decodes to ${bytes.length} bytes, expected 64 (a 32-byte seed or an address is not a private key)` };
  }
  const derived = ed25519.getPublicKey(bytes.subarray(0, 32));
  if (!derived.every((x, i) => x === bytes![32 + i])) return { error: "the key's public half does not match its secret half (corrupt key)" };
  return { secretKey: bytes, address: b58encode(derived) };
}
