/**
 * Operator report of the phase-aware revenue streams (read-only, from MongoDB). Every stream is
 * reported on its own and per fee mint; nothing is summed into an ambiguous "creator fee" total.
 */
import type { Models } from "../db/models";
import { big } from "../db/decimal";
import { phaseAwareInForce, policySnapshot, STREAM_INFO, type FundingPolicy } from "../accounting/revenueStreams";

type PerMint<T> = Record<string, T>;
const s = (v: bigint) => v.toString();

export interface RevenueReport {
  generatedAt: string;
  sourcePool: string | null;
  policy: ReturnType<typeof policySnapshot> & { inForceAtSlot: number | null; phaseAwareInForce: boolean | null };
  bondingCurve: PerMint<{ collections: number; verifiedCollections: number; grossCreatorFeesCollected: string; creatorExpectedShare: string; creatorRetainedImplied: string; last60ExpectedContribution: string; last60FundingReceived: string; last60FundingCreditable: string; untransferred: string; unverifiedGross: string; statuses: Record<string, number> }>;
  postMigration: {
    cpmmCreatorFees: PerMint<{ collections: number; netCreatorTransfers: string; grossBeforeProtocolShare: "not observable from the collection transaction"; effectiveCreatorFeeShareRates: string[]; creatorFeeOnModes: string[]; rewardEligible: false }>;
    forgePlatformLp: PerMint<{ collections: number; verifiedCollections: number; grossClaimed: string; last60ExpectedContribution: string; last60FundingReceived: string; last60FundingCreditable: string; forgeRetainedExpected: string; forgeRetainedImplied: string; forgeRetainedObserved: null; untransferred: string; unverifiedGross: string; statuses: Record<string, number> }>;
  };
  buyerRewards: {
    verifiedBondingCurveFunding: PerMint<string>;
    verifiedForgeLpFunding: PerMint<string>;
    eligibleBalanceByMint: PerMint<string>;
    consumedByRounds: PerMint<string>;
    remainingAvailable: PerMint<string>;
    ineligibleCredits: { count: number; byReason: Record<string, number> };
    unlinkedFundingInflows: { count: number; byMint: PerMint<string> };
    /**
     * Forge's existing post-migration creator payouts (route forge_creator_distribution), by
     * attribution status: linked (credit written; payable or not), pending (evidence not complete
     * yet, e.g. indexing behind) and unresolved (recorded, never payable, with the reasons).
     */
    forgeCreatorDistributions: { linked: number; linkedPayable: number; pending: number; unresolved: number; unresolvedByReason: Record<string, number>; unresolvedByMint: PerMint<string> };
    duplicateEventsRejected: number;
    reconciliationDiscrepancies: { key: string; stream: string; status: string; discrepancies: string[] }[];
  };
}

