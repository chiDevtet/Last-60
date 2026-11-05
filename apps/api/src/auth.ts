/**
 * Admin authentication: Sign-In-With-Solana style challenge/response.
 *   1. POST /nonce   → server issues a single-use, domain-bound message (5 min TTL)
 *   2. wallet signs it (ed25519) → POST /verify
 *   3. server verifies the signature against the allow-listed public key and returns a short-lived
 *      HMAC session token. Tokens are re-checked against ADMIN_WALLETS on every request.
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

export function buildMessage(o: { appName: string; domain: string; wallet: string; nonce: string; issuedAt: string; expiresAt: string }) {
  return `${o.appName} admin sign-in\n\nDomain: ${o.domain}\nWallet: ${o.wallet}\nNonce: ${o.nonce}\nIssued At: ${o.issuedAt}\nExpires At: ${o.expiresAt}\n\nSigning this message does not authorize any transaction.`;
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

  async issueNonce(wallet: string, domain: string) {
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
    const message = buildMessage({ appName: this.cfg.appName, domain, wallet, nonce, issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString() });
    await this.db.AdminNonce.create({ nonce, wallet, message, expiresAt });
    return { nonce, message, expiresAt: expiresAt.toISOString() };
  }

  async verify(wallet: string, nonce: string, signature: string) {
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
    const ok = ed25519.verify(sig, new TextEncoder().encode(rec.message), new PublicKey(wallet).toBytes());
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
