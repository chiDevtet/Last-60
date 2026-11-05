/**
 * API hardening regressions from the production-readiness audit (see docs/AUDIT.md).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { PublicData } from "@last60/engine";
import { createApp } from "../src/app";
import { AdminAuth } from "../src/auth";
import { StreamHub } from "../src/stream";
import { rig, startDb, stopDb, type Rig } from "../../../packages/engine/test/harness";

beforeAll(startDb, 120_000);
afterAll(stopDb);

function api(r: Rig, trustProxyHops?: number) {
  const data = new PublicData(r.db, r.cfg, r.settings, () => r.clock.now());
  const hub = new StreamHub(data, 60_000);
  const auth = new AdminAuth(r.db, { appName: "LAST60", adminWallets: [Keypair.generate().publicKey.toBase58()], secret: "x".repeat(40), ttlSeconds: 600 });
  const cfg = trustProxyHops === undefined ? r.cfg : { ...r.cfg, api: { ...r.cfg.api, trustProxyHops } };
  return { app: createApp({ db: r.db, cfg, settings: r.settings, data, hub, auth, rpc: r.chain, now: () => r.clock.now() }), data };
}

describe("rate limiting and proxy trust", () => {
  test("a client cannot escape the per-IP rate limit by spoofing X-Forwarded-For", async () => {
    const r = await rig();
    const { app } = api(r);
    let limited = 0;
    for (let i = 0; i < 90; i++) {
      const res = await app.request("/api/v1/countdown", { headers: { "x-forwarded-for": `10.0.${i >> 8}.${i & 255}` } });
      if (res.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });

  test("behind N trusted proxies the client address is the Nth entry from the right, not the client-supplied left one", async () => {
    const r = await rig();
    const { app } = api(r, 1);
    let limited = 0;
    for (let i = 0; i < 90; i++) {
      // The client forges the left-most entry; the trusted proxy appends the real address (203.0.113.7).
      const res = await app.request("/api/v1/countdown", { headers: { "x-forwarded-for": `198.51.100.${i & 255}, 203.0.113.7` } });
      if (res.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });
});

describe("public query parameters", () => {
  test("arbitrary limit values neither error nor grow the response cache without bound", async () => {
    const r = await rig();
    const { app, data } = api(r);
    expect((await app.request("/api/v1/buys/recent?limit=abc")).status).toBe(200);
    expect((await app.request("/api/v1/chart?limit=-4")).status).toBe(200);
    for (let i = 0; i < 40; i++) await app.request(`/api/v1/buys/recent?limit=${1 + i / 1000}`, { headers: { "x-forwarded-for": `10.9.0.${i}` } });
    expect((data as any).cache.size).toBeLessThan(10);
  });
});

describe("critical settings", () => {
  test("changing RPC endpoints requires explicit confirmation and a reason (a hostile RPC can fake swaps and expiries)", async () => {
    const r = await rig();
    const admin = Keypair.generate();
    const data = new PublicData(r.db, r.cfg, r.settings, () => r.clock.now());
    const auth = new AdminAuth(r.db, { appName: "LAST60", adminWallets: [admin.publicKey.toBase58()], secret: "y".repeat(40), ttlSeconds: 600 });
    const app = createApp({ db: r.db, cfg: r.cfg, settings: r.settings, data, hub: new StreamHub(data, 60_000), auth, rpc: r.chain, now: () => r.clock.now() });
    const json = { "content-type": "application/json" };
    const n = (await (await app.request("/api/admin/auth/nonce", { method: "POST", body: JSON.stringify({ wallet: admin.publicKey.toBase58() }), headers: json })).json()) as any;
    const sig = bs58.encode(ed25519.sign(new TextEncoder().encode(n.message), admin.secretKey.slice(0, 32)));
    const { token } = (await (await app.request("/api/admin/auth/verify", { method: "POST", body: JSON.stringify({ wallet: admin.publicKey.toBase58(), nonce: n.nonce, signature: sig }), headers: json })).json()) as any;
    const headers = { ...json, authorization: `Bearer ${token}` };
    const version = (await r.settings.raw()).version;
    const unconfirmed = await app.request("/api/admin/config", { method: "PUT", headers, body: JSON.stringify({ patch: { rpcUrls: ["https://rpc.attacker.example"] }, expectedVersion: version }) });
    expect(unconfirmed.status).toBe(400);
    const confirmed = await app.request("/api/admin/config", { method: "PUT", headers, body: JSON.stringify({ patch: { rpcUrls: ["https://rpc.example.org"] }, expectedVersion: version, confirmCritical: true, reason: "provider migration" }) });
    expect(confirmed.status).toBe(200);
  });
});
