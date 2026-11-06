/**
 * Operator CLI.  bun run cli <command>
 *   status                     worker heartbeats, halt flag, round/payout summary
 *   check-config               validate environment for every process role
 *   pause|resume <indexer|payouts|scheduler>
 *   requeue <payoutId>         requeue a failed payout (safe: prior attempts are provably dead)
 *   clear-halt <reason>        clear a reconciliation payout halt
 *   reconcile                  run reconciliation now and print the report
 *   round <n>                  print a round with its payouts and ledger entries
 *   revenue [--json]           phase-aware revenue report: every stream, per fee mint (read-only)
 *   revenue-reconcile          re-run claim ↔ transfer correlation and reconciliation now (idempotent;
 *                              writes only derived reconciliation rows and new funding credits)
 *   gen-schedule-key           print a new SCHEDULE_ENCRYPTION_KEY
 */
import { randomBytes } from "node:crypto";
import { ConfigError, connectDatabase, jsonSafe, loadConfig, Reconciler, requeueFailedPayout, RpcClient, SettingsStore, TerminalWriter, createProvider, providerTargetFor, attachStoredMigration, buildRevenueReport, renderRevenueReport, reconcileFunding, forgeLaunchContextOf, revenueRuntimeOf, type ProcessRole } from "@last60/engine";

const [cmd, ...args] = process.argv.slice(2);
const print = (v: unknown) => console.log(JSON.stringify(jsonSafe(v), null, 2));

if (cmd === "gen-schedule-key") {
  console.log(randomBytes(32).toString("base64"));
  process.exit(0);
}
if (cmd === "check-config") {
  let failed = false;
  for (const role of ["indexer", "rewards", "api"] as ProcessRole[]) {
    try {
      loadConfig(role);
      console.log(`✔ ${role}`);
    } catch (e) {
      failed = true;
      console.log(`✘ ${role}\n${e instanceof ConfigError ? e.problems.map((p) => "    - " + p).join("\n") : e}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

const cfg = loadConfig("cli");
const db = await connectDatabase(cfg.mongo.uri, cfg.mongo.dbName, { syncIndexes: false });
const settings = new SettingsStore(db, cfg, 0);
const actor = `cli:${process.env.USER ?? "operator"}`;
try {
  switch (cmd) {
    case "status": {
      const [workers, halt, rounds, payouts] = await Promise.all([
        db.WorkerState.find({ _id: { $not: /^cursor:/ } }).lean(),
        db.SystemState.findById("payout_halt").lean(),
        db.Round.aggregate([{ $group: { _id: "$state", n: { $sum: 1 } } }]),
        db.Payout.aggregate([{ $group: { _id: "$state", n: { $sum: 1 } } }]),
      ]);
      print({ settings: await settings.get(true), workers, halt, rounds, payouts });
      break;
    }
    case "pause":
    case "resume": {
      const key = { indexer: "pauseIndexer", payouts: "pausePayouts", scheduler: "pauseScheduler" }[args[0] ?? ""];
      if (!key) throw new Error("usage: pause|resume <indexer|payouts|scheduler>");
      const raw = await settings.raw();
      print(await settings.update({ [key]: cmd === "pause" ? true : null }, { actor, reason: `${cmd} via CLI`, expectedVersion: raw.version }));
      break;
    }
    case "requeue":
      print({ requeued: await requeueFailedPayout(db, args[0] ?? "", actor) });
      break;
    case "clear-halt": {
      if (!args.length) throw new Error("usage: clear-halt <reason>");
      const prev: any = await db.SystemState.findById("payout_halt").lean();
      await db.SystemState.deleteOne({ _id: "payout_halt" });
      await db.ConfigAudit.create({ version: (await settings.raw()).version, actor, action: "clear_payout_halt", changes: [{ key: "payout_halt", from: prev?.value ?? null, to: null }], reason: args.join(" ") });
      print({ cleared: !!prev });
      break;
    }
    case "reconcile": {
      const s = await settings.get(true);
      const rpc = new RpcClient({ urls: s.rpcUrls, maxTxVersion: cfg.solana.maxTxVersion });
      // Same target (incl. declarations) and the same persisted destination as the workers, so the
      // reconciler sees exactly the bases the indexer and rewards worker resolved.
      const provider = createProvider(providerTargetFor(s, cfg), rpc);
      await provider.load();
      await attachStoredMigration(db, provider);
      const r = new Reconciler({ db, cfg, settings, rpc, provider: () => provider, payoutWallet: s.expectedPayoutPublicKey, terminal: new TerminalWriter(db) });
      print(await r.run());
      break;
    }
    case "round": {
      const n = Number(args[0]);
      print({ round: await db.Round.findOne({ roundNumber: n }).lean(), payouts: await db.Payout.find({ roundNumber: n }).lean(), ledger: await db.LedgerEntry.find({ roundNumber: n }).lean() });
      break;
    }
    case "revenue": {
      const s = await settings.get(true);
      const rpc = new RpcClient({ urls: s.rpcUrls, maxTxVersion: cfg.solana.maxTxVersion });
      const slot = await rpc.getSlot("confirmed").catch(() => null);
      const report = await buildRevenueReport(db, { sourcePool: s.poolAddress, policy: cfg.revenue.policy, currentSlot: slot });
      if (args.includes("--json")) print(report);
      else console.log(renderRevenueReport(report));
      break;
    }
    case "revenue-reconcile": {
      const s = await settings.get(true);
      const rpc = new RpcClient({ urls: s.rpcUrls, maxTxVersion: cfg.solana.maxTxVersion });
      const provider = createProvider(providerTargetFor(s, cfg), rpc);
      const info = await provider.load();
      await attachStoredMigration(db, provider);
      const rr = revenueRuntimeOf(cfg)!;
      print({ newCredits: await reconcileFunding(db, { sourcePool: info.poolAddress, quoteMint: info.quoteMint, provider: info.provider, tokenMint: info.tokenMint, forge: forgeLaunchContextOf(provider, rr) }, rr) });
      break;
    }
    default:
      console.log("commands: status | check-config | pause <c> | resume <c> | requeue <id> | clear-halt <reason> | reconcile | round <n> | revenue [--json] | revenue-reconcile | gen-schedule-key");
  }
} finally {
  await db.close();
}
