/**
 * Read-only operator views of the dedicated payout wallet and the reward-funding pipeline
 * (docs/REWARD_FUNDING.md §14–§16). The four stages are reported separately and never merged:
 *
 *   1. attribution — economic contributions (`reward_funding` credits; unresolved Forge attributions);
 *   2. custody     — SOL physically received by the payout wallet (direct transfers / custody transfers);
 *   3. rounds      — credits consumed by reward rounds;
 *   4. payouts     — buyer reward payouts.
 *
 * Never returns key material: signer facts come from the sanitized status the rewards worker publishes.
 */
import type { Models } from "../db/models";
import { big } from "../db/decimal";
import type { ChainRpc } from "../chain/rpc";
import { CURRENT_PHASE_AWARE_VERSION, WSOL_MINT } from "../accounting/revenueStreams";
import { custodiedTotals, custodyRequirement } from "./custody";

const s = (v: bigint) => v.toString();

export interface PayoutWalletVerification {
  address: string | null;
  /** Admin runtime override of the expected payout key (must equal the address; signing is refused otherwise). */
  runtimeExpectedAddress: string | null;
  runtimeMatchesAddress: boolean | null;
  signer: { configured: boolean; derivedMatches: boolean | null; code: string; message: string; checkedAt: string | null; instance: string | null; reportedAddress: string | null } | null;
  signerMatchesAddress: boolean | null;
  balanceLamports: string | null;
  balanceError: string | null;
  payoutsEnabled: boolean;
  payoutsBlockedReason: string | null;
  latestPayout: { roundNumber: number; signature: string; amount: string; confirmedAt: string | null } | null;
  latestCustodyReconciliation: { custodyId: string; status: string; signature: string | null; credited: string; finalizedSlot: number | null; updatedAt: string } | null;
  latestWalletReconciliation: { status: string; at: string; balance: string | null; expected: string | null } | null;
}

/** Wallet verification: configured address, signer status, derived-key match, live balance, latest activity. */
export async function payoutWalletVerification(db: Models, o: { address: string | null; runtimeExpectedAddress?: string | null; rpc?: Pick<ChainRpc, "getBalance"> | null; payoutMode?: string }): Promise<PayoutWalletVerification> {
  const st: any = (await db.SystemState.findById("payout_signer_status").lean()) as any;
  const v = st?.value ?? null;
  const signer = v
    ? { configured: !!v.configured, derivedMatches: v.derivedMatches ?? null, code: String(v.code ?? "unknown"), message: String(v.message ?? ""), checkedAt: v.checkedAt ?? null, instance: v.instance ?? null, reportedAddress: v.address ?? null }
    : null;
  let balance: bigint | null = null;
  let balanceError: string | null = null;
  if (o.address && o.rpc) {
    try {
      balance = await o.rpc.getBalance(o.address, "confirmed");
    } catch (e) {
      balanceError = String((e as Error)?.message ?? e).slice(0, 200);
    }
  } else if (!o.address) balanceError = "payout wallet not configured";
  else balanceError = "no RPC available";
  const lp: any = await db.Payout.findOne({ state: "confirmed" }, { roundNumber: 1, confirmedSignature: 1, amount: 1, confirmedAt: 1 }).sort({ confirmedAt: -1 }).lean();
  const lc: any = await db.CustodyTransfer.findOne({ status: { $in: ["reconciled", "partial"] } }, { custodyId: 1, status: 1, signature: 1, creditedAmount: 1, finalizedSlot: 1, updatedAt: 1 }).sort({ updatedAt: -1 }).lean();
  const lw: any = await db.Reconciliation.findOne({ kind: { $in: ["payout_wallet", "custody"] } }).sort({ at: -1 }).lean();
  const runtimeExpected = o.runtimeExpectedAddress ?? null;
  const signerMatches = signer ? !!signer.configured && signer.derivedMatches === true && (!o.address || signer.reportedAddress === o.address) : null;
  let blocked: string | null = null;
  if (!o.address) blocked = "LAST60_PAYOUT_WALLET_ADDRESS is not configured";
  else if (!signer) blocked = "the rewards worker has not reported a payout signer status";
  else if (!signer.configured) blocked = `payout signer not usable: ${signer.message}`;
  else if (signer.reportedAddress !== o.address) blocked = "the rewards worker's payout wallet differs from this process' LAST60_PAYOUT_WALLET_ADDRESS";
  else if (runtimeExpected && runtimeExpected !== o.address) blocked = "the admin override expectedPayoutPublicKey differs from LAST60_PAYOUT_WALLET_ADDRESS (signing is refused)";
  return {
    address: o.address,
    runtimeExpectedAddress: runtimeExpected,
    runtimeMatchesAddress: runtimeExpected && o.address ? runtimeExpected === o.address : null,
    signer,
    signerMatchesAddress: signerMatches,
    balanceLamports: balance === null ? null : s(balance),
    balanceError,
    payoutsEnabled: !blocked && o.payoutMode === "live",
    payoutsBlockedReason: blocked ?? (o.payoutMode !== "live" ? "payout mode is dry_run" : null),
    latestPayout: lp ? { roundNumber: lp.roundNumber, signature: lp.confirmedSignature, amount: s(big(lp.amount)), confirmedAt: lp.confirmedAt ? new Date(lp.confirmedAt).toISOString() : null } : null,
    latestCustodyReconciliation: lc ? { custodyId: lc.custodyId, status: lc.status, signature: lc.signature ?? null, credited: s(big(lc.creditedAmount)), finalizedSlot: lc.finalizedSlot ?? null, updatedAt: new Date(lc.updatedAt).toISOString() } : null,
    latestWalletReconciliation: lw ? { status: lw.status, at: new Date(lw.at).toISOString(), balance: lw.actual != null ? s(big(lw.actual)) : null, expected: lw.expected != null ? s(big(lw.expected)) : null } : null,
  };
}

