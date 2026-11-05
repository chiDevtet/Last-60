/**
 * Reconciliation — every balance must agree with the chain and with the ledger.
 *
 * 1. fee_source:   Σ attributed eligible fees − Σ claims (+ baseline)  vs  on-chain unclaimed
 *                  (DBC: exact equality; LaunchLab: vault ≥ expected because vaults are shared).
 *                  Over-attribution — the engine believes more fees exist than the chain holds —
 *                  is the only direction that could overpay, and halts new payouts.
 * 2. ledger:       per round, fees + rolloverIn = retained + dust + rolloverOut + Σ payouts,
 *                  and payout rows equal perRecipient × recipientCount.
 * 3. payout_wallet: wallet balance ≥ pending live payouts + reserve.
 */
import type { AppConfig } from "../config/env";
import type { SettingsStore } from "../config/runtime";
import type { ChainRpc } from "../chain/rpc";
import type { Models } from "../db/models";
import { big, dec } from "../db/decimal";
import type { LaunchProvider } from "../providers/LaunchProvider";
import type { TerminalWriter } from "../terminal/terminal";
import { cursorId, readCursor, syncAddress } from "../indexer/signatureSync";
import { periodFees } from "./selection";
import { repairPayoutLedger } from "./payouts";
import { rootLogger, type Logger } from "../util/logger";

export interface ReconcileDeps {
  db: Models;
  cfg: AppConfig;
  settings: SettingsStore;
  rpc: ChainRpc;
  provider: () => LaunchProvider;
  payoutWallet: string | null;
  terminal: TerminalWriter;
  log?: Logger;
}

export interface ReconcileReport {
  feeSource: { status: string; expected: bigint; actual: bigint; diff: bigint; slot: number } | null;
  ledger: { status: string; checked: number; problems: string[] };
  payoutWallet: { status: string; balance: bigint; pending: bigint } | null;
  destination: { status: string; problems: string[] } | null;
}

export class Reconciler {
  private readonly log: Logger;
  constructor(private readonly d: ReconcileDeps) {
    this.log = (d.log ?? rootLogger()).child({ component: "reconcile" });
  }

  async run(): Promise<ReconcileReport> {
    const report: ReconcileReport = { feeSource: null, ledger: { status: "ok", checked: 0, problems: [] }, payoutWallet: null, destination: null };
    report.feeSource = await this.feeSource().catch((err) => {
      this.log.warn({ err: String(err) }, "fee source reconciliation skipped");
      return null;
    });
    report.destination = await this.destination().catch((err) => {
      this.log.warn({ err: String(err) }, "destination reconciliation skipped");
      return null;
    });
    report.ledger = await this.ledger();
    report.payoutWallet = await this.payoutWalletCheck().catch(() => null);
    return report;
  }

