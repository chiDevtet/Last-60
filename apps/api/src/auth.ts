/**
 * Admin authentication: Sign-In-With-Solana (SIWS / CAIP-122 message format) challenge/response.
 *   1. POST /nonce   → server issues a single-use message bound to PUBLIC_SITE_URL's host (5 min TTL),
 *                      plus the equivalent `signInInput` for wallets implementing `solana:signIn`.
 *   2. the wallet signs it → POST /verify. Wallets recognise the SIWS format and refuse / warn when
 *      the message's domain differs from the page requesting the signature, which defeats phishing
 *      sites that relay our challenge to an admin.
 *   3. server verifies the ed25519 signature against the allow-listed key over EXACTLY the issued
 *      message (or, for `solana:signIn`, a message whose SIWS fields equal the issued ones) and
 *      returns a short-lived HMAC session token, re-checked against ADMIN_WALLETS on every request.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { hmac, randomToken, safeEqual, type Models } from "@last60/engine";

export interface AdminAuthConfig {
  appName: string;
  adminWallets: string[];
  secret: string | null;
  ttlSeconds: number;
}

export interface SiwsFields {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  version: string;
  chainId: string;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
}

/** SIWS message (the format `solana:signIn` wallets construct and parse). */
export function buildMessage(o: { appName: string; domain: string; uri?: string; chainId?: string; wallet: string; nonce: string; issuedAt: string; expiresAt: string }) {
  return siwsMessage(siwsFields(o));
}

export function siwsFields(o: { appName: string; domain: string; uri?: string; chainId?: string; wallet: string; nonce: string; issuedAt: string; expiresAt: string }): SiwsFields {
  return {
    domain: o.domain,
    address: o.wallet,
    statement: `${o.appName} admin sign-in. Signing this message does not authorize any transaction.`,
    uri: o.uri ?? `https://${o.domain}`,
    version: "1",
    chainId: o.chainId ?? "mainnet",
    nonce: o.nonce,
    issuedAt: o.issuedAt,
    expirationTime: o.expiresAt,
  };
}

export function siwsMessage(f: SiwsFields): string {
  return `${f.domain} wants you to sign in with your Solana account:\n${f.address}\n\n${f.statement}\n\nURI: ${f.uri}\nVersion: ${f.version}\nChain ID: ${f.chainId}\nNonce: ${f.nonce}\nIssued At: ${f.issuedAt}\nExpiration Time: ${f.expirationTime}`;
}

/** Parse a SIWS message; null if it is not one. */
export function parseSiws(msg: string): SiwsFields | null {
  const m = /^(\S+) wants you to sign in with your Solana account:\n(\S+)\n\n([\s\S]*?)\n\n([\s\S]+)$/.exec(msg);
  if (!m) return null;
  const kv = Object.fromEntries(m[4]!.split("\n").map((l) => { const i = l.indexOf(": "); return [l.slice(0, i), l.slice(i + 2)]; }));
  return { domain: m[1]!, address: m[2]!, statement: m[3]!, uri: kv["URI"] ?? "", version: kv["Version"] ?? "", chainId: kv["Chain ID"] ?? "", nonce: kv["Nonce"] ?? "", issuedAt: kv["Issued At"] ?? "", expirationTime: kv["Expiration Time"] ?? "" };
}

export class AdminAuth {
  constructor(
    private readonly db: Models,
    private readonly cfg: AdminAuthConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get enabled() {
    return this.cfg.adminWallets.length > 0 && !!this.cfg.secret;
  }

  isAdmin(wallet: string) {
    return this.cfg.adminWallets.includes(wallet);
  }

  async issueNonce(wallet: string, domain: string, opts: { uri?: string; chainId?: string } = {}) {
    if (!this.enabled) throw new AuthError(503, "admin access is not configured");
    try {
      new PublicKey(wallet);
    } catch {
      throw new AuthError(400, "invalid wallet address");
    }
    if (!this.isAdmin(wallet)) throw new AuthError(403, "wallet is not an administrator");
    const nonce = randomToken(18);
    const issuedAt = new Date(this.now());
    const expiresAt = new Date(this.now() + 5 * 60_000);
    const fields = siwsFields({ appName: this.cfg.appName, domain, uri: opts.uri, chainId: opts.chainId, wallet, nonce, issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString() });
    const message = siwsMessage(fields);
    await this.db.AdminNonce.create({ nonce, wallet, message, expiresAt });
    return { nonce, message, expiresAt: expiresAt.toISOString(), signInInput: fields };
  }

  async verify(wallet: string, nonce: string, signature: string, signedMessage?: string) {
    if (!this.enabled) throw new AuthError(503, "admin access is not configured");
    // Single use: atomically consume the nonce.
    const rec: any = await this.db.AdminNonce.findOneAndDelete({ nonce, wallet, expiresAt: { $gt: new Date(this.now()) } }).lean();
    if (!rec) throw new AuthError(401, "nonce expired or already used");
    if (!this.isAdmin(wallet)) throw new AuthError(403, "wallet is not an administrator");
    let sig: Uint8Array;
    try {
      sig = signature.length > 90 ? Uint8Array.from(Buffer.from(signature, "base64")) : bs58.decode(signature);
    } catch {
      throw new AuthError(400, "malformed signature");
    }
    if (sig.length !== 64) throw new AuthError(400, "malformed signature");
    // `solana:signIn` wallets build the message themselves from the input fields: accept it only if
    // every SIWS field equals the issued challenge; otherwise the signature must cover our exact text.
    let message = rec.message as string;
    if (signedMessage !== undefined && signedMessage !== rec.message) {
      const got = parseSiws(signedMessage);
      const want = parseSiws(rec.message);
      const same = !!got && !!want && (Object.keys(want) as (keyof SiwsFields)[]).every((k) => got[k] === want[k]);
      if (!same) throw new AuthError(401, "signed message does not match the issued challenge");
      message = signedMessage;
    }
    const ok = ed25519.verify(sig, new TextEncoder().encode(message), new PublicKey(wallet).toBytes());
    if (!ok) throw new AuthError(401, "signature verification failed");
    return this.issueToken(wallet);
  }

  issueToken(wallet: string) {
    const iat = Math.floor(this.now() / 1000);
    const exp = iat + this.cfg.ttlSeconds;
    const payload = Buffer.from(JSON.stringify({ sub: wallet, iat, exp, jti: randomToken(8) })).toString("base64url");
    return { token: `${payload}.${hmac(this.cfg.secret!, payload)}`, expiresAt: new Date(exp * 1000).toISOString() };
  }

  /** Returns the admin wallet for a valid token, else null. */
  check(authorization: string | undefined | null): string | null {
    if (!this.enabled || !authorization?.startsWith("Bearer ")) return null;
    const [payload, mac] = authorization.slice(7).trim().split(".");
    if (!payload || !mac || !safeEqual(hmac(this.cfg.secret!, payload), mac)) return null;
    try {
      const p = JSON.parse(Buffer.from(payload, "base64url").toString());
      if (typeof p.exp !== "number" || p.exp * 1000 < this.now()) return null;
      return this.isAdmin(p.sub) ? p.sub : null;
    } catch {
      return null;
    }
  }
}

export class AuthError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 503,
    message: string,
  ) {
    super(message);
  }
}