export interface FundingPipelineReport {
  generatedAt: string;
  payoutWallet: string | null;
  /** 1. Economic contribution attribution (who contributed). */
  attribution: {
    payableSolCredits: number;
    payableSolAmount: string;
    byRoute: Record<string, { credits: number; amount: string }>;
    nonSolPayableCredits: number;
    forge: { linked: number; pending: number; unresolved: number; recovered: number };
    unresolvedForgeAttributions: { key: string; signature: string; slot: number; asset: string; amount: string; reasons: string[]; candidates: string[]; evaluatedAt: string | null; recovery: unknown }[];
  };
  /** 2. Physical custody (who holds the funds). */
  custody: {
    attributedAwaitingCustody: string;
    verifiedReceivedByPayoutWallet: string;
    pendingFinality: string;
    outstanding: string;
    contributions: { fundingKey: string; route: string; stream: string; creator: string | null; custodian: string | null; mode: string; required: string; custodied: string; pendingFinality: string; outstanding: string; roundNumber: number | null; openRequest: string | null; reason: string | null }[];
    transfersByStatus: Record<string, number>;
    recentTransfers: { custodyId: string; fundingKey: string; status: string; confirmationStatus: string; reconciliation: string; sourceWallet: string; destinationWallet: string; expected: string; observed: string | null; credited: string | null; excess: string | null; signature: string | null; slot: number | null; finalizedSlot: number | null; failureReason: string | null; memo: string; updatedAt: string }[];
  };
  /** 3. Reward-round funding (credits consumed by rounds). */
  rounds: { consumedTotal: string; byRound: { roundNumber: number; credits: number; amount: string }[] };
  /** 4. Buyer reward payouts. */
  payouts: { confirmed: string; pending: string; failed: string; counts: Record<string, number> };
  /** Actual liquidity vs. what accounting says should be in the wallet. */
  liquidity: { balance: string | null; reserve: string; pendingLivePayouts: string; custodiedUnconsumed: string; available: string | null; shortfall: string | null; unattributedSurplus: string | null; mismatch: boolean | null; detail: string | null };
  recoveries: { requestId: string; attributionKey: string; operator: string; requestedAt: string; outcome: string; rewardFundingKey: string | null; payoutEligible: boolean; reasons: string[]; failureReason: string | null }[];
}

