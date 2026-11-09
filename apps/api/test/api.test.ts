import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { Indexer, PublicData } from "@last60/engine";
import { createApp } from "../src/app";
import { AdminAuth } from "../src/auth";
import { StreamHub } from "../src/stream";
import { rig, SOL, startDb, stopDb, T0, wallet, type Rig } from "../../../packages/engine/test/harness";

beforeAll(startDb, 120_000);
afterAll(stopDb);

const admin = Keypair.generate();

function api(r: Rig) {
  const data = new PublicData(r.db, r.cfg, r.settings, () => r.clock.now());
  const hub = new StreamHub(data, 60_000);
  const auth = new AdminAuth(r.db, { appName: "LAST60", adminWallets: [admin.publicKey.toBase58()], secret: "x".repeat(40), ttlSeconds: 600 });
  return { app: createApp({ db: r.db, cfg: r.cfg, settings: r.settings, data, hub, auth, rpc: r.chain, now: () => r.clock.now() }), hub, auth };
}

const PUBLIC = ["/api/v1/health", "/api/v1/round/current", "/api/v1/countdown", "/api/v1/pool", "/api/v1/buys/recent", "/api/v1/rounds", "/api/v1/rounds/1", "/api/v1/payouts", "/api/v1/stats", "/api/v1/chart", "/api/v1/terminal", "/api/v1/dashboard"];

async function scheduledRound(r: Rig) {
  await r.worker.scheduler.tick(r.clock.now());
  for (let i = 0; i < 3; i++) r.trade({ trader: wallet(), quote: SOL });
  const idx = new Indexer({ db: r.db, cfg: r.cfg, settings: r.settings, rpc: r.chain, wsFactory: null });
  await idx.init();
  await idx.pollOnce();
  r.clock.set(T0 + 240_000);
  await r.worker.scheduler.tick(r.clock.now()); // execute time drawn and sealed
  const at = await r.worker.scheduler.ensureExecuteAt((await r.db.Round.findOne({ roundNumber: 1 }).lean() as any).roundIndex, r.clock.now());
  return at!;
}

describe("public API privacy", () => {
  test("no public response ever contains the scheduled execution time or scheduler state", async () => {
    const r = await rig({ random: () => 37_123 }); // distinctive delay so a leak cannot hide in other numbers
    const executeAt = await scheduledRound(r);
    expect(executeAt).toBe(T0 + 240_000 + 37_123);
    const { app } = api(r);
    const numbers = [executeAt, Math.floor(executeAt / 1000), 37_123, 37.123].map((n) => new RegExp(`(?<![0-9])${String(n).replace(".", "\\.")}(?![0-9])`));
    const words = [new Date(executeAt).toISOString(), new Date(Math.floor(executeAt / 1000) * 1000).toISOString(), "executeAt", "Cipher", "scheduleGenerated", "\"lock\"", "delay"];
    const check = async (phase: string) => {
      for (const path of PUBLIC) {
        const body = await (await app.request(path)).text();
        for (const re of numbers) expect({ phase, path, leaked: re.test(body) ? re.source : null }).toEqual({ phase, path, leaked: null });
        for (const w of words) expect({ phase, path, leaked: body.includes(w) ? w : null }).toEqual({ phase, path, leaked: null });
      }
    };
    await check("final window, before execution");
    const cur = await (await app.request("/api/v1/round/current")).json() as any;
    expect(cur.phase).toBe("final_minute");
    expect(cur.qualifyingBuyers).toBe(3);
    r.clock.set(executeAt);
    await r.worker.scheduler.tick(r.clock.now());
    await r.worker.payouts.processDue();
    r.clock.set(r.clock.now() + 6_000); // settlement happens after confirmations
    r.chain.advance(40);
    await r.worker.payouts.processDue();
    r.clock.set(r.clock.now() + 4_321);
    await check("after settlement");
  });

  test("current round, pool and history reflect real engine state", async () => {
    const r = await rig();
    const at = await scheduledRound(r);
    r.clock.set(at);
    await r.worker.scheduler.tick(r.clock.now());
    await r.worker.payouts.processDue();
    r.chain.advance(40);
    await r.worker.payouts.processDue();
    const { app } = api(r);
    const round = await (await app.request("/api/v1/rounds/1")).json() as any;
    expect(round.phase).toBe("settled");
    expect(round.recipientCount).toBe(3);
    expect(round.payouts.every((p: any) => p.state === "confirmed" && typeof p.signature === "string")).toBe(true);
    const stats = await (await app.request("/api/v1/stats")).json() as any;
    expect(BigInt(stats.totalPaid)).toBe(BigInt(round.perRecipient) * 3n);
    expect(stats.uniqueRecipients).toBe(3);
    const term = await (await app.request("/api/v1/terminal?limit=200")).json() as any;
    expect(term.items.some((e: any) => e.type === "CONFIRMED")).toBe(true);
    expect((await app.request("/api/v1/rounds/999")).status).toBe(404);
  });
});

