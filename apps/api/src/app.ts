/**
 * HTTP API. Public routes are read-only and served exclusively from PublicData DTO builders.
 * Admin routes require a wallet-signed session and every mutation is validated and audited.
 */
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
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
  type AppConfig,
  type Models,
  type ChainRpc,
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
  now?: () => number;
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

const clientIp = (c: Context) => c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "local";

export function createApp(d: ApiDeps) {
  const app = new Hono<Env>();
  const now = d.now ?? (() => Date.now());
  const publicLimit = rateLimiter(20, 60);
  const adminLimit = rateLimiter(3, 20);

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
  });
  app.use(
    "/api/*",
    cors({
      origin: (origin) => (!d.cfg.api.corsOrigins.length ? origin : d.cfg.api.corsOrigins.includes(origin) ? origin : null),
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
      maxAge: 600,
    }),
  );
  app.use("/api/v1/*", async (c, next) => {
    if (!publicLimit(clientIp(c))) return c.json({ error: "rate limited" }, 429);
    await next();
  });
  app.onError((err, c) => {
    if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
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
  app.get("/api/v1/buys/recent", async (c) => c.json(await d.data.recentBuys(Number(c.req.query("limit") ?? 30))));
  app.get("/api/v1/rounds", async (c) => c.json(await d.data.rounds({ before: c.req.query("cursor") ? Number(c.req.query("cursor")) : undefined, limit: Number(c.req.query("limit") ?? 20) })));
  app.get("/api/v1/rounds/:n", async (c) => {
    const n = Number(c.req.param("n"));
    if (!Number.isInteger(n) || n < 1) return c.json({ error: "invalid round" }, 400);
    const r = await d.data.round(n);
    return r ? c.json(r) : c.json({ error: "round not found or not yet settled" }, 404);
  });
  app.get("/api/v1/payouts", async (c) => c.json(await d.data.payouts({ before: c.req.query("cursor") ?? undefined, limit: Number(c.req.query("limit") ?? 50) })));
  app.get("/api/v1/stats", async (c) => c.json(await d.data.stats()));
  app.get("/api/v1/chart", async (c) => c.json(await d.data.chart(Number(c.req.query("limit") ?? 24))));
  app.get("/api/v1/terminal", async (c) => c.json(await d.data.terminal({ before: c.req.query("before") ? Number(c.req.query("before")) : undefined, limit: Number(c.req.query("limit") ?? 50) })));
  app.get("/api/v1/dashboard", async (c) => c.json(await d.data.dashboard()));
  app.get("/api/v1/stream", (c) =>
    streamSSE(c, async (stream) => {
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
      while (!stream.aborted) {
        while (queue.length) {
          const m = queue.shift()!;
          await stream.writeSSE({ event: m.event, data: m.data });
        }
        await new Promise<void>((r) => {
          wake = r;
          setTimeout(r, 20_000);
        });
        wake = null;
      }
      unsubscribe();
    }),
  );

  // ── admin ───────────────────────────────────────────────────────────────────
  const admin = new Hono<Env>();
  admin.use("*", async (c, next) => {
    if (!adminLimit(clientIp(c))) return c.json({ error: "rate limited" }, 429);
    await next();
  });
  admin.post("/auth/nonce", async (c) => {
    const body = z.object({ wallet: z.string() }).parse(await c.req.json());
    const host = d.cfg.api.publicSiteUrl ? new URL(d.cfg.api.publicSiteUrl).host : (c.req.header("origin") ? new URL(c.req.header("origin")!).host : c.req.header("host") ?? "localhost");
    return c.json(await d.auth.issueNonce(body.wallet, host));
  });
  admin.post("/auth/verify", async (c) => {
    const body = z.object({ wallet: z.string(), nonce: z.string(), signature: z.string() }).parse(await c.req.json());
    return c.json(await d.auth.verify(body.wallet, body.nonce, body.signature));
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
      const res = await d.settings.update(body.patch, { actor: c.get("admin"), reason: body.reason, ip: clientIp(c), expectedVersion: body.expectedVersion });
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
    const res = await d.settings.update({ [key]: action === "pause" ? true : null }, { actor: c.get("admin"), reason: `${action} ${c.req.param("component")}`, ip: clientIp(c), expectedVersion: raw.version });
    return c.json(jsonSafe(res));
  });
  admin.post("/payouts/:id/requeue", async (c) => {
    const ok = await requeueFailedPayout(d.db, c.req.param("id"), c.get("admin"));
    await d.db.ConfigAudit.create({ version: (await d.settings.raw()).version, actor: c.get("admin"), action: "requeue_payout", changes: [{ key: "payout", from: "failed", to: ok ? "pending" : "unchanged" }], reason: c.req.param("id"), ip: clientIp(c) });
    return ok ? c.json({ ok }) : c.json({ error: "payout is not in failed state" }, 409);
  });
  admin.post("/halt/clear", async (c) => {
    const body = z.object({ reason: z.string().min(3) }).parse(await c.req.json());
    const prev: any = await d.db.SystemState.findById("payout_halt").lean();
    await d.db.SystemState.deleteOne({ _id: "payout_halt" });
    await d.db.ConfigAudit.create({ version: (await d.settings.raw()).version, actor: c.get("admin"), action: "clear_payout_halt", changes: [{ key: "payout_halt", from: prev?.value ?? null, to: null }], reason: body.reason, ip: clientIp(c) });
    return c.json({ ok: true });
  });
  admin.get("/reconciliation", async (c) => c.json(jsonSafe(await d.db.Reconciliation.find({}).sort({ at: -1 }).limit(100).lean())));
  admin.get("/payouts", async (c) => {
    const state = c.req.query("state");
    const rows = await d.db.Payout.find(state ? { state } : {}).sort({ createdAt: -1 }).limit(100).lean();
    return c.json(jsonSafe(rows));
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