export async function buildFundingPipeline(db: Models, o: { payoutWallet: string | null; balance?: bigint | null; reserveLamports: bigint; sourcePool?: string | null; limit?: number }): Promise<FundingPipelineReport> {
  const scope = o.sourcePool ? { sourcePool: o.sourcePool } : {};
  const limit = o.limit ?? 200;
  const credits: any[] = await db.RewardFunding.find({ ...scope, payoutEligible: true }, { key: 1, stream: 1, route: 1, fundingMint: 1, creditableAmount: 1, payoutEligible: 1, destinationWallet: 1, creator: 1, roundNumber: 1, policyVersion: 1, policy: 1 }).sort({ slot: 1 }).lean();
  const v2 = credits.filter((c) => (c.policyVersion ?? c.policy?.version) === CURRENT_PHASE_AWARE_VERSION);
  const sol = v2.filter((c) => c.fundingMint === WSOL_MINT);
  const byRoute: Record<string, { credits: number; amount: string }> = {};
  let payableSol = 0n;
  for (const c of sol) {
    const r = c.route ?? "last60_destination";
    const e = (byRoute[r] ??= { credits: 0, amount: "0" });
    e.credits++;
    e.amount = s(big(e.amount) + big(c.creditableAmount));
    payableSol += big(c.creditableAmount);
  }
  const attrs: any[] = await db.FundingAttribution.find(scope, { status: 1, recovery: 1 }).lean();
  const forge = { linked: 0, pending: 0, unresolved: 0, recovered: 0 };
  for (const a of attrs) {
    if (a.status === "linked") forge.linked++;
    else if (a.status === "pending") forge.pending++;
    else forge.unresolved++;
    if (a.recovery) forge.recovered++;
  }
  const unresolved: any[] = await db.FundingAttribution.find({ ...scope, status: "unresolved" }).sort({ slot: -1 }).limit(limit).lean();

  // Custody per contribution.
  const keys = sol.map((c) => c.key);
  const settled = await custodiedTotals(db, keys, { settledOnly: true, payoutWallet: o.payoutWallet });
  const bound = await custodiedTotals(db, keys);
  const open: any[] = keys.length ? await db.CustodyTransfer.find({ fundingKey: { $in: keys }, status: "requested" }, { fundingKey: 1, custodyId: 1 }).lean() : [];
  const openBy = new Map(open.map((x) => [x.fundingKey, x.custodyId]));
  let awaiting = 0n;
  let received = 0n;
  let pendingFin = 0n;
  let outstandingTotal = 0n;
  let custodiedUnconsumed = 0n;
  const contributions: FundingPipelineReport["custody"]["contributions"] = [];
  for (const c of sol) {
    const req = custodyRequirement(c, o.payoutWallet);
    const required = req.required;
    const isDirect = req.mode === "direct";
    const got = isDirect ? required : settled.get(c.key)?.amount ?? 0n;
    const b = isDirect ? required : bound.get(c.key)?.amount ?? 0n;
    const pf = b > got ? b - got : 0n;
    const outstanding = required > b ? required - b : 0n;
    received += got;
    pendingFin += pf;
    if (c.roundNumber == null) {
      custodiedUnconsumed += got;
      if (got < required) awaiting += required - got;
      outstandingTotal += outstanding;
    }
    if (c.roundNumber == null || contributions.length < limit) {
      contributions.push({ fundingKey: c.key, route: c.route ?? "last60_destination", stream: c.stream, creator: c.creator ?? null, custodian: req.custodian, mode: req.mode, required: s(required), custodied: s(got), pendingFinality: s(pf), outstanding: s(outstanding), roundNumber: c.roundNumber ?? null, openRequest: openBy.get(c.key) ?? null, reason: req.reason });
    }
  }
  const byStatusRows: any[] = await db.CustodyTransfer.aggregate([{ $match: scope }, { $group: { _id: "$status", n: { $sum: 1 } } }]);
  const recent: any[] = await db.CustodyTransfer.find(scope).sort({ updatedAt: -1 }).limit(Math.min(limit, 100)).lean();

  const consumed: any[] = await db.RewardFunding.aggregate([{ $match: { ...scope, roundNumber: { $ne: null }, fundingMint: WSOL_MINT } }, { $group: { _id: "$roundNumber", n: { $sum: 1 }, t: { $sum: "$creditableAmount" } } }, { $sort: { _id: -1 } }, { $limit: 100 }]);
  const consumedTotal = consumed.reduce((a, x) => a + big(x.t), 0n);
  const pay: any[] = await db.Payout.aggregate([{ $match: { mint: WSOL_MINT } }, { $group: { _id: "$state", n: { $sum: 1 }, t: { $sum: "$amount" } } }]);
  const payBy: Record<string, { n: number; t: bigint }> = Object.fromEntries(pay.map((x) => [x._id, { n: x.n as number, t: big(x.t) }]));
  const live: any[] = await db.Payout.aggregate([{ $match: { mode: "live", mint: WSOL_MINT, state: { $in: ["pending", "signing", "submitted"] } } }, { $group: { _id: null, t: { $sum: "$amount" } } }]);
  const pendingLive = big(live[0]?.t ?? 0);

  let liquidity: FundingPipelineReport["liquidity"];
  if (o.balance === null || o.balance === undefined) {
    liquidity = { balance: null, reserve: s(o.reserveLamports), pendingLivePayouts: s(pendingLive), custodiedUnconsumed: s(custodiedUnconsumed), available: null, shortfall: null, unattributedSurplus: null, mismatch: null, detail: "payout wallet balance unavailable" };
  } else {
    const need = custodiedUnconsumed + pendingLive + o.reserveLamports;
    const available = o.balance - o.reserveLamports - pendingLive;
    const shortfall = need > o.balance ? need - o.balance : 0n;
    const surplus = o.balance > need ? o.balance - need : 0n;
    liquidity = {
      balance: s(o.balance),
      reserve: s(o.reserveLamports),
      pendingLivePayouts: s(pendingLive),
      custodiedUnconsumed: s(custodiedUnconsumed),
      available: s(available < 0n ? 0n : available),
      shortfall: s(shortfall),
      unattributedSurplus: s(surplus),
      mismatch: shortfall > 0n,
      detail: shortfall > 0n ? `the payout wallet holds ${o.balance} lamports but custodied, unconsumed contributions + pending live payouts + reserve require ${need}` : null,
    };
  }
  const recs: any[] = await db.AttributionRecovery.find({}).sort({ requestedAt: -1 }).limit(50).lean();
  return {
    generatedAt: new Date().toISOString(),
    payoutWallet: o.payoutWallet,
    attribution: {
      payableSolCredits: sol.length,
      payableSolAmount: s(payableSol),
      byRoute,
      nonSolPayableCredits: v2.length - sol.length,
      forge,
      unresolvedForgeAttributions: unresolved.map((a) => ({ key: a.key, signature: a.signature, slot: a.slot, asset: a.asset, amount: s(big(a.amount)), reasons: a.reasons ?? [], candidates: a.candidates ?? [], evaluatedAt: a.evaluatedAt ? new Date(a.evaluatedAt).toISOString() : null, recovery: a.recovery ?? null })),
    },
    custody: {
      attributedAwaitingCustody: s(awaiting),
      verifiedReceivedByPayoutWallet: s(received),
      pendingFinality: s(pendingFin),
      outstanding: s(outstandingTotal),
      contributions,
      transfersByStatus: Object.fromEntries(byStatusRows.map((x) => [x._id, x.n])),
      recentTransfers: recent.map((r) => ({ custodyId: r.custodyId, fundingKey: r.fundingKey, status: r.status, confirmationStatus: r.confirmationStatus, reconciliation: r.reconciliation, sourceWallet: r.sourceWallet, destinationWallet: r.destinationWallet, expected: s(big(r.expectedAmount)), observed: r.observedAmount != null ? s(big(r.observedAmount)) : null, credited: r.creditedAmount != null ? s(big(r.creditedAmount)) : null, excess: r.excessAmount != null ? s(big(r.excessAmount)) : null, signature: r.signature ?? null, slot: r.slot ?? null, finalizedSlot: r.finalizedSlot ?? null, failureReason: r.failureReason ?? null, memo: r.memo, updatedAt: new Date(r.updatedAt).toISOString() })),
    },
    rounds: { consumedTotal: s(consumedTotal), byRound: consumed.map((x) => ({ roundNumber: x._id, credits: x.n, amount: s(big(x.t)) })) },
    payouts: { confirmed: s(payBy.confirmed?.t ?? 0n), pending: s((payBy.pending?.t ?? 0n) + (payBy.signing?.t ?? 0n) + (payBy.submitted?.t ?? 0n)), failed: s(payBy.failed?.t ?? 0n), counts: Object.fromEntries(Object.entries(payBy).map(([k, v]) => [k, v.n])) },
    liquidity,
    recoveries: recs.map((r) => ({ requestId: r.requestId, attributionKey: r.attributionKey, operator: r.operator, requestedAt: new Date(r.requestedAt).toISOString(), outcome: r.outcome, rewardFundingKey: r.rewardFundingKey ?? null, payoutEligible: !!r.payoutEligible, reasons: r.resultReasons ?? [], failureReason: r.failureReason ?? null })),
  };
}

