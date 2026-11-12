/**
 * HTTP API. Public routes are read-only and served exclusively from PublicData DTO builders.
 * Admin routes require a wallet-signed session and every mutation is validated and audited.
 */
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { getConnInfo } from "hono/bun";
import { z } from "zod";
import {
  jsonSafe,
  PublicData,
  redactConfig,
  requeueFailedPayout,
  SettingsConflictError,
  SettingsStore,
  SettingsValidationError,
  CRITICAL_KEYS,
  buildFundingPipeline,
  cancelCustodyRequest,
  createCustodyRequest,
  CustodyError,
  payoutWalletVerification,
  recoverAttribution,
  RecoveryError,
  revenueRuntimeOf,
  submitCustodySignature,
  createExportRequest,
  deriveLaunchLabPool,
  derivePumpBondingCurve,
  discoverDbcPool,
  type DbcDiscovery,
  requestWalletGeneration,
  requestImportKey,
  requestWalletImport,
  takeExport,
  VaultError,
  walletsStatus,
  retireWallet,
  type AppConfig,
  type Models,
  type ChainRpc,
  type LaunchProvider,
} from "@last60/engine";
import type { HealthDTO } from "@last60/shared";
import { AdminAuth, AuthError } from "./auth";
import { StreamHub } from "./stream";

export interface ApiDeps {
  db: Models;
  cfg: AppConfig;
  settings: SettingsStore;
  data: PublicData;
  hub: StreamHub;
  auth: AdminAuth;
  rpc?: ChainRpc | null;
  /** Loads the configured launch (with its verified destination) for operator recovery; lazy. */
  providerFor?: () => Promise<LaunchProvider>;
  now?: () => number;
  sseLimits?: { perIp: number; total: number; maxLifetimeMs: number };
}

type Env = { Variables: { admin: string } };

/** Tiny per-IP token bucket. */
function rateLimiter(rps: number, burst: number) {
  const buckets = new Map<string, { t: number; tokens: number }>();
  return (ip: string) => {
    const now = Date.now();
    const b = buckets.get(ip) ?? { t: now, tokens: burst };
    b.tokens = Math.min(burst, b.tokens + ((now - b.t) / 1000) * rps);
    b.t = now;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    buckets.set(ip, b);
    if (buckets.size > 50_000) buckets.clear();
    return ok;
  };
}

/**
 * Client address for rate limiting and audit records.
 *
 * X-Forwarded-For is client-controlled except for the entries appended by proxies WE run: with
 * `trustProxyHops = N` the client is the Nth entry from the right (nginx `$proxy_add_x_forwarded_for`
 * appends exactly one). With 0 trusted hops forwarding headers are ignored and the socket peer is
 * used. (Trusting the left-most entry let any client pick a fresh rate-limit bucket per request.)
 */