  async feeSource() {
    const provider = this.d.provider();
    if (provider.id === "mock") return null;
    const info = provider.info();
    const state = await provider.getFeeSourceState();
    // Ingest up to (at least) the slot the balance was read at, so both sides are comparable.
    const settings = await this.d.settings.get();
    for (const address of info.watchAddresses) {
      const cursor = await readCursor(this.d.db, cursorId(info.provider, info.poolAddress, address));
      if (!cursor?.lastSignature) {
        // The indexer has not established its position yet; comparing now would be meaningless.
        await this.d.db.Reconciliation.create({ kind: "fee_source", status: "skipped", details: { reason: "indexer cursor not established" } });
        return null;
      }
      const r = await syncAddress({ db: this.d.db, provider, minBuyQuote: settings.minBuyQuote, rpc: this.d.rpc, terminal: this.d.terminal }, address, { untilSignature: cursor?.lastSignature ?? null, source: "catchup", cap: 20_000, concurrency: 4, minContextSlot: state.slot });
      if (r.truncated) {
        // Not everything up to the balance slot was ingested; a comparison now would be wrong.
        await this.d.db.Reconciliation.create({ kind: "fee_source", status: "skipped", details: { reason: "indexer backlog exceeds the reconciliation catch-up cap" } });
        return null;
      }
    }
    const poolDoc: any = await this.d.db.Pool.findOne({ key: `${info.provider}:${info.poolAddress}` }).lean();
    const baseline = poolDoc?.baseline ?? { slot: -1, quote: "0" };
    const fees: any[] = await this.d.db.Swap.aggregate([{ $match: { pool: info.poolAddress, status: "active", eligibleFeeMint: info.quoteMint, slot: { $gt: baseline.slot, $lte: state.slot } } }, { $group: { _id: null, t: { $sum: "$eligibleFee" } } }]);
    const claims: any[] = await this.d.db.FeeClaim.aggregate([{ $match: { pool: info.poolAddress, status: "confirmed", slot: { $gt: baseline.slot, $lte: state.slot } } }, { $group: { _id: null, t: { $sum: "$quoteAmount" } } }]);
    // Shared vaults (LaunchLab): deposits of the creator's OTHER pools into the same vault are indexed
    // (the vault is watched) and recorded as excluded inflows. Counting them makes the comparison
    // exact, so other pools' fees can no longer mask an over-attribution on this pool.
    const foreign: any[] = state.mayIncludeOtherPools
      ? await this.d.db.FeeAttribution.aggregate([{ $match: { sourcePool: info.poolAddress, kind: "shared_vault_inflow", feeMint: info.quoteMint, slot: { $gt: baseline.slot, $lte: state.slot } } }, { $group: { _id: null, t: { $sum: "$excludedAmount" } } }])
      : [];
    const expected = big(fees[0]?.t ?? 0) + big(foreign[0]?.t ?? 0) - big(claims[0]?.t ?? 0) + big(baseline.quote ?? "0");
    const actual = state.unclaimedQuote;
    const diff = actual - expected;
    const tol = this.d.cfg.reconciliation.toleranceLamports;
    let status: "ok" | "mismatch" | "over_attribution" | "shared_vault";
    if (diff < -tol) status = "over_attribution";
    else if (state.mayIncludeOtherPools) status = diff > tol ? "shared_vault" : "ok";
    else status = diff > tol ? "mismatch" : "ok";
    await this.d.db.Reconciliation.create({ kind: "fee_source", status, slot: state.slot, expected: dec(expected), actual: dec(actual), diff: dec(diff), details: { source: state.source, baselineSlot: baseline.slot, pool: info.poolAddress, otherPoolsInflow: big(foreign[0]?.t ?? 0).toString() } });
    if (status === "over_attribution" && this.d.cfg.reconciliation.haltOnOverAttribution) {
      await this.d.db.SystemState.updateOne({ _id: "payout_halt" }, { $set: { value: { reason: `over-attribution: engine expected ${expected}, chain holds ${actual} at slot ${state.slot}`, at: new Date() } } }, { upsert: true });
      await this.d.terminal.error("Fee reconciliation found less on-chain than attributed; new payouts are halted pending operator review.", `halt:${state.slot}`);
    } else if (status === "mismatch") {
      await this.d.terminal.warn("Fee reconciliation: on-chain fees exceed attributed fees (possible missed transactions); investigating.", `recon-mismatch:${Math.floor(Date.now() / 3_600_000)}`);
    }
    return { status, expected, actual, diff, slot: state.slot };
  }

  /**
   * Post-migration checks. DAMM v2: for every checkpointed position/mint, Σ attributed deltas must
   * equal the latest stored cumulative (detects duplicated or missing checkpoint records) and must
   * not exceed the position's CURRENT on-chain cumulative (claimable + claimed) — more would be an
   * over-attribution, which halts payouts like any other.
   */
  async destination() {
    const provider = this.d.provider();
    const info = provider.info();
    if (!info.destination || info.destination.kind !== "dbc_damm_v2" || !provider.checkpoint) return null;
    const problems: string[] = [];
    let over = false;
    const rows: any[] = await this.d.db.FeeAttribution.aggregate([
      { $match: { sourcePool: info.poolAddress, kind: "position_checkpoint" } },
      { $sort: { slot: 1 } },
      { $group: { _id: "$checkpointKey", total: { $sum: { $add: ["$creatorAmount", "$excludedAmount"] } }, last: { $last: "$cumulative" }, n: { $sum: 1 } } },
    ]);
    if (!rows.length) return null;
    // Fresh read of the on-chain counters (no persisted records: previous() returns 0 baselines).
    const current = await provider.checkpoint(0, async () => null);
    const onChain = new Map(current.filter((r) => r.kind === "position_checkpoint").map((r) => [r.evidence.checkpointKey as string, BigInt(r.evidence.cumulative as string)]));
    for (const r of rows) {
      const total = big(r.total);
      if (r.last !== null && total !== BigInt(r.last)) problems.push(`${r._id}: Σ checkpoint deltas ${total} ≠ stored cumulative ${r.last} (${r.n} records)`);
      const chain = onChain.get(r._id);
      if (chain !== undefined && total > chain) {
        over = true;
        problems.push(`${r._id}: attributed ${total} exceeds on-chain cumulative ${chain}`);
      }
    }
    const status = over ? "over_attribution" : problems.length ? "mismatch" : "ok";
    await this.d.db.Reconciliation.create({ kind: "fee_source", status, details: { scope: "destination", pool: info.destination.pool, checked: rows.length, problems: problems.slice(0, 50) } });
    if (over && this.d.cfg.reconciliation.haltOnOverAttribution) {
      await this.d.db.SystemState.updateOne({ _id: "payout_halt" }, { $set: { value: { reason: `over-attribution on destination positions: ${problems[0]}`, at: new Date() } } }, { upsert: true });
      await this.d.terminal.error("Destination fee reconciliation found more attributed than the chain accounts for; new payouts are halted pending operator review.", `halt-dest:${Math.floor(Date.now() / 3_600_000)}`);
    }
    return { status, problems };
  }