export function renderFundingPipeline(r: FundingPipelineReport): string {
  const L: string[] = [];
  L.push(`LAST60 reward-funding pipeline — ${r.generatedAt}`);
  L.push(`Payout wallet: ${r.payoutWallet ?? "(not configured)"} — amounts in lamports`);
  L.push("");
  L.push("1. ECONOMIC ATTRIBUTION (who contributed)");
  L.push(`   payable SOL credits ${r.attribution.payableSolCredits} = ${r.attribution.payableSolAmount}   by route ${JSON.stringify(r.attribution.byRoute)}`);
  L.push(`   Forge creator distributions: linked ${r.attribution.forge.linked} / pending ${r.attribution.forge.pending} / unresolved ${r.attribution.forge.unresolved} (recovered ${r.attribution.forge.recovered})`);
  for (const a of r.attribution.unresolvedForgeAttributions.slice(0, 20)) L.push(`     unresolved ${a.key.slice(0, 70)}… ${a.asset === WSOL_MINT ? "SOL" : a.asset} ${a.amount} — ${a.reasons[0] ?? ""}${a.recovery ? " [recovered]" : ""}`);
  L.push("2. PHYSICAL CUSTODY (who holds the funds)");
  L.push(`   received by payout wallet ${r.custody.verifiedReceivedByPayoutWallet}   pending finality ${r.custody.pendingFinality}   attributed awaiting custody ${r.custody.attributedAwaitingCustody}   outstanding ${r.custody.outstanding}`);
  L.push(`   custody transfers ${JSON.stringify(r.custody.transfersByStatus)}`);
  for (const c of r.custody.contributions.filter((x) => x.roundNumber == null && x.custodied !== x.required).slice(0, 20)) L.push(`     awaiting ${c.fundingKey.slice(0, 60)}… custodian ${c.custodian ?? "?"} required ${c.required} custodied ${c.custodied} outstanding ${c.outstanding}${c.openRequest ? ` (open request ${c.openRequest})` : ""}${c.reason ? ` — ${c.reason}` : ""}`);
  L.push("3. REWARD-ROUND FUNDING");
  L.push(`   consumed by rounds ${r.rounds.consumedTotal}   ${r.rounds.byRound.slice(0, 10).map((x) => `#${x.roundNumber}:${x.amount}`).join(" ")}`);
  L.push("4. BUYER PAYOUTS");
  L.push(`   confirmed ${r.payouts.confirmed}   pending ${r.payouts.pending}   failed ${r.payouts.failed}`);
  L.push("LIQUIDITY");
  const q = r.liquidity;
  L.push(`   balance ${q.balance ?? "?"}   reserve ${q.reserve}   pending live payouts ${q.pendingLivePayouts}   custodied unconsumed ${q.custodiedUnconsumed}   available ${q.available ?? "?"}   shortfall ${q.shortfall ?? "?"}${q.mismatch ? "   ✕ MISMATCH" : ""}`);
  if (q.detail) L.push(`   ${q.detail}`);
  if (r.recoveries.length) {
    L.push("RECOVERY ATTEMPTS");
    for (const x of r.recoveries.slice(0, 10)) L.push(`   ${x.requestedAt} ${x.requestId} ${x.outcome} ${x.attributionKey.slice(0, 50)}… by ${x.operator}${x.failureReason ? ` — ${x.failureReason}` : ""}`);
  }
  return L.join("\n");
}
