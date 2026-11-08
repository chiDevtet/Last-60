/**
 * Admin endpoints for the dedicated payout wallet, custody and attribution recovery: authenticated
 * operators only, strict request bodies (no amount / eligibility / status / recipient fields), and no
 * key material in any response.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { PublicData } from "@last60/engine";
import { createApp } from "../src/app";
import { AdminAuth } from "../src/auth";
import { StreamHub } from "../src/stream";
import { rig, startDb, stopDb, type Rig } from "../../../packages/engine/test/harness";

beforeAll(startDb, 120_000);
afterAll(stopDb);

const admin = Keypair.generate();
function api(r: Rig) {
  const data = new PublicData(r.db, r.cfg, r.settings, () => r.clock.now());
  const hub = new StreamHub(data, 60_000);
  const auth = new AdminAuth(r.db, { appName: "LAST60", adminWallets: [admin.publicKey.toBase58()], secret: "x".repeat(40), ttlSeconds: 600 });
  const app = createApp({ db: r.db, cfg: r.cfg, settings: r.settings, data, hub, auth, rpc: r.chain, providerFor: async () => r.provider, now: () => r.clock.now() });
  const token = auth.issueToken(admin.publicKey.toBase58()).token;
  const req = (path: string, init: RequestInit = {}, auth_ = true) => app.request(path, { ...init, headers: { "content-type": "application/json", ...(auth_ ? { authorization: `Bearer ${token}` } : {}) } });
  return { app, req };
}
const ROUTES: [string, string, unknown?][] = [
  ["GET", "/api/admin/payout-wallet"],
  ["GET", "/api/admin/funding"],
  ["POST", "/api/admin/funding/custody", { fundingKey: "k" }],
  ["POST", "/api/admin/funding/custody/ct_AAAAAAAAAAAAAAAAAAAAAA/submit", { signature: "1".repeat(88) }],
  ["POST", "/api/admin/funding/custody/ct_AAAAAAAAAAAAAAAAAAAAAA/cancel", { reason: "x".repeat(5) }],
  ["GET", "/api/admin/funding/attributions"],
  ["POST", "/api/admin/funding/attributions/recover", { attributionKey: "k" }],
  ["GET", "/api/admin/funding/recoveries"],
];

describe("funding admin API", () => {
  test("every endpoint rejects unauthenticated or invalid operator sessions", async () => {
    const r = await rig();
    const { app, req } = api(r);
    for (const [method, path, body] of ROUTES) {
      expect((await req(path, { method, body: body ? JSON.stringify(body) : undefined }, false)).status).toBe(401);
      const forged = await app.request(path, { method, headers: { "content-type": "application/json", authorization: "Bearer eyJzdWIiOiJ4In0.bad" }, body: body ? JSON.stringify(body) : undefined });
      expect(forged.status).toBe(401);
    }
    expect(await r.db.AttributionRecovery.countDocuments()).toBe(0);
    expect(await r.db.CustodyTransfer.countDocuments()).toBe(0);
  });

  test("strict bodies: an amount, recipient, eligibility, status or correlation field is refused", async () => {
    const r = await rig();
    const { req } = api(r);
    for (const extra of [{ amount: "1" }, { payoutEligible: true }, { collectionKey: "c" }, { status: "linked" }, { correlationMethod: "memo" }]) {
      const res = await req("/api/admin/funding/attributions/recover", { method: "POST", body: JSON.stringify({ attributionKey: "k", ...extra }) });
      expect(res.status).toBe(400);
    }
    for (const extra of [{ amount: "1" }, { destinationWallet: Keypair.generate().publicKey.toBase58() }, { lamports: 5 }]) {
      expect((await req("/api/admin/funding/custody", { method: "POST", body: JSON.stringify({ fundingKey: "k", ...extra }) })).status).toBe(400);
    }
    expect(await r.db.AttributionRecovery.countDocuments()).toBe(0);
  });

  test("disabled workflows refuse (safe defaults) and the attempt is audited", async () => {
    const r = await rig();
    const { req } = api(r);
    const c = await req("/api/admin/funding/custody", { method: "POST", body: JSON.stringify({ fundingKey: "k" }) });
    expect(c.status).toBe(409);
    expect(((await c.json()) as any).code).toBe("custody_disabled");
    const rr = await req("/api/admin/funding/attributions/recover", { method: "POST", body: JSON.stringify({ attributionKey: "k" }) });
    expect(rr.status).toBe(409);
    expect(((await rr.json()) as any).failureReason).toContain("recovery_disabled");
    expect(await r.db.AttributionRecovery.countDocuments({ operator: admin.publicKey.toBase58() })).toBe(1);
    expect(await r.db.ConfigAudit.countDocuments({ action: "attribution_recovery" })).toBe(1);
  });

  test("wallet verification and the funding pipeline never contain key material", async () => {
    const r = await rig();
    await r.worker.publishSignerStatus();
    const { req } = api(r);
    const secret = bs58.encode(r.payer.secretKey);
    const w = await req("/api/admin/payout-wallet");
    const wt = await w.text();
    expect(w.status).toBe(200);
    expect(JSON.parse(wt)).toMatchObject({ address: r.payer.publicKey.toBase58(), signerMatchesAddress: true, signer: { configured: true, code: "ok" } });
    const f = await req("/api/admin/funding");
    const ft = await f.text();
    expect(f.status).toBe(200);
    expect(JSON.parse(ft)).toMatchObject({ features: { custodyEnabled: false, recoveryEnabled: false }, pipeline: { payoutWallet: r.payer.publicKey.toBase58() } });
    const cfg = await (await req("/api/admin/config")).text();
    for (const t of [wt, ft, cfg]) {
      expect(t.includes(secret)).toBe(false);
      expect(t.includes(secret.slice(0, 20))).toBe(false);
      expect(t.includes(JSON.stringify([...r.payer.secretKey]))).toBe(false);
    }
  });
});
