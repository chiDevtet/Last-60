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
 *   creator-wallet [n]         read-only status of the creator wallet automation and its latest n transfers
 *   payout-wallet              read-only verification of the dedicated payout wallet (address, signer status,
 *                              derived-key match, balance, latest payout / custody reconciliation; never a key)
 *   funding [--json]           the four funding stages: attribution / custody / round funding / payouts + liquidity
 *   custody-request <fundingKey> [reason]   open a sweep request for ONE credited contribution (LAST60_CUSTODY_ENABLED)
 *   custody-submit <custodyId> <signature>  verify a custodian's transfer from the chain and bind it to the request
 *   custody-cancel <custodyId> <reason>     cancel an open request
 *   custody-refresh            promote bound custody transfers to finalized / failed (idempotent)
 *   attributions [status]      Forge creator-distribution attributions (default: unresolved)
 *   recover <attributionKey> [note]          re-run the normal attribution for ONE unresolved attribution
 *                              (LAST60_ATTRIBUTION_RECOVERY_ENABLED); recorded in attribution_recoveries
 *   recoveries [attributionKey] recovery audit history
 *   gen-schedule-key           print a new SCHEDULE_ENCRYPTION_KEY
 *
 * The CLI runs with the server's database credentials: its operator identity is `cli:$USER`.
 */