export async function buildRevenueReport(db: Models, opts: { sourcePool?: string | null; policy: FundingPolicy; currentSlot?: number | null }): Promise<RevenueReport> {
  const scope = opts.sourcePool ? { sourcePool: opts.sourcePool } : {};
  const recs: any[] = await db.RevenueReconciliation.find(scope).lean();
  const credits: any[] = await db.RewardFunding.find(scope).lean();
  const cpmm: any[] = await db.RevenueEvent.find({ ...scope, stream: "cpmm_creator_trading_fee" }, { feeMint: 1, netAmount: 1, snapshot: 1 }).lean();
  const unlinked: any[] = await db.RevenueEvent.aggregate([
    { $match: { ...scope, kind: "funding_inflow" } },
    { $lookup: { from: "reward_funding", localField: "key", foreignField: "key", as: "c" } },
    { $match: { c: { $size: 0 } } },
    { $group: { _id: "$asset", n: { $sum: 1 }, t: { $sum: "$netAmount" } } },
  ]);
  const dup: any = await db.SystemState.findById("revenue_duplicates_rejected").lean();
  const attributions: any[] = await db.FundingAttribution.find(scope, { status: 1, payoutEligible: 1, reasons: 1, asset: 1, amount: 1 }).lean();
  const fcd: RevenueReport["buyerRewards"]["forgeCreatorDistributions"] = { linked: 0, linkedPayable: 0, pending: 0, unresolved: 0, unresolvedByReason: {}, unresolvedByMint: {} };
  for (const a of attributions) {
    if (a.status === "linked") {
      fcd.linked++;
      if (a.payoutEligible) fcd.linkedPayable++;
    } else if (a.status === "pending") fcd.pending++;
    else {
      fcd.unresolved++;
      const reason = String(a.reasons?.[0] ?? "unknown").split(":")[0]!;
      fcd.unresolvedByReason[reason] = (fcd.unresolvedByReason[reason] ?? 0) + 1;
      fcd.unresolvedByMint[a.asset] = (big(fcd.unresolvedByMint[a.asset] ?? "0") + big(a.amount)).toString();
    }
  }

  const bonding: RevenueReport["bondingCurve"] = {};
  const forge: RevenueReport["postMigration"]["forgePlatformLp"] = {};
  const add = (m: Record<string, bigint>, k: string, v: bigint) => (m[k] = (m[k] ?? 0n) + v);
  const acc: Record<string, Record<string, Record<string, bigint>>> = { bonding: {}, forge: {} };
  const counts: Record<string, Record<string, { n: number; v: number; st: Record<string, number> }>> = { bonding: {}, forge: {} };
  for (const r of recs) {
    const which = r.stream === "bonding_curve_creator_fee" ? "bonding" : r.stream === "forge_platform_lp_fee_collection" ? "forge" : null;
    if (!which) continue;
    const m = (acc[which]![r.asset] ??= {});
    const c = (counts[which]![r.asset] ??= { n: 0, v: 0, st: {} });
    c.n++;
    if (r.verified) c.v++;
    c.st[r.status] = (c.st[r.status] ?? 0) + 1;
    add(m, "gross", big(r.gross));
    add(m, "expected", big(r.expectedLast60));
    add(m, "expectedRetained", big(r.expectedRetained));
    add(m, "actual", big(r.actualLast60));
    add(m, "creditable", big(r.creditable));
    add(m, "implied", big(r.impliedRetained));
    add(m, "untransferred", big(r.untransferred));
    if (!r.verified) add(m, "unverified", big(r.gross));
  }
  const z = (m: Record<string, bigint> | undefined, k: string) => s(m?.[k] ?? 0n);
  for (const [mint, m] of Object.entries(acc.bonding!)) {
    const c = counts.bonding![mint]!;
    bonding[mint] = { collections: c.n, verifiedCollections: c.v, grossCreatorFeesCollected: z(m, "gross"), creatorExpectedShare: z(m, "expectedRetained"), creatorRetainedImplied: z(m, "implied"), last60ExpectedContribution: z(m, "expected"), last60FundingReceived: z(m, "actual"), last60FundingCreditable: z(m, "creditable"), untransferred: z(m, "untransferred"), unverifiedGross: z(m, "unverified"), statuses: c.st };
  }
  for (const [mint, m] of Object.entries(acc.forge!)) {
    const c = counts.forge![mint]!;
    forge[mint] = { collections: c.n, verifiedCollections: c.v, grossClaimed: z(m, "gross"), last60ExpectedContribution: z(m, "expected"), last60FundingReceived: z(m, "actual"), last60FundingCreditable: z(m, "creditable"), forgeRetainedExpected: z(m, "expectedRetained"), forgeRetainedImplied: z(m, "implied"), forgeRetainedObserved: null, untransferred: z(m, "untransferred"), unverifiedGross: z(m, "unverified"), statuses: c.st };
  }
  const cpmmOut: RevenueReport["postMigration"]["cpmmCreatorFees"] = {};
  for (const e of cpmm) {
    const o = (cpmmOut[e.feeMint] ??= { collections: 0, netCreatorTransfers: "0", grossBeforeProtocolShare: "not observable from the collection transaction", effectiveCreatorFeeShareRates: [], creatorFeeOnModes: [], rewardEligible: false });
    o.collections++;
    o.netCreatorTransfers = s(big(o.netCreatorTransfers) + big(e.netAmount));
    const rate = String(e.snapshot?.effectiveFeeConfig?.effectiveCreatorFeeShareRate ?? "unresolved");
    const mode = String(e.snapshot?.effectiveFeeConfig?.creatorFeeOn ?? "unverified");
    if (!o.effectiveCreatorFeeShareRates.includes(rate)) o.effectiveCreatorFeeShareRates.push(rate);
    if (!o.creatorFeeOnModes.includes(mode)) o.creatorFeeOnModes.push(mode);
  }
  const vb: Record<string, bigint> = {};
  const vf: Record<string, bigint> = {};
  const eligible: Record<string, bigint> = {};
  const consumed: Record<string, bigint> = {};
  const byReason: Record<string, number> = {};
  let ineligible = 0;
  for (const c of credits) {
    const v = big(c.creditableAmount);
    if (c.payoutEligible) {
      add(c.stream === "bonding_curve_last60_reward_contribution" ? vb : vf, c.fundingMint, v);
      add(eligible, c.fundingMint, v);
      if (c.roundNumber !== null && c.roundNumber !== undefined) add(consumed, c.fundingMint, v);
    } else {
      ineligible++;
      const reason = String(c.ineligibleReason ?? "unknown").split(":")[0]!.split(" | ")[0]!;
      byReason[reason] = (byReason[reason] ?? 0) + 1;
    }
  }
  const remaining: Record<string, string> = {};
  for (const [m, v] of Object.entries(eligible)) remaining[m] = s(v - (consumed[m] ?? 0n));
  const map = (o: Record<string, bigint>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, s(v)]));
  return {
    generatedAt: new Date().toISOString(),
    sourcePool: opts.sourcePool ?? null,
    policy: { ...policySnapshot(opts.policy), inForceAtSlot: opts.currentSlot ?? null, phaseAwareInForce: opts.currentSlot == null ? null : phaseAwareInForce(opts.policy, opts.currentSlot) },
    bondingCurve: bonding,
    postMigration: { cpmmCreatorFees: cpmmOut, forgePlatformLp: forge },
    buyerRewards: {
      verifiedBondingCurveFunding: map(vb),
      verifiedForgeLpFunding: map(vf),
      eligibleBalanceByMint: map(eligible),
      consumedByRounds: map(consumed),
      remainingAvailable: remaining,
      ineligibleCredits: { count: ineligible, byReason },
      unlinkedFundingInflows: { count: unlinked.reduce((a, x) => a + x.n, 0), byMint: Object.fromEntries(unlinked.map((x) => [x._id, s(big(x.t))])) },
      forgeCreatorDistributions: fcd,
      duplicateEventsRejected: Number(dup?.value?.events ?? 0),
      reconciliationDiscrepancies: recs.filter((r) => r.discrepancies?.length || ["partial", "excess", "unresolved", "awaiting_distribution"].includes(r.status)).slice(0, 100).map((r) => ({ key: r.key, stream: r.stream, status: r.status, discrepancies: r.discrepancies ?? [] })),
    },
  };
}