export function clientIp(c: Context, trustProxyHops: number): string {
  if (trustProxyHops > 0) {
    const chain = (c.req.header("x-forwarded-for") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    if (chain.length >= trustProxyHops) return chain[chain.length - trustProxyHops]!;
    const real = c.req.header("x-real-ip")?.trim();
    if (real) return real;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown"; // no socket information (e.g. in-process requests in tests)
  }
}

/** Parse a positive integer query parameter, clamped to [1, max]; anything else → `def`. */
export function intParam(v: string | undefined, def: number, max: number): number {
  if (v === undefined || !/^\d{1,9}$/.test(v)) return def;
  const n = Number(v);
  return n >= 1 ? Math.min(n, max) : def;
}

function safeHost(u: string): string | null {
  try {
    return new URL(u).host;
  } catch {
    return null;
  }
}

/**
 * The site admin sign-in messages are bound to. Production: PUBLIC_SITE_URL only (enforced at
 * config load; never a request header). Development/test without PUBLIC_SITE_URL: an explicit local
 * default — the request Origin only when it is a loopback address or an allow-listed CORS origin,
 * otherwise "localhost". The Host header is never used.
 */
export function signInSite(cfg: AppConfig, origin: string | undefined): { host: string; origin: string } | null {
  if (cfg.api.publicSiteUrl) {
    const u = new URL(cfg.api.publicSiteUrl);
    return { host: u.host, origin: u.origin };
  }
  if (cfg.nodeEnv === "production") return null;
  if (origin) {
    try {
      const u = new URL(origin);
      if (["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) || cfg.api.corsOrigins.includes(u.origin)) return { host: u.host, origin: u.origin };
    } catch {
      /* fall through */
    }
  }
  return { host: "localhost", origin: "http://localhost" };
}

/**
 * CORS policy. With CORS_ORIGINS set, only those origins are allowed. Empty: production allows NO
 * cross-origin requests (and config load requires CORS_ORIGINS in production anyway); development
 * and tests allow loopback origins only. Arbitrary origins are never reflected.
 */
export function corsOrigin(cfg: AppConfig, origin: string): string | null {
  if (cfg.api.corsOrigins.length) return cfg.api.corsOrigins.includes(origin) ? origin : null;
  if (cfg.nodeEnv === "production") return null;
  try {
    const u = new URL(origin);
    return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) ? origin : null;
  } catch {
    return null;
  }
}

/** SSE connection limits: per client address and in total, plus a maximum connection lifetime. */
export const SSE_LIMITS = { perIp: 4, total: 5_000, maxLifetimeMs: 30 * 60_000 };

export function createApp(d: ApiDeps) {
  const app = new Hono<Env>();
  const now = d.now ?? (() => Date.now());
  const publicLimit = rateLimiter(20, 60);
  const adminLimit = rateLimiter(3, 20);
  const hops = d.cfg.api.trustProxyHops ?? 0;
  const ipOf = (c: Context) => clientIp(c, hops);

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
  });
  app.use(
    "/api/*",
    cors({
      origin: (origin) => corsOrigin(d.cfg, origin),
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
      maxAge: 600,
    }),
  );
  app.use("/api/v1/*", async (c, next) => {
    if (!publicLimit(ipOf(c))) return c.json({ error: "rate limited" }, 429);
    await next();
  });
  app.onError((err, c) => {
    if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
    if (err instanceof CustodyError) return c.json({ error: err.message, code: err.code }, 409);
    if (err instanceof RecoveryError) return c.json({ error: err.message, code: err.code }, 400);
    if (err instanceof VaultError) return c.json({ error: err.message, code: err.code }, 409);
    if (err instanceof z.ZodError) return c.json({ error: "invalid request", issues: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, 400);
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  // ── public ──────────────────────────────────────────────────────────────────
  app.get("/api/v1/health", async (c) => c.json(await health(d, now())));
  app.get("/api/v1/round/current", async (c) => c.json(await d.data.currentRound()));
  app.get("/api/v1/countdown", async (c) => {
    const r = await d.data.currentRound();
    return c.json({ roundNumber: r.roundNumber, endsAt: r.endsAt, finalWindowStartsAt: r.finalWindowStartsAt, serverTime: r.serverTime, phase: r.phase });
  });
  app.get("/api/v1/pool", async (c) => c.json(await d.data.rewardPool()));
  app.get("/api/v1/buys/recent", async (c) => c.json(await d.data.recentBuys(intParam(c.req.query("limit"), 30, 100))));
  app.get("/api/v1/rounds", async (c) => {
    const cursor = c.req.query("cursor");
    if (cursor !== undefined && !/^\d{1,9}$/.test(cursor)) return c.json({ error: "invalid cursor" }, 400);
    return c.json(await d.data.rounds({ before: cursor ? Number(cursor) : undefined, limit: intParam(c.req.query("limit"), 20, 100) }));
  });
  app.get("/api/v1/rounds/:n", async (c) => {
    const n = Number(c.req.param("n"));
    if (!Number.isInteger(n) || n < 1) return c.json({ error: "invalid round" }, 400);
    const r = await d.data.round(n);
    return r ? c.json(r) : c.json({ error: "round not found or not yet settled" }, 404);
  });
  app.get("/api/v1/payouts", async (c) => {
    const cursor = c.req.query("cursor");
    if (cursor !== undefined && Number.isNaN(new Date(cursor).getTime())) return c.json({ error: "invalid cursor" }, 400);
    return c.json(await d.data.payouts({ before: cursor || undefined, limit: intParam(c.req.query("limit"), 50, 200) }));
  });
  app.get("/api/v1/stats", async (c) => c.json(await d.data.stats()));
  app.get("/api/v1/chart", async (c) => c.json(await d.data.chart(intParam(c.req.query("limit"), 24, 200))));
  app.get("/api/v1/terminal", async (c) => {
    const before = c.req.query("before");
    if (before !== undefined && !/^\d{1,15}$/.test(before)) return c.json({ error: "invalid cursor" }, 400);
    return c.json(await d.data.terminal({ before: before ? Number(before) : undefined, limit: intParam(c.req.query("limit"), 50, 200) }));
  });
  app.get("/api/v1/dashboard", async (c) => c.json(await d.data.dashboard()));
  const sse = { total: 0, byIp: new Map<string, number>() };
  app.get("/api/v1/stream", (c) => {
    const ip = ipOf(c);
    const limits = d.sseLimits ?? SSE_LIMITS;
    if (sse.total >= limits.total || (sse.byIp.get(ip) ?? 0) >= limits.perIp) return c.json({ error: "too many live connections" }, 429);
    sse.total++;
    sse.byIp.set(ip, (sse.byIp.get(ip) ?? 0) + 1);
    const release = () => {
      sse.total--;
      const n = (sse.byIp.get(ip) ?? 1) - 1;
      if (n <= 0) sse.byIp.delete(ip);
      else sse.byIp.set(ip, n);
    };
    // Bun: this connection is long-lived but never idle (heartbeats every 15 s); allow 60 s of silence.
    (c.env as any)?.timeout?.(c.req.raw, 60);
    const openedAt = Date.now();
    return streamSSE(c, async (stream) => {
      try {
        const queue: { event: string; data: string }[] = [];
        let wake: (() => void) | null = null;
        const push = (event: string, data: unknown) => {
          if (queue.length > 500) queue.shift(); // slow client: drop oldest
          queue.push({ event, data: JSON.stringify(data) });
          wake?.();
        };
        const snap = d.hub.latest() ?? (await d.data.dashboard());
        push("snapshot", snap);
        const unsubscribe = d.hub.subscribe(push);
        stream.onAbort(() => {
          unsubscribe();
          wake?.();
        });
        while (!stream.aborted && Date.now() - openedAt < limits.maxLifetimeMs) {
          while (queue.length) {
            const m = queue.shift()!;
            await stream.writeSSE({ event: m.event, data: m.data });
          }
          await new Promise<void>((r) => {
            wake = r;
            setTimeout(r, Math.min(20_000, limits.maxLifetimeMs));
          });
          wake = null;
        }
        unsubscribe();
      } finally {
        release(); // EventSource reconnects automatically after a lifetime close
      }
    });
  });

  // ── admin ───────────────────────────────────────────────────────────────────
  const admin = new Hono<Env>();
  admin.use("*", async (c, next) => {
    if (!adminLimit(ipOf(c))) return c.json({ error: "rate limited" }, 429);
    await next();
  });
  admin.post("/auth/nonce", async (c) => {
    const body = z.object({ wallet: z.string() }).parse(await c.req.json());
    const site = signInSite(d.cfg, c.req.header("origin"));
    if (!site) return c.json({ error: "admin sign-in is unavailable: PUBLIC_SITE_URL is not configured" }, 503);
    return c.json(await d.auth.issueNonce(body.wallet, site.host, { uri: site.origin, chainId: d.cfg.solana.cluster === "mainnet-beta" ? "mainnet" : d.cfg.solana.cluster }));
  });
  admin.post("/auth/verify", async (c) => {
    const body = z.object({ wallet: z.string(), nonce: z.string(), signature: z.string(), signedMessage: z.string().max(2000).optional() }).parse(await c.req.json());
    // A browser always sends Origin on a cross-origin POST: when present it must be the site the
    // challenge was bound to (a phishing page relaying our challenge cannot complete the login).
    const origin = c.req.header("origin");
    const site = signInSite(d.cfg, origin);
    if (origin && site && safeHost(origin) !== site.host) return c.json({ error: "origin does not match the sign-in domain" }, 403);
    return c.json(await d.auth.verify(body.wallet, body.nonce, body.signature, body.signedMessage));
  });
  admin.use("*", async (c, next) => {
    if (c.req.path.endsWith("/auth/nonce") || c.req.path.endsWith("/auth/verify")) return next();
    const who = d.auth.check(c.req.header("authorization"));
    if (!who) return c.json({ error: "unauthorized" }, 401);
    c.set("admin", who);
    await next();
  });
  admin.get("/me", (c) => c.json({ wallet: c.get("admin") }));
  admin.get("/config", async (c) => {
    const raw = await d.settings.raw();
    const eff = await d.settings.get(true);
    return c.json(jsonSafe({ version: raw.version, overrides: raw.overrides, effective: maskSettings(eff), environment: redactConfig(d.cfg), criticalKeys: CRITICAL_KEYS, updatedAt: raw.updatedAt, updatedBy: raw.updatedBy }));
  });
  admin.put("/config", async (c) => {
    const body = z.object({ patch: z.record(z.string(), z.unknown()), reason: z.string().max(500).optional(), expectedVersion: z.number().int(), confirmCritical: z.boolean().optional() }).parse(await c.req.json());
    const critical = Object.keys(body.patch).filter((k) => (CRITICAL_KEYS as string[]).includes(k));
    if (critical.length && (!body.confirmCritical || !body.reason?.trim())) {
      return c.json({ error: `changing ${critical.join(", ")} requires confirmCritical=true and a reason` }, 400);
    }
    try {
      const res = await d.settings.update(body.patch, { actor: c.get("admin"), reason: body.reason, ip: ipOf(c), expectedVersion: body.expectedVersion });
      return c.json(jsonSafe({ ...res, effective: maskSettings(await d.settings.get(true)) }));
    } catch (err) {
      if (err instanceof SettingsValidationError) return c.json({ error: "validation failed", issues: err.problems }, 400);
      if (err instanceof SettingsConflictError) return c.json({ error: err.message, currentVersion: err.currentVersion }, 409);
      throw err;
    }
  });
  admin.get("/audit", async (c) => {
    const rows = await d.db.ConfigAudit.find({}).sort({ at: -1 }).limit(Math.min(Number(c.req.query("limit") ?? 50), 200)).lean();
    return c.json(jsonSafe(rows));
  });
  admin.get("/status", async (c) => {
    const s = await d.settings.get();
    const [workers, halt, poolDoc, recon, failed, awaiting] = await Promise.all([
      d.db.WorkerState.find({ _id: { $not: /^cursor:/ } }).lean(),
      d.db.SystemState.findById("payout_halt").lean(),
      s.poolAddress ? d.db.Pool.findOne({ poolAddress: s.poolAddress }).lean() : null,
      d.db.Reconciliation.find({}).sort({ at: -1 }).limit(10).lean(),
      d.db.Payout.find({ state: "failed" }).limit(50).lean(),
      d.db.Round.countDocuments({ state: "awaiting_funds" }),
    ]);
    let payoutBalance: string | null = null;
    if (d.rpc && s.expectedPayoutPublicKey) payoutBalance = (await d.rpc.getBalance(s.expectedPayoutPublicKey).catch(() => null))?.toString() ?? null;
    return c.json(jsonSafe({ workers, halt: (halt as any)?.value ?? null, pool: poolDoc, reconciliation: recon, failedPayouts: failed, awaitingFundsRounds: awaiting, payoutWallet: { publicKey: s.expectedPayoutPublicKey, balance: payoutBalance, mode: s.payoutMode } }));
  });
  const togglable = { indexer: "pauseIndexer", payouts: "pausePayouts", scheduler: "pauseScheduler" } as const;
  admin.post("/workers/:component/:action", async (c) => {
    const key = togglable[c.req.param("component") as keyof typeof togglable];
    const action = c.req.param("action");
    if (!key || !["pause", "resume"].includes(action)) return c.json({ error: "unknown component/action" }, 400);
    const raw = await d.settings.raw();
    const res = await d.settings.update({ [key]: action === "pause" ? true : null }, { actor: c.get("admin"), reason: `${action} ${c.req.param("component")}`, ip: ipOf(c), expectedVersion: raw.version });
    return c.json(jsonSafe(res));
  });
  admin.post("/payouts/:id/requeue", async (c) => {
    const ok = await requeueFailedPayout(d.db, c.req.param("id"), c.get("admin"));
    await d.db.ConfigAudit.create({ version: (await d.settings.raw()).version, actor: c.get("admin"), action: "requeue_payout", changes: [{ key: "payout", from: "failed", to: ok ? "pending" : "unchanged" }], reason: c.req.param("id"), ip: ipOf(c) });
    return ok ? c.json({ ok }) : c.json({ error: "payout is not in failed state" }, 409);
  });
  admin.post("/halt/clear", async (c) => {
    const body = z.object({ reason: z.string().min(3) }).parse(await c.req.json());
    const prev: any = await d.db.SystemState.findById("payout_halt").lean();
    await d.db.SystemState.deleteOne({ _id: "payout_halt" });
    await d.db.ConfigAudit.create({ version: (await d.settings.raw()).version, actor: c.get("admin"), action: "clear_payout_halt", changes: [{ key: "payout_halt", from: prev?.value ?? null, to: null }], reason: body.reason, ip: ipOf(c) });
    return c.json({ ok: true });
  });
  admin.get("/reconciliation", async (c) => c.json(jsonSafe(await d.db.Reconciliation.find({}).sort({ at: -1 }).limit(100).lean())));
  admin.get("/payouts", async (c) => {
    const state = c.req.query("state");
    const rows = await d.db.Payout.find(state ? { state } : {}).sort({ createdAt: -1 }).limit(100).lean();
    return c.json(jsonSafe(rows));
  });

  // ── dedicated payout wallet, custody and attribution recovery (docs/REWARD_FUNDING.md §14–§16) ──
  // Read-only views never include key material. Mutations take no amount, recipient, eligibility or
  // status from the request: they are derived from the stored contribution and the configured wallet.
  const custodyCfg = () => ({ enabled: d.cfg.revenue.custody.enabled, payoutWallet: d.cfg.revenue.custody.payoutWallet, requestTtlMs: d.cfg.revenue.custody.requestTtlMs });
  const audit = async (c: Context<Env>, action: string, key: string, to: unknown, reason: string | null) =>
    d.db.ConfigAudit.create({ version: (await d.settings.raw()).version, actor: c.get("admin"), action, changes: [{ key, from: null, to: jsonSafe(to) }], reason, ip: ipOf(c) });
  admin.get("/payout-wallet", async (c) => {
    const s = await d.settings.get();
    return c.json(jsonSafe(await payoutWalletVerification(d.db, { address: d.cfg.payout.walletPublicKey, runtimeExpectedAddress: s.expectedPayoutPublicKey, rpc: d.rpc ?? null, payoutMode: s.payoutMode })));
  });
  admin.get("/funding", async (c) => {
    const s = await d.settings.get();
    const wallet = await payoutWalletVerification(d.db, { address: d.cfg.payout.walletPublicKey, runtimeExpectedAddress: s.expectedPayoutPublicKey, rpc: d.rpc ?? null, payoutMode: s.payoutMode });
    const pipeline = await buildFundingPipeline(d.db, { payoutWallet: d.cfg.payout.walletPublicKey, balance: wallet.balanceLamports === null ? null : BigInt(wallet.balanceLamports), reserveLamports: d.cfg.payout.minReserveLamports, sourcePool: s.poolAddress });
    return c.json(jsonSafe({ wallet, pipeline, features: { custodyEnabled: d.cfg.revenue.custody.enabled, recoveryEnabled: d.cfg.revenue.recoveryEnabled } }));
  });
  admin.post("/funding/custody", async (c) => {
    const body = z.object({ fundingKey: z.string().min(1).max(500), reason: z.string().max(500).optional() }).strict().parse(await c.req.json());
    const row = await createCustodyRequest(d.db, custodyCfg(), { fundingKey: body.fundingKey, actor: c.get("admin"), now: now() });
    await audit(c, "custody_request", body.fundingKey, { custodyId: row.custodyId, expected: row.instructions.lamports }, body.reason ?? null);
    return c.json(jsonSafe({ custodyId: row.custodyId, fundingKey: row.fundingKey, sourceWallet: row.sourceWallet, destinationWallet: row.destinationWallet, expectedAmount: row.instructions.lamports, memo: row.memo, expiresAt: row.expiresAt, instructions: row.instructions }));
  });
  admin.post("/funding/custody/:id/submit", async (c) => {
    const body = z.object({ signature: z.string().min(64).max(90) }).strict().parse(await c.req.json());
    if (!d.rpc) return c.json({ error: "no RPC configured in the API process" }, 503);
    const r = await submitCustodySignature(d.db, d.rpc, custodyCfg(), { custodyId: c.req.param("id"), signature: body.signature, actor: c.get("admin"), now: now() });
    await audit(c, "custody_submit", c.req.param("id"), r, body.signature);
    return c.json(jsonSafe(r), r.accepted ? 200 : 422);
  });
  admin.post("/funding/custody/:id/cancel", async (c) => {
    const body = z.object({ reason: z.string().min(3).max(300) }).strict().parse(await c.req.json());
    const r = await cancelCustodyRequest(d.db, { custodyId: c.req.param("id"), actor: c.get("admin"), reason: body.reason, now: now() });
    await audit(c, "custody_cancel", c.req.param("id"), r, body.reason);
    return c.json(r);
  });
  admin.get("/funding/custody/:id", async (c) => {
    const row = await d.db.CustodyTransfer.findOne({ custodyId: c.req.param("id") }).lean();
    return row ? c.json(jsonSafe(row)) : c.json({ error: "not found" }, 404);
  });
  admin.get("/funding/attributions", async (c) => {
    const status = c.req.query("status") ?? "unresolved";
    if (!["pending", "linked", "unresolved"].includes(status)) return c.json({ error: "invalid status" }, 400);
    return c.json(jsonSafe(await d.db.FundingAttribution.find({ status }).sort({ slot: -1 }).limit(200).lean()));
  });
  admin.post("/funding/attributions/recover", async (c) => {
    // Strict: an amount, payoutEligible, collectionKey, status or correlation field is a 400.
    const body = z.object({ attributionKey: z.string().min(1).max(500), requestId: z.string().max(80).optional(), note: z.string().max(500).optional() }).strict().parse(await c.req.json());
    if (!d.providerFor) return c.json({ error: "recovery requires the configured launch provider" }, 503);
    if (!d.rpc) return c.json({ error: "no RPC configured in the API process" }, 503);
    const rr = revenueRuntimeOf(d.cfg);
    if (!rr) return c.json({ error: "revenue runtime unavailable" }, 503);
    const out: any = await recoverAttribution({ db: d.db, provider: d.providerFor, runtime: rr, rpc: d.rpc, enabled: d.cfg.revenue.recoveryEnabled, now }, { attributionKey: body.attributionKey, operator: c.get("admin"), requestId: body.requestId, note: body.note });
    await audit(c, "attribution_recovery", body.attributionKey, { requestId: out.requestId, outcome: out.outcome, rewardFundingKey: out.rewardFundingKey ?? null }, body.note ?? null);
    return c.json(jsonSafe(out), out.outcome === "rejected" ? 409 : 200);
  });
  // ── wallets generated from the admin console (docs/WALLETS.md) ──
  // The API never holds or returns key material: generation and export are fulfilled by the rewards worker
  // (the only process with the vault key); an export reaches the browser end-to-end encrypted, and only for
  // a browser key the admin wallet signed.
  admin.get("/wallets", async (c) => {
    const status = await walletsStatus(d.db, d.cfg, d.rpc ? (a) => d.rpc!.getBalance(a) : undefined);
    return c.json(jsonSafe({ wallets: status, site: signInSite(d.cfg, c.req.header("origin"))?.host ?? null }));
  });
  admin.post("/wallets/:role/generate", async (c) => {
    const body = z.object({ reason: z.string().max(300).optional() }).strict().parse(await c.req.json().catch(() => ({})));
    const r = await requestWalletGeneration(d.db, d.cfg, { role: c.req.param("role"), actor: c.get("admin"), reason: body.reason ?? null, now: now() });
    await audit(c, "wallet_generate", c.req.param("role"), { status: r.status, created: r.created }, body.reason ?? null);
    return c.json(jsonSafe(r));
  });
  admin.post("/wallets/:role/export", async (c) => {
    const body = z.object({ requestId: z.string().regex(/^[0-9a-f]{32}$/), message: z.string().max(1000), signature: z.string().min(80).max(100) }).strict().parse(await c.req.json());
    const site = signInSite(d.cfg, c.req.header("origin"))?.host ?? null;
    const r = await createExportRequest(d.db, d.cfg, c.req.param("role"), { ...body, adminWallet: c.get("admin"), site, now: now() });
    await audit(c, "wallet_export_request", c.req.param("role"), r, body.requestId);
    return c.json(jsonSafe(r), r.accepted ? 200 : 422);
  });
  // Clear the creator wallet so a fresh one can be generated or imported. No key material is involved: the
  // encrypted entry is archived (wallet_vault_retired), never deleted; every process restarts without it.
  admin.post("/wallets/:role/retire", async (c) => {
    const body = z.object({ confirmAddress: z.string().min(32).max(44), reason: z.string().max(300).optional() }).strict().parse(await c.req.json());
    const r = await retireWallet(d.db, d.cfg, { role: c.req.param("role"), actor: c.get("admin"), confirmAddress: body.confirmAddress, reason: body.reason ?? null, now: now() });
    await audit(c, "wallet_retire", c.req.param("role"), r, body.reason ?? null);
    return c.json(jsonSafe(r));
  });
  // Import an existing key: the browser seals it to the rewards worker's published import key; the admin
  // wallet signs the intent (address, worker key). The API stores ciphertext only, never the key.
  admin.get("/wallets/import-key", async (c) => c.json(jsonSafe(await requestImportKey(d.db, now()))));
  admin.post("/wallets/:role/import", async (c) => {
    const body = z
      .object({
        requestId: z.string().regex(/^[0-9a-f]{32}$/),
        message: z.string().max(1000),
        signature: z.string().min(80).max(100),
        sealed: z.object({ senderKey: z.string().regex(/^[0-9a-f]{64}$/), iv: z.string().max(64), ciphertext: z.string().max(400) }).strict(),
      })
      .strict()
      .parse(await c.req.json());
    const site = signInSite(d.cfg, c.req.header("origin"))?.host ?? null;
    const r = await requestWalletImport(d.db, d.cfg, c.req.param("role"), { ...body, adminWallet: c.get("admin"), site, now: now() });
    // Audit the decision and the address, never the sealed key.
    await audit(c, "wallet_import_request", c.req.param("role"), r, body.requestId);
    return c.json(jsonSafe(r), r.accepted ? 200 : 422);
  });
  admin.get("/wallets/exports/:id", async (c) => {
    const r = await takeExport(d.db, c.req.param("id"), c.get("admin"), now());
    if (r.status === "ready") await audit(c, "wallet_export_delivered", r.role, { requestId: c.req.param("id"), address: r.address }, null);
    return c.json(jsonSafe(r), r.status === "not_found" ? 404 : 200);
  });

  // ── launch: the pool derived from the token mint, and whether it exists yet ──
  admin.get("/launch", async (c) => {
    const s = await d.settings.get(true);
    const info = s.poolAddress && d.rpc ? await d.rpc.getAccountInfo(s.poolAddress).catch(() => null) : null;
    return c.json(jsonSafe({ provider: s.launchProvider, tokenMint: s.tokenMint, tokenMintSource: s.tokenMintSource, creatorWallet: d.cfg.creatorWallet?.address ?? null, poolAddress: s.poolAddress, poolAddressSource: s.poolAddressSource, poolExists: info ? !!info.value : null, poolOwner: info?.value?.owner ?? null }));
  });
  admin.get("/launch/derive", async (c) => {
    const mint = z.string().trim().min(32).max(44).parse(c.req.query("mint"));
    const s = await d.settings.get();
    if (s.launchProvider === "meteora_dbc") {
      // A DBC pool depends on its launch config: it is looked up on chain by its base mint.
      let found: DbcDiscovery;
      try {
        found = d.rpc ? await discoverDbcPool(d.rpc as unknown as Parameters<typeof discoverDbcPool>[0], mint) : { status: "unsupported", reason: "no RPC" };
      } catch (err) {
        if (/invalid public key|Non-base58|Invalid public key input/i.test(String((err as Error)?.message ?? err))) return c.json({ error: "not a valid token mint address" }, 400);
        found = { status: "unsupported", reason: String((err as Error)?.message ?? err).slice(0, 200) };
      }
      const poolAddress = found.status === "found" ? found.pool : null;
      return c.json({ tokenMint: mint, quote: "SOL", provider: s.launchProvider, poolAddress, poolExists: found.status === "found" ? true : found.status === "not_found" ? false : null, lookup: found.status });
    }
    let poolAddress: string;
    try {
      // Raydium LaunchLab pool, or pump.fun bonding curve: both are PDAs of the token mint.
      poolAddress = s.launchProvider === "pump_fun" ? derivePumpBondingCurve(mint) : deriveLaunchLabPool(mint);
    } catch {
      return c.json({ error: "not a valid token mint address" }, 400);
    }
    const info = d.rpc ? await d.rpc.getAccountInfo(poolAddress).catch(() => null) : null;
    return c.json({ tokenMint: mint, quote: "SOL", provider: s.launchProvider, poolAddress, poolExists: info ? !!info.value : null, lookup: "derived" });
  });

  admin.get("/funding/recoveries", async (c) => {
    const key = c.req.query("attributionKey");
    return c.json(jsonSafe(await d.db.AttributionRecovery.find(key ? { attributionKey: key } : {}).sort({ requestedAt: -1 }).limit(100).lean()));
  });
  app.route("/api/admin", admin);

  app.get("/", (c) => c.text(`${d.cfg.public.appName} API`));
  return app;
}

function maskSettings(s: Awaited<ReturnType<SettingsStore["get"]>>) {
  return jsonSafe({ ...s, rpcUrls: s.rpcUrls.map((u) => u.replace(/(api[-_]?key=)[^&]+/i, "$1***")), wsUrl: s.wsUrl?.replace(/(api[-_]?key=)[^&]+/i, "$1***") ?? null });
}

export async function health(d: Pick<ApiDeps, "db" | "cfg" | "settings">, now: number): Promise<HealthDTO> {
  const s = await d.settings.get();
  const comps: HealthDTO["components"] = {};
  let dbOk = true;
  try {
    await d.db.conn.db!.admin().command({ ping: 1 });
  } catch {
    dbOk = false;
  }
  comps.database = { status: dbOk ? "ok" : "down", lastHeartbeat: new Date(now).toISOString() };
  const rows: any[] = dbOk ? await d.db.WorkerState.find({ _id: { $in: ["indexer", "rewards"] } }).lean() : [];
  for (const name of ["indexer", "rewards"]) {
    const w = rows.find((r) => r._id === name);
    const age = w?.heartbeatAt ? now - new Date(w.heartbeatAt).getTime() : Infinity;
    const status = !w || age > 30_000 ? "down" : w.status === "paused" ? "paused" : w.status === "degraded" || w.status === "error" ? "degraded" : "ok";
    comps[name] = { status, lastHeartbeat: w?.heartbeatAt ? new Date(w.heartbeatAt).toISOString() : null, ...(w?.detail ? { detail: String(w.detail).slice(0, 200) } : {}) };
  }
  comps.api = { status: "ok", lastHeartbeat: new Date(now).toISOString() };
  const statuses = Object.values(comps).map((c) => c.status);
  const overall = statuses.includes("down") ? (comps.database!.status === "down" || comps.rewards!.status === "down" ? "down" : "degraded") : statuses.some((x) => x !== "ok") ? "degraded" : "ok";
  return { status: overall, time: new Date(now).toISOString(), components: comps, provider: s.launchProvider, cluster: d.cfg.solana.cluster, payoutMode: s.payoutMode };
}
