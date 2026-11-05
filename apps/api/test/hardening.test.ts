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

describe("U6 — admin sign-in domain, SIWS and connection limits", () => {
  const json = { "content-type": "application/json" };
  function adminApp(r: Rig, cfgPatch: (c: any) => any = (c) => c, extra: Record<string, unknown> = {}) {
    const admin = Keypair.generate();
    const data = new PublicData(r.db, r.cfg, r.settings, () => r.clock.now());
    const auth = new AdminAuth(r.db, { appName: "LAST60", adminWallets: [admin.publicKey.toBase58()], secret: "z".repeat(40), ttlSeconds: 600 });
    const cfg = cfgPatch({ ...r.cfg, api: { ...r.cfg.api } });
    return { admin, app: createApp({ db: r.db, cfg, settings: r.settings, data, hub: new StreamHub(data, 60_000), auth, rpc: r.chain, now: () => r.clock.now(), ...extra }) };
  }
  const nonce = async (app: any, wallet: string, headers: Record<string, string> = {}) => app.request("/api/admin/auth/nonce", { method: "POST", body: JSON.stringify({ wallet }), headers: { ...json, ...headers } });

  test("production without PUBLIC_SITE_URL / CORS_ORIGINS is a configuration error for the API", async () => {
    const { loadConfig, ConfigError } = await import("@last60/engine");
    const base = { NODE_ENV: "production", SOLANA_CLUSTER: "mainnet-beta", SOLANA_RPC_URL: "https://rpc.example.org", MONGODB_URI: "mongodb://x", ADMIN_WALLETS: Keypair.generate().publicKey.toBase58(), ADMIN_SESSION_SECRET: "s".repeat(40) };
    let err: any = null;
    try {
      loadConfig("api", base);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect(String(err.message)).toContain("PUBLIC_SITE_URL");
    expect(String(err.message)).toContain("CORS_ORIGINS");
    expect(() => loadConfig("api", { ...base, PUBLIC_SITE_URL: "https://last60.io", CORS_ORIGINS: "https://last60.io" })).not.toThrow();
  });

  test("the Host header is never used for the sign-in domain; production without PUBLIC_SITE_URL refuses to issue challenges", async () => {
    const r = await rig();
    const dev = adminApp(r);
    const n = (await (await nonce(dev.app, dev.admin.publicKey.toBase58(), { host: "evil.example", origin: "https://evil.example" })).json()) as any;
    expect(n.message.startsWith("localhost wants you to sign in with your Solana account:")).toBe(true);
    expect(n.message).not.toContain("evil.example");
    const prod = adminApp(r, (c) => ({ ...c, nodeEnv: "production", api: { ...c.api, publicSiteUrl: null } }));
    expect((await nonce(prod.app, prod.admin.publicKey.toBase58(), { origin: "https://evil.example" })).status).toBe(503);
  });

  test("SIWS challenge: bound to PUBLIC_SITE_URL; a signIn message with any altered field is rejected; a matching one is accepted", async () => {
    const r = await rig();
    const { app, admin } = adminApp(r, (c) => ({ ...c, api: { ...c.api, publicSiteUrl: "https://last60.io" } }));
    const n = (await (await nonce(app, admin.publicKey.toBase58())).json()) as any;
    expect(n.signInInput.domain).toBe("last60.io");
    expect(n.signInInput.uri).toBe("https://last60.io");
    const { parseSiws, siwsMessage } = await import("../src/auth");
    expect(parseSiws(n.message)).toEqual(n.signInInput);
    const sign = (m: string) => bs58.encode(ed25519.sign(new TextEncoder().encode(m), admin.secretKey.slice(0, 32)));
    const phished = siwsMessage({ ...n.signInInput, domain: "evil.example" });
    const bad = await app.request("/api/admin/auth/verify", { method: "POST", headers: json, body: JSON.stringify({ wallet: admin.publicKey.toBase58(), nonce: n.nonce, signature: sign(phished), signedMessage: phished }) });
    expect(bad.status).toBe(401);
    const n2 = (await (await nonce(app, admin.publicKey.toBase58())).json()) as any;
    const good = await app.request("/api/admin/auth/verify", { method: "POST", headers: json, body: JSON.stringify({ wallet: admin.publicKey.toBase58(), nonce: n2.nonce, signature: sign(n2.message), signedMessage: n2.message }) });
    expect(good.status).toBe(200);
  });

  test("a browser verify request from another origin is refused (phishing relay)", async () => {
    const r = await rig();
    const { app, admin } = adminApp(r, (c) => ({ ...c, api: { ...c.api, publicSiteUrl: "https://last60.io" } }));
    const n = (await (await nonce(app, admin.publicKey.toBase58())).json()) as any;
    const sig = bs58.encode(ed25519.sign(new TextEncoder().encode(n.message), admin.secretKey.slice(0, 32)));
    const res = await app.request("/api/admin/auth/verify", { method: "POST", headers: { ...json, origin: "https://last60-airdrop.example" }, body: JSON.stringify({ wallet: admin.publicKey.toBase58(), nonce: n.nonce, signature: sig }) });
    expect(res.status).toBe(403);
  });

  test("SSE connections are capped per client address", async () => {
    const r = await rig();
    const { app } = adminApp(r, (c) => c, { sseLimits: { perIp: 1, total: 10, maxLifetimeMs: 60_000 } });
    const first = await app.request("/api/v1/stream", { headers: { "x-forwarded-for": "1.1.1.1" } });
    expect(first.status).toBe(200);
    const reader = first.body!.getReader();
    await reader.read(); // the initial snapshot has been computed and written
    const second = await app.request("/api/v1/stream");
    expect(second.status).toBe(429);
    await reader.cancel();
    await new Promise((res) => setTimeout(res, 50));
  });
});

describe("U8 — CORS", () => {
  test("empty CORS_ORIGINS never reflects arbitrary origins; development allows loopback only; production allows none", async () => {
    const r = await rig();
    const { corsOrigin } = await import("../src/app");
    const dev = { ...r.cfg, nodeEnv: "development" as const, api: { ...r.cfg.api, corsOrigins: [] } };
    expect(corsOrigin(dev, "https://evil.example")).toBeNull();
    expect(corsOrigin(dev, "http://localhost:3000")).toBe("http://localhost:3000");
    const prod = { ...dev, nodeEnv: "production" as const };
    expect(corsOrigin(prod, "http://localhost:3000")).toBeNull();
    const listed = { ...prod, api: { ...prod.api, corsOrigins: ["https://last60.io"] } };
    expect(corsOrigin(listed, "https://last60.io")).toBe("https://last60.io");
    expect(corsOrigin(listed, "https://evil.example")).toBeNull();
    const { app } = api(r);
    const res = await app.request("/api/v1/countdown", { headers: { origin: "https://evil.example" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