export function renderRevenueReport(r: RevenueReport): string {
  const L: string[] = [];
  const p = r.policy;
  L.push(`LAST60 revenue report — ${r.generatedAt}${r.sourcePool ? ` — bonding pool ${r.sourcePool}` : ""}`);
  L.push(`Funding policy: ${p.version} (id ${p.id}); activation slot ${p.activationSlot ?? "—"}; bonding: ${p.bondingCreatorFeeLast60Bps / 100}% of COLLECTED creator fees to Last-60 (creator keeps ${(10_000 - p.bondingCreatorFeeLast60Bps) / 100}%); Forge LP: creator's ${p.forgeLpLast60Bps / 100}% allocation of CLAIMED platform LP fees to Last-60 (Forge keeps ${(10_000 - p.forgeLpLast60Bps) / 100}%); CPMM creator fees: 0% to Last-60${p.phaseAwareInForce === null ? "" : `; phase-aware in force at slot ${p.inForceAtSlot}: ${p.phaseAwareInForce ? "yes" : "no"}`}`);
  L.push("Amounts are integer base units of each fee mint. A fee RATE is not an allocation; an expected split is not a payment.");
  L.push("");
  L.push(`BONDING CURVE — ${STREAM_INFO.bonding_curve_creator_fee.label}`);
  if (!Object.keys(r.bondingCurve).length) L.push("  (no collections observed)");
  for (const [m, x] of Object.entries(r.bondingCurve)) {
    L.push(`  mint ${m}: ${x.collections} collection(s), ${x.verifiedCollections} verified`);
    L.push(`    gross creator fees collected   ${x.grossCreatorFeesCollected}`);
    L.push(`    creator expected share         ${x.creatorExpectedShare}   (retained implied ${x.creatorRetainedImplied})`);
    L.push(`    Last-60 expected contribution  ${x.last60ExpectedContribution}`);
    L.push(`    Last-60 funding received       ${x.last60FundingReceived}   (creditable ${x.last60FundingCreditable})`);
    L.push(`    untransferred / unverified     ${x.untransferred} / ${x.unverifiedGross}   statuses ${JSON.stringify(x.statuses)}`);
  }
  L.push("");
  L.push(`POST-MIGRATION — ${STREAM_INFO.cpmm_creator_trading_fee.label} (never Last-60 funding)`);
  if (!Object.keys(r.postMigration.cpmmCreatorFees).length) L.push("  (no collections observed)");
  for (const [m, x] of Object.entries(r.postMigration.cpmmCreatorFees)) L.push(`  mint ${m}: ${x.collections} collection(s); net creator transfers ${x.netCreatorTransfers}; effective share rate(s) ${x.effectiveCreatorFeeShareRates.join(", ")}; creator_fee_on ${x.creatorFeeOnModes.join(", ")}`);
  L.push(`POST-MIGRATION — ${STREAM_INFO.forge_platform_lp_fee_collection.label}`);
  if (!Object.keys(r.postMigration.forgePlatformLp).length) L.push("  (no collections observed)");
  for (const [m, x] of Object.entries(r.postMigration.forgePlatformLp)) {
    L.push(`  mint ${m}: ${x.collections} claim(s), ${x.verifiedCollections} verified`);
    L.push(`    gross platform LP fees claimed ${x.grossClaimed}`);
    L.push(`    creator allocation → Last-60   expected ${x.last60ExpectedContribution} / received ${x.last60FundingReceived}   (creditable ${x.last60FundingCreditable})`);
    L.push(`    Forge retained expected        ${x.forgeRetainedExpected}   (implied ${x.forgeRetainedImplied}; independently observed: n/a)`);
    L.push(`    untransferred / unverified     ${x.untransferred} / ${x.unverifiedGross}   statuses ${JSON.stringify(x.statuses)}`);
  }
  L.push("");
  const b = r.buyerRewards;
  L.push("BUYER-REWARD FUNDING");
  L.push(`  verified bonding-curve funding   ${JSON.stringify(b.verifiedBondingCurveFunding)}`);
  L.push(`  verified Forge LP funding        ${JSON.stringify(b.verifiedForgeLpFunding)}   (creator's 50 % LP allocation)`);
  L.push(`  eligible / consumed / remaining  ${JSON.stringify(b.eligibleBalanceByMint)} / ${JSON.stringify(b.consumedByRounds)} / ${JSON.stringify(b.remainingAvailable)}`);
  L.push(`  ineligible credits               ${b.ineligibleCredits.count} ${JSON.stringify(b.ineligibleCredits.byReason)}`);
  L.push(`  unlinked funding inflows         ${b.unlinkedFundingInflows.count} ${JSON.stringify(b.unlinkedFundingInflows.byMint)}`);
  const f = b.forgeCreatorDistributions;
  L.push(`  Forge creator distributions      linked ${f.linked} (payable ${f.linkedPayable}) / pending ${f.pending} / unresolved ${f.unresolved} ${JSON.stringify(f.unresolvedByReason)} ${JSON.stringify(f.unresolvedByMint)}`);
  L.push(`  duplicate events rejected        ${b.duplicateEventsRejected}`);
  L.push(`  reconciliation discrepancies     ${b.reconciliationDiscrepancies.length}`);
  for (const d of b.reconciliationDiscrepancies.slice(0, 20)) L.push(`    ${d.stream} ${d.key.slice(0, 60)}… ${d.status} ${d.discrepancies.join("; ")}`);
  return L.join("\n");
}