  async ledger() {
    // U2 recovery first: legacy / interrupted confirmations get their ledger entry exactly once.
    const repair = await repairPayoutLedger(this.d.db);
    if (repair.repaired || repair.marked) this.log.warn(repair, "repaired payout ledger entries");
    const rounds: any[] = await this.d.db.Round.find({ state: { $in: ["paying", "awaiting_funds", "completed", "rolled_over", "attention"] } }).sort({ roundNumber: -1 }).limit(500).lean();
    const problems: string[] = [];
    for (const r of rounds) {
      const payouts: any[] = await this.d.db.Payout.find({ roundNumber: r.roundNumber }, { amount: 1 }).lean();
      const paidTotal = payouts.reduce((s, p) => s + big(p.amount), 0n);
      const lhs = big(r.fees) + big(r.rolloverIn);
      const rhs = big(r.retained) + big(r.dust) + big(r.rolloverOut) + paidTotal;
      if (lhs !== rhs) problems.push(`round #${r.roundNumber}: fees+rollover ${lhs} ≠ retained+dust+rollover+payouts ${rhs}`);
      if (payouts.length !== r.recipientCount || paidTotal !== big(r.perRecipient) * BigInt(r.recipientCount)) problems.push(`round #${r.roundNumber}: payout rows do not match allocation`);
      const ledger: any[] = await this.d.db.LedgerEntry.aggregate([{ $match: { roundNumber: r.roundNumber, type: "PAYOUT_SCHEDULED" } }, { $group: { _id: null, t: { $sum: "$amount" } } }]);
      if (big(ledger[0]?.t ?? 0) !== paidTotal) problems.push(`round #${r.roundNumber}: ledger PAYOUT_SCHEDULED ≠ payout rows`);
    }
    const confirmedNoSig = await this.d.db.Payout.countDocuments({ state: "confirmed", confirmedSignature: null });
    if (confirmedNoSig) problems.push(`${confirmedNoSig} confirmed payouts without a signature`);
    // Period re-check (most recent rounds): recompute each executed round's eligible fees from the
    // swaps now stored for its period. More than recorded = transactions ingested after the
    // snapshot (their buyers and fees were counted in no round); less = counted transactions later
    // dropped as forked out. Either must be investigated, never silently ignored.
    for (const r of rounds.slice(0, 50)) {
      if (r.snapshotSlot == null || !r.config?.pool || !r.config?.payoutMint) continue;
      const pool = r.config.pools?.length ? r.config.pools : r.config.previousPool ? [r.config.previousPool, r.config.pool] : r.config.pool;
      const now = await periodFees(this.d.db, { pool, afterSlot: r.prevSnapshotSlot ?? null, periodStartAt: r.periodStartAt ?? null, snapshotSlot: r.snapshotSlot }, r.config.payoutMint);
      if (now.payout !== big(r.fees)) problems.push(`round #${r.roundNumber}: period fees are now ${now.payout} but ${big(r.fees)} were distributed (${now.payout > big(r.fees) ? "transactions ingested after the snapshot" : "counted transactions later dropped"})`);
    }
    const status = problems.length ? "mismatch" : "ok";
    await this.d.db.Reconciliation.create({ kind: "ledger", status, details: { checked: rounds.length, problems: problems.slice(0, 50), payoutLedgerRepair: repair } });
    if (problems.length) await this.d.terminal.error("Ledger invariant check failed; operators notified.", `ledger:${Math.floor(Date.now() / 3_600_000)}`);
    return { status, checked: rounds.length, problems };
  }

  async payoutWalletCheck() {
    if (!this.d.payoutWallet) return null;
    const s = await this.d.settings.get();
    if (s.payoutMode !== "live") return null;
    const balance = await this.d.rpc.getBalance(this.d.payoutWallet);
    const r: any[] = await this.d.db.Payout.aggregate([{ $match: { mode: "live", state: { $in: ["pending", "signing", "submitted"] } } }, { $group: { _id: null, t: { $sum: "$amount" } } }]);
    const pending = big(r[0]?.t ?? 0);
    const status = balance >= pending + this.d.cfg.payout.minReserveLamports ? "ok" : "mismatch";
    await this.d.db.Reconciliation.create({ kind: "payout_wallet", status, expected: dec(pending), actual: dec(balance), diff: dec(balance - pending) });
    return { status, balance, pending };
  }
}