describe("admin API", () => {
  async function login(app: ReturnType<typeof api>["app"], kp = admin) {
    const n = await (await app.request("/api/admin/auth/nonce", { method: "POST", body: JSON.stringify({ wallet: kp.publicKey.toBase58() }), headers: { "content-type": "application/json" } })).json() as any;
    const sig = ed25519.sign(new TextEncoder().encode(n.message), kp.secretKey.slice(0, 32));
    const v = await app.request("/api/admin/auth/verify", { method: "POST", body: JSON.stringify({ wallet: kp.publicKey.toBase58(), nonce: n.nonce, signature: bs58.encode(sig) }), headers: { "content-type": "application/json" } });
    return { res: v, body: await v.json() as any, nonce: n.nonce, sig: bs58.encode(sig) };
  }

  test("wallet-signature login; nonces are single use; non-admins and forged signatures are rejected", async () => {
    const r = await rig();
    const { app } = api(r);
    const ok = await login(app);
    expect(ok.res.status).toBe(200);
    expect(typeof ok.body.token).toBe("string");
    // replay of the same nonce + signature fails
    const replay = await app.request("/api/admin/auth/verify", { method: "POST", body: JSON.stringify({ wallet: admin.publicKey.toBase58(), nonce: ok.nonce, signature: ok.sig }), headers: { "content-type": "application/json" } });
    expect(replay.status).toBe(401);
    // a non-admin wallet cannot even get a nonce
    const stranger = await app.request("/api/admin/auth/nonce", { method: "POST", body: JSON.stringify({ wallet: wallet() }), headers: { "content-type": "application/json" } });
    expect(stranger.status).toBe(403);
    // forged signature (signed by another key)
    const n = await (await app.request("/api/admin/auth/nonce", { method: "POST", body: JSON.stringify({ wallet: admin.publicKey.toBase58() }), headers: { "content-type": "application/json" } })).json() as any;
    const forged = ed25519.sign(new TextEncoder().encode(n.message), Keypair.generate().secretKey.slice(0, 32));
    const bad = await app.request("/api/admin/auth/verify", { method: "POST", body: JSON.stringify({ wallet: admin.publicKey.toBase58(), nonce: n.nonce, signature: bs58.encode(forged) }), headers: { "content-type": "application/json" } });
    expect(bad.status).toBe(401);
    // no token / tampered token
    expect((await app.request("/api/admin/config")).status).toBe(401);
    expect((await app.request("/api/admin/config", { headers: { authorization: `Bearer ${ok.body.token}x` } })).status).toBe(401);
  });

  test("config changes are validated, require confirmation for critical keys, and are audited", async () => {
    const r = await rig();
    const { app } = api(r);
    const { body } = await login(app);
    const H = { authorization: `Bearer ${body.token}`, "content-type": "application/json" };
    const cfg = await (await app.request("/api/admin/config", { headers: H })).json() as any;
    expect(cfg.effective.buyerCount).toBe(5);
    expect(JSON.stringify(cfg)).not.toMatch(/"(privateKey|secretKey)"/);
    const put = (patch: unknown, extra: Record<string, unknown> = {}) => app.request("/api/admin/config", { method: "PUT", headers: H, body: JSON.stringify({ patch, expectedVersion: cfg.version, ...extra }) });
    expect((await put({ buyerCount: 0 })).status).toBe(400);
    expect((await put({ rewardBps: 8000 })).status).toBe(400); // critical without confirmation
    const ok = await put({ rewardBps: 8000, buyerCount: 3 }, { confirmCritical: true, reason: "governance vote #12" });
    expect(ok.status).toBe(200);
    expect((await ok.json() as any).effective.rewardBps).toBe(8000);
    expect((await put({ buyerCount: 4 })).status).toBe(409); // stale version
    const audit = await (await app.request("/api/admin/audit", { headers: H })).json() as any;
    expect(audit[0].actor).toBe(admin.publicKey.toBase58());
    expect(audit[0].reason).toBe("governance vote #12");
    expect(audit[0].changes.map((c: any) => c.key).sort()).toEqual(["buyerCount", "rewardBps"]);
    // pause / resume is audited too
    expect((await app.request("/api/admin/workers/payouts/pause", { method: "POST", headers: H })).status).toBe(200);
    expect((await r.settings.get(true)).pausePayouts).toBe(true);
    expect((await app.request("/api/admin/workers/payouts/resume", { method: "POST", headers: H })).status).toBe(200);
    expect((await r.settings.get(true)).pausePayouts).toBe(false);
  });

  test("the public cannot reach admin routes or change configuration", async () => {
    const r = await rig();
    const { app } = api(r);
    for (const [m, p] of [["GET", "/api/admin/config"], ["PUT", "/api/admin/config"], ["GET", "/api/admin/status"], ["POST", "/api/admin/halt/clear"], ["POST", "/api/admin/workers/payouts/pause"]] as const) {
      expect((await app.request(p, { method: m, body: m === "GET" ? undefined : "{}", headers: { "content-type": "application/json" } })).status).toBe(401);
    }
  });
});

