/**
 * Signing-key loading. Keys are read once, in the rewards process only, and never logged or
 * returned by any API. Accepts a base58 64-byte secret key, a JSON byte array, or a path to a
 * Solana CLI keypair file (which should be chmod 600).
 */
import { readFileSync, statSync } from "node:fs";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

export function parseSecretKey(value: string): Keypair {
  const v = value.trim();
  let bytes: Uint8Array;
  if (v.startsWith("[")) {
    const arr = JSON.parse(v);
    if (!Array.isArray(arr) || arr.length !== 64 || arr.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) throw new Error("secret key JSON must be an array of 64 bytes");
    bytes = Uint8Array.from(arr);
  } else {
    bytes = bs58.decode(v);
    if (bytes.length !== 64) throw new Error(`base58 secret key must decode to 64 bytes (got ${bytes.length})`);
  }
  return Keypair.fromSecretKey(bytes); // validates the public half
}

export function loadKeypair(src: { privateKey?: string; keypairPath?: string }, expectedPublicKey?: string | null, label = "key"): Keypair {
  let kp: Keypair;
  if (src.keypairPath) {
    const st = statSync(src.keypairPath);
    if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
      throw new Error(`${label} file ${src.keypairPath} is readable by group/others; run chmod 600`);
    }
    kp = parseSecretKey(readFileSync(src.keypairPath, "utf8"));
  } else if (src.privateKey) {
    kp = parseSecretKey(src.privateKey);
  } else {
    throw new Error(`${label}: no signing key configured`);
  }
  if (expectedPublicKey && kp.publicKey.toBase58() !== expectedPublicKey) {
    throw new Error(`${label}: loaded key ${kp.publicKey.toBase58()} does not match the configured public key ${expectedPublicKey}`);
  }
  return kp;
}