import { randomBytes } from "node:crypto";
import { buildFundingPipeline, CREATOR_WALLET_STATUS_ID, resolveFundingActivation, cancelCustodyRequest, createCustodyRequest, payoutWalletVerification, recoverAttribution, refreshCustodyFinality, renderFundingPipeline, submitCustodySignature, ConfigError, connectDatabase, jsonSafe, loadConfig, Reconciler, requeueFailedPayout, RpcClient, SettingsStore, TerminalWriter, createProvider, providerTargetFor, attachStoredMigration, buildRevenueReport, renderRevenueReport, reconcileFunding, forgeLaunchContextOf, revenueRuntimeOf, type ProcessRole } from "@last60/engine";

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
await resolveFundingActivation(cfg, db, new RpcClient({ urls: cfg.solana.rpcUrls, timeoutMs: cfg.solana.timeoutMs, maxRps: 5 })).catch((err) => {
  console.error(`warning: funding policy activation slot unresolved (${String(err?.message ?? err)}); revenue commands are unavailable until the RPC is reachable`);
});
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
    case "payout-wallet": {
      const s = await settings.get(true);
      const rpc = new RpcClient({ urls: s.rpcUrls, maxTxVersion: cfg.solana.maxTxVersion });
      print(await payoutWalletVerification(db, { address: cfg.payout.walletPublicKey, runtimeExpectedAddress: s.expectedPayoutPublicKey, rpc, payoutMode: s.payoutMode }));
      break;
    }
    case "creator-wallet": {
      // Read-only: what the rewards worker's creator wallet automation is doing (never key material).
      const [status, recent] = await Promise.all([
        db.SystemState.findById(CREATOR_WALLET_STATUS_ID).lean(),
        db.CreatorWalletTransfer.find({}, { serializedTx: 0 }).sort({ createdAt: -1 }).limit(Number(args[0] ?? 20)).lean(),
      ]);
      print({ configured: { address: cfg.creatorWallet.address, automationEnabled: cfg.creatorWallet.automationEnabled, fundingPolicy: cfg.revenue.policy.version, activationSlot: cfg.revenue.policy.activationSlot, activationSource: cfg.revenue.activation.source, payoutWallet: cfg.payout.walletPublicKey, custodyEnabled: cfg.revenue.custody.enabled }, rewardsWorker: (status as any)?.value ?? null, recentTransfers: recent });
      break;
    }
    case "funding": {
      const s = await settings.get(true);
      const rpc = new RpcClient({ urls: s.rpcUrls, maxTxVersion: cfg.solana.maxTxVersion });
      const balance = cfg.payout.walletPublicKey ? await rpc.getBalance(cfg.payout.walletPublicKey).catch(() => null) : null;
      const r = await buildFundingPipeline(db, { payoutWallet: cfg.payout.walletPublicKey, balance, reserveLamports: cfg.payout.minReserveLamports, sourcePool: s.poolAddress });
      if (args.includes("--json")) print(r);
      else console.log(renderFundingPipeline(r));
      break;
    }
    case "custody-request": {
      if (!args[0]) throw new Error("usage: custody-request <fundingKey> [reason]");
      const row = await createCustodyRequest(db, cfg.revenue.custody, { fundingKey: args[0], actor });
      await db.ConfigAudit.create({ version: (await settings.raw()).version, actor, action: "custody_request", changes: [{ key: args[0], from: null, to: { custodyId: row.custodyId } }], reason: args.slice(1).join(" ") || null });
      print({ custodyId: row.custodyId, instructions: row.instructions, expiresAt: row.expiresAt });
      break;
    }
    case "custody-submit": {
      if (!args[0] || !args[1]) throw new Error("usage: custody-submit <custodyId> <signature>");
      const s = await settings.get(true);
      const rpc = new RpcClient({ urls: s.rpcUrls, maxTxVersion: cfg.solana.maxTxVersion });
      const r = await submitCustodySignature(db, rpc, cfg.revenue.custody, { custodyId: args[0], signature: args[1], actor });
      await db.ConfigAudit.create({ version: (await settings.raw()).version, actor, action: "custody_submit", changes: [{ key: args[0], from: null, to: jsonSafe(r) }], reason: args[1] });
      print(r);
      break;
    }
    case "custody-cancel": {
      if (!args[0] || args.length < 2) throw new Error("usage: custody-cancel <custodyId> <reason>");
      print(await cancelCustodyRequest(db, { custodyId: args[0], actor, reason: args.slice(1).join(" ") }));
      break;
    }
    case "custody-refresh": {
      const s = await settings.get(true);
      const rpc = new RpcClient({ urls: s.rpcUrls, maxTxVersion: cfg.solana.maxTxVersion });
      print(await refreshCustodyFinality(db, rpc));
      break;
    }
    case "attributions":
      print(await db.FundingAttribution.find({ status: args[0] ?? "unresolved" }).sort({ slot: -1 }).limit(200).lean());
      break;
    case "recover": {
      if (!args[0]) throw new Error("usage: recover <attributionKey> [note]");
      const s = await settings.get(true);
      const rpc = new RpcClient({ urls: s.rpcUrls, maxTxVersion: cfg.solana.maxTxVersion });
      const rr = revenueRuntimeOf(cfg)!;
      const providerFor = async () => {
        const p = createProvider(providerTargetFor(s, cfg), rpc);
        await p.load();
        await attachStoredMigration(db, p);
        return p;
      };
      const out: any = await recoverAttribution({ db, provider: providerFor, runtime: rr, rpc, enabled: cfg.revenue.recoveryEnabled }, { attributionKey: args[0], operator: actor, note: args.slice(1).join(" ") || undefined });
      await db.ConfigAudit.create({ version: (await settings.raw()).version, actor, action: "attribution_recovery", changes: [{ key: args[0], from: null, to: { requestId: out.requestId, outcome: out.outcome } }], reason: args.slice(1).join(" ") || null });
      print(out);
      break;
    }
    case "recoveries":
      print(await db.AttributionRecovery.find(args[0] ? { attributionKey: args[0] } : {}).sort({ requestedAt: -1 }).limit(100).lean());
      break;
    default:
      console.log("commands: status | check-config | pause <c> | resume <c> | requeue <id> | clear-halt <reason> | reconcile | round <n> | revenue [--json] | revenue-reconcile | payout-wallet | creator-wallet [n] | funding [--json] | custody-request <fundingKey> | custody-submit <custodyId> <signature> | custody-cancel <custodyId> <reason> | custody-refresh | attributions [status] | recover <attributionKey> [note] | recoveries [key] | gen-schedule-key");
  }
} finally {
  await db.close();
}