describe("stream", () => {
  test("SSE delivers an initial snapshot and live terminal events", async () => {
    const r = await rig();
    await r.worker.scheduler.tick(r.clock.now());
    const { app, hub } = api(r);
    await hub.start();
    const res = await app.request("/api/v1/stream");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (!buf.includes("event: snapshot")) buf += dec.decode((await reader.read()).value);
    await r.worker.terminal.system("hello from the engine", "test-hello");
    await hub.tickTerminal();
    while (!buf.includes("hello from the engine")) buf += dec.decode((await reader.read()).value);
    expect(buf).toContain("event: terminal");
    await reader.cancel();
    hub.stop();
  });
});

describe("admin wallets & launch (docs/WALLETS.md)", () => {
  test("generate a creator wallet, export it end-to-end encrypted, derive the pool — the API never returns key material in the clear", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { fulfilWalletRequests, fulfilExportRequests, loadVaultKeypair, deriveLaunchLabPool } = await import("@last60/engine");
    const { exportIntentMessage, newExportRequest, openExport } = await import("@last60/shared");
    const r = await rig({ env: { LAST60_WALLET_VAULT_KEY_PATH: join(mkdtempSync(join(tmpdir(), "l60api-")), "k"), ADMIN_WALLETS: admin.publicKey.toBase58() } });
    const { app } = api(r);
    const n = await (await app.request("/api/admin/auth/nonce", { method: "POST", body: JSON.stringify({ wallet: admin.publicKey.toBase58() }), headers: { "content-type": "application/json" } })).json() as any;
    const v = await (await app.request("/api/admin/auth/verify", { method: "POST", body: JSON.stringify({ wallet: admin.publicKey.toBase58(), nonce: n.nonce, signature: bs58.encode(ed25519.sign(new TextEncoder().encode(n.message), admin.secretKey.slice(0, 32))) }), headers: { "content-type": "application/json" } })).json() as any;
    const H = { authorization: `Bearer ${v.token}`, "content-type": "application/json" };
    expect((await app.request("/api/admin/wallets")).status).toBe(401);
    const w0 = await (await app.request("/api/admin/wallets", { headers: H })).json() as any;
    expect(w0.wallets.creator).toMatchObject({ address: null, source: null, vault: null });
    expect(w0.wallets.payout.source).toBe("env");
    // The payout wallet of this rig is configured in the environment: never shadowed by a generated one.
    expect((await app.request("/api/admin/wallets/payout/generate", { method: "POST", headers: H, body: "{}" })).status).toBe(409);
    expect((await (await app.request("/api/admin/wallets/creator/generate", { method: "POST", headers: H, body: JSON.stringify({ reason: "launch" }) })).json() as any).status).toBe("requested");
    await fulfilWalletRequests(r.db, r.cfg); // the rewards worker's pass
    const w1 = await (await app.request("/api/admin/wallets", { headers: H })).json() as any;
    const address = w1.wallets.creator.address;
    expect(w1.wallets.creator).toMatchObject({ source: "vault", pendingRestart: true, vault: { status: "active", exports: 0 } });
    // Export: the browser's one-time key, signed by the admin wallet; the API relays ciphertext only.
    const req = newExportRequest();
    const message = exportIntentMessage({ site: w1.site, role: "creator", address, requestId: req.requestId, browserKey: req.browserKey, expiresAt: new Date(r.clock.now() + 120_000).toISOString() });
    const signature = bs58.encode(ed25519.sign(new TextEncoder().encode(message), admin.secretKey.slice(0, 32)));
    const e = await app.request("/api/admin/wallets/creator/export", { method: "POST", headers: H, body: JSON.stringify({ requestId: req.requestId, message, signature }) });
    expect(await e.json() as any).toMatchObject({ accepted: true });
    expect((await (await app.request(`/api/admin/wallets/exports/${req.requestId}`, { headers: H })).json() as any).status).toBe("pending");
    await fulfilExportRequests(r.db, r.cfg, { now: r.clock.now() });
    const t = await (await app.request(`/api/admin/wallets/exports/${req.requestId}`, { headers: H })).json() as any;
    expect(t.status).toBe("ready");
    const kp = (await loadVaultKeypair(r.db, r.cfg, "creator"))!;
    expect(JSON.stringify(t).includes(bs58.encode(kp.secretKey))).toBe(false);
    expect(Buffer.from(await openExport(req.secret, t.sealed, req.requestId)).equals(Buffer.from(kp.secretKey))).toBe(true);
    expect((await (await app.request(`/api/admin/wallets/exports/${req.requestId}`, { headers: H })).json() as any).status).toBe("consumed");
    // Every wallet action is audited.
    const actions = (await r.db.ConfigAudit.find({ action: /^wallet_/ }).lean()).map((a: any) => a.action).sort();
    expect(actions).toEqual(["wallet_export_delivered", "wallet_export_request", "wallet_generate"]);
    // Pool derivation for a token known before launch.
    const mint = Keypair.generate().publicKey.toBase58();
    expect(await (await app.request(`/api/admin/launch/derive?mint=${mint}`, { headers: H })).json()).toMatchObject({ tokenMint: mint, poolAddress: deriveLaunchLabPool(mint), poolExists: false });
    expect((await app.request(`/api/admin/launch/derive?mint=nope-nope-nope-nope-nope-nope-nope`, { headers: H })).status).toBe(400);
    expect((await app.request("/api/admin/launch", { headers: H })).status).toBe(200);
  });
});
