/**
 * Idempotent ingestion and reconciliation of the phase-aware revenue streams.
 *
 *   1. `ingestRevenue` decodes a transaction (revenue/decode.ts), verifies each fact against the
 *      launch's verified configuration and writes it ONCE into `revenue_events` ($setOnInsert, keyed by
 *      stream/signature/instruction/mint — re-indexing, retries and restarts never add a row).
 *   2. `reconcileFunding` links every not-yet-linked funding inflow to the collection it distributes
 *      (same transaction, memo, or — opt-in — the unambiguous latest claim; never by amount), writes ONE
 *      credit per inflow into `reward_funding` (unique key = the inflow), and recomputes the derived
 *      per-claim reconciliation rows. Credits are payable only under the phase-aware policy, for a
 *      verified collection, up to the policy amount, after the activation slot.
 * Works in any order: a transfer indexed before its claim stays unlinked until the claim arrives;
 * a claim whose distribution never comes stays "awaiting_distribution" with its untransferred balance.
 */
import type { Models } from "../db/models";
import { big, dec } from "../db/decimal";
import type { NormalizedTx } from "../chain/tx";
import type { LaunchProvider, ParsedTransaction } from "../providers/LaunchProvider";
import { MigrationAwareProvider } from "../providers/MigrationAwareProvider";
import { CpmmDestination } from "../providers/destination/cpmm";
import { RaydiumLaunchLabProvider } from "../providers/raydium/RaydiumLaunchLabProvider";
import { EXCLUSION } from "../accounting/attribution";
import {
  assetOf,
  correlateTransfer,
  expectedSplit,
  phaseAwareInForce,
  policySnapshot,
  reconcileCollection,
  SPLIT_OF,
  type CollectionFact,
  type CollectionStream,
  type FundingCorrelationMode,
  type FundingPolicy,
  type PolicySnapshot,
  type RevenueSnapshot,
  type TransferFact,
} from "../accounting/revenueStreams";
import { extractRevenue, revenueEventKey, type RevenueDraft, type RevenueLaunchFacts } from "./decode";

export interface RevenueRuntime {
  cluster: string;
  policy: FundingPolicy;
  fundingDestinations: string[];
  forgePlatformLpBeneficiary: string | null;
  correlationMode: FundingCorrelationMode;
}

/** Revenue runtime from the application configuration (null when the config predates PR #6, e.g. tests). */
export function revenueRuntimeOf(cfg: { solana: { cluster: string }; revenue?: { policy: FundingPolicy; fundingDestinations: string[]; forgePlatformLpBeneficiary: string | null; correlationMode: FundingCorrelationMode } }): RevenueRuntime | null {
  if (!cfg.revenue?.policy) return null;
  return { cluster: cfg.solana.cluster, policy: cfg.revenue.policy, fundingDestinations: cfg.revenue.fundingDestinations, forgePlatformLpBeneficiary: cfg.revenue.forgePlatformLpBeneficiary, correlationMode: cfg.revenue.correlationMode };
}

/** Addresses the indexer must also watch so funding inflows in separate transactions are observed. */
export function revenueWatchAddresses(r: Pick<RevenueRuntime, "fundingDestinations"> | null | undefined): string[] {
  return r ? [...new Set(r.fundingDestinations)] : [];
}

/** Launch facts for revenue classification, from the loaded provider (and its verified destination spec). */
export function revenueFactsOf(provider: LaunchProvider, r: RevenueRuntime): RevenueLaunchFacts {
  const info = provider.info();
  const inner = provider instanceof MigrationAwareProvider ? provider.inner : provider;
  const dest = provider instanceof MigrationAwareProvider ? provider.destination : null;
  const pc = inner instanceof RaydiumLaunchLabProvider ? inner.platformConfigState() : null;
  const vaults = info.provider === "meteora_dbc" ? [info.accounts.quoteVault, info.accounts.baseVault] : info.provider === "raydium_launchlab" ? [info.accounts.creatorFeeVault] : [info.accounts.creatorClaimVault];
  let destination: RevenueLaunchFacts["destination"] = null;
  if (dest instanceof CpmmDestination) {
    const f = dest.facts;
    const locks = f.allPlatformLocks ?? f.platformLocks ?? null;
    destination = { pool: dest.pool, kind: dest.kind, migrationSlot: dest.migrationSlot, token0Mint: f.token0Mint, token1Mint: f.token1Mint, token0Vault: f.token0Vault, token1Vault: f.token1Vault, poolCreator: f.poolCreator, platformLocks: locks ? locks.map((l) => l.lockPda) : null, platformNftWallet: f.platformNftWallet ?? pc?.platformLockNftWallet ?? null };
  } else if (dest) {
    destination = { pool: dest.pool, kind: dest.kind, migrationSlot: dest.migrationSlot, platformLocks: null, platformNftWallet: null };
  }
  return {
    provider: info.provider,
    tokenMint: info.tokenMint,
    quoteMint: info.quoteMint,
    sourcePool: info.poolAddress,
    creator: info.creator || null,
    role: info.feeBeneficiaryRole,
    creatorClaimVaults: vaults.filter((v): v is string => !!v),
    destination,
    fundingDestinations: r.fundingDestinations,
    forgePlatformLpBeneficiary: r.forgePlatformLpBeneficiary,
  };
}

interface Verdict {
  verification: RevenueSnapshot["verification"];
  problems: string[];
  effectiveFeeConfig: RevenueSnapshot["effectiveFeeConfig"];
}

/** Why a collection / inflow is (not) verified, from the launch facts and (LaunchLab) the shared vault history. */
async function verdictOf(db: Models, d: RevenueDraft, f: RevenueLaunchFacts, provider: LaunchProvider): Promise<Verdict> {
  const info = provider.info();
  const problems: string[] = [];
  if (d.stream === "bonding_curve_creator_fee") {
    if (!f.creator) problems.push("missing_creator_association");
    else if (d.beneficiary !== f.creator) problems.push(`recipient ${d.beneficiary ?? "?"} is not the pool creator ${f.creator} (creator wallet changed or claim paid elsewhere)`);
    const v = info.allocation?.verification ?? "not_declared";
    if (v !== "verified") problems.push(`bonding_curve_allocation_${v}${info.allocation?.problems.length ? `: ${info.allocation.problems.join("; ")}` : ""}`);
    if (info.provider === "raydium_launchlab" && (await sharedVaultMixed(db, f.sourcePool, d.slot))) problems.push("shared_creator_vault_mixed_with_other_pools: the claim includes other pools' creator fees and cannot be apportioned");
    return { verification: problems.length ? (v === "mismatch" ? "mismatch" : "unverifiable") : "verified", problems, effectiveFeeConfig: { creatorFeeRate: (info.feeParams.creatorFeeRate as string | number | undefined) ?? (info.feeParams.creatorTradingFeePercentage as string | number | undefined) ?? null, bondingBasis: info.allocation?.id ?? null } };
  }
  if (d.stream === "forge_platform_lp_fee_collection") {
    const wallet = f.destination?.platformNftWallet ?? null;
    if (!f.forgePlatformLpBeneficiary) problems.push("forge_platform_lp_beneficiary_not_declared (FORGE_PLATFORM_LP_BENEFICIARY)");
    if (!wallet) problems.push("platform_nft_wallet_unknown");
    let mismatch = false;
    if (wallet && f.forgePlatformLpBeneficiary && wallet !== f.forgePlatformLpBeneficiary) {
      mismatch = true;
      problems.push(`PlatformConfig platform_nft_wallet ${wallet} ≠ declared FORGE_PLATFORM_LP_BENEFICIARY ${f.forgePlatformLpBeneficiary}`);
    }
    if (d.evidence.platformLock !== true) problems.push("platform_lock_facts_unavailable: the stored migration spec does not record which locks are platform-owned");
    if (wallet && d.evidence.feeKeyHolder !== wallet) problems.push(`fee key holder ${String(d.evidence.feeKeyHolder)} is not the platform NFT wallet`);
    if (wallet && d.beneficiary !== wallet) problems.push(`collected fees were paid to ${d.beneficiary ?? "?"}, not the platform NFT wallet`);
    return { verification: problems.length ? (mismatch ? "mismatch" : "unverifiable") : "verified", problems, effectiveFeeConfig: { lockPda: String(d.evidence.lockPda), platformNftWallet: wallet, feeKeyOwnership: "platform" } };
  }
  if (d.stream === "cpmm_creator_trading_fee") {
    const a = info.destination?.allocation;
    if (f.destination?.poolCreator && d.beneficiary !== f.destination.poolCreator) problems.push("recipient is not the CPMM pool_creator");
    if (a && a.verification !== "verified") problems.push(`cpmm_creator_fee_basis_${a.verification}${a.problems.length ? `: ${a.problems.join("; ")}` : ""}`);
    const p = a?.params ?? {};
    return { verification: problems.length ? "unverifiable" : "verified", problems, effectiveFeeConfig: { creatorFeeRate: (p.creatorFeeRate as string) ?? null, creatorFeeOn: (p.creatorFeeOn as string) ?? null, ammConfigCreatorFeeShareRate: (p.creatorFeeShareRate as string) ?? null, creatorFeeShareOverride: (p.creatorFeeShareOverride as string) ?? null, effectiveCreatorFeeShareRate: (p.effectiveCreatorFeeShareRate as string) ?? null } };
  }
  // funding inflow: destination configured and owner/mint validated by the decoder.
  if (d.evidence.memo === "ambiguous") problems.push("multiple_distinct_last60_memos");
  return { verification: "verified", problems, effectiveFeeConfig: {} };
}

/** LaunchLab: did other pools deposit into the shared creator vault since the previous claim? */
async function sharedVaultMixed(db: Models, sourcePool: string, claimSlot: number): Promise<boolean> {
  const prev: any = await db.FeeClaim.findOne({ pool: sourcePool, slot: { $lt: claimSlot } }, { slot: 1 }).sort({ slot: -1 }).lean();
  return !!(await db.FeeAttribution.exists({ sourcePool, kind: "shared_vault_inflow", excludedReason: EXCLUSION.otherPoolSharedVault, slot: { $lte: claimSlot, ...(prev ? { $gt: prev.slot } : {}) } }));
}

export interface RevenueIngestResult {
  newEvents: number;
  newCredits: number;
}

/** Decode, verify and persist the revenue facts of one transaction, then reconcile the launch. Idempotent. */
export async function ingestRevenue(db: Models, tx: NormalizedTx, parsed: ParsedTransaction, provider: LaunchProvider, r: RevenueRuntime, opts: { commitment: "confirmed" | "finalized" }): Promise<RevenueIngestResult> {
  const f = revenueFactsOf(provider, r);
  const drafts = extractRevenue(tx, parsed, f);
  if (!drafts.length) return { newEvents: 0, newCredits: 0 };
  const info = provider.info();
  const ops = [];
  for (const d of drafts) {
    const v = await verdictOf(db, d, f, provider);
    const snapshot: RevenueSnapshot = {
      v: 1,
      stream: d.stream,
      launchPhase: d.launchPhase,
      provider: info.provider,
      sourcePool: f.sourcePool,
      pool: d.pool,
      tokenMint: f.tokenMint,
      feeMint: d.feeMint,
      beneficiaries: { creator: f.creator, platform: f.destination?.platformNftWallet ?? f.forgePlatformLpBeneficiary, last60Destinations: [...f.fundingDestinations] },
      policy: policySnapshot(r.policy),
      effectiveFeeConfig: v.effectiveFeeConfig,
      verification: v.verification,
      problems: v.problems,
    };
    const key = revenueEventKey(d);
    ops.push({
      updateOne: {
        filter: { key },
        update: {
          $setOnInsert: {
            key,
            kind: d.kind,
            stream: d.stream,
            chain: "solana",
            cluster: r.cluster,
            provider: info.provider,
            launchPhase: d.launchPhase,
            tokenMint: f.tokenMint,
            sourcePool: f.sourcePool,
            pool: d.pool,
            signature: d.signature,
            instructionIndex: d.instructionIndex,
            innerInstructionIndex: d.innerInstructionIndex,
            ordinal: d.ordinal,
            slot: d.slot,
            blockTime: d.blockTime ? new Date(d.blockTime * 1000) : null,
            feeMint: d.feeMint,
            asset: d.asset,
            decimals: d.decimals,
            grossAmount: d.grossAmount === null ? null : dec(d.grossAmount),
            netAmount: dec(d.netAmount),
            sourceAccount: d.sourceAccount,
            destinationAccount: d.destinationAccount,
            sourceOwner: d.sourceOwner,
            destinationOwner: d.destinationOwner,
            beneficiary: d.beneficiary,
            status: d.kind === "collection" ? (v.verification === "verified" ? "collected" : "unresolved") : v.problems.length ? "unresolved" : "observed",
            payoutEligible: false,
            excludedReason: v.problems[0] ?? null,
            memoClaimSignature: d.memoClaimSignature,
            evidence: d.evidence,
            snapshot,
            commitment: opts.commitment,
            createdAt: new Date(),
          },
        },
        upsert: true,
      },
    });
  }
  const res = await db.RevenueEvent.bulkWrite(ops, { ordered: false });
  const duplicates = drafts.length - (res.upsertedCount ?? 0);
  if (duplicates > 0) await db.SystemState.updateOne({ _id: "revenue_duplicates_rejected" }, { $inc: { "value.events": duplicates }, $set: { updatedAt: new Date() } }, { upsert: true });
  const newCredits = await reconcileFunding(db, { sourcePool: f.sourcePool, quoteMint: f.quoteMint, provider: info.provider, tokenMint: f.tokenMint }, r);
  return { newEvents: res.upsertedCount ?? 0, newCredits };
}

// ── reconciliation ──────────────────────────────────────────────────────────────────────────

const SPLIT_STREAMS: CollectionStream[] = ["bonding_curve_creator_fee", "forge_platform_lp_fee_collection"];

/**
 * Bonding-curve creator fees that accrued at or before the activation slot were already distributed
 * under the legacy policy (as REWARD_PERCENTAGE of creator-allocated fees). Collections after
 * activation absorb that unclaimed pre-activation balance first (FIFO), so it is never funded twice.
 * Returns the absorbed amount per bonding collection key.
 */
export async function preActivationAbsorption(db: Models, launch: { sourcePool: string; quoteMint: string }, policy: Pick<FundingPolicy, "activationSlot" | "version">): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (policy.version !== "forge_phase_aware_v1" || policy.activationSlot === null) return out;
  const act = policy.activationSlot;
  const [fees]: any[] = await db.Swap.aggregate([{ $match: { pool: launch.sourcePool, status: "active", feePhase: "bonding_curve", eligibleFeeMint: launch.quoteMint, slot: { $lte: act } } }, { $group: { _id: null, t: { $sum: "$eligibleFee" } } }]);
  const [claims]: any[] = await db.FeeClaim.aggregate([{ $match: { pool: launch.sourcePool, status: "confirmed", slot: { $lte: act } } }, { $group: { _id: null, t: { $sum: "$quoteAmount" } } }]);
  let remaining = big(fees?.t ?? 0) - big(claims?.t ?? 0);
  if (remaining < 0n) remaining = 0n;
  const cols: any[] = await db.RevenueEvent.find({ sourcePool: launch.sourcePool, stream: "bonding_curve_creator_fee", asset: assetOf(launch.quoteMint), slot: { $gt: act } }, { key: 1, netAmount: 1, slot: 1, ordinal: 1 }).sort({ slot: 1, ordinal: 1 }).lean();
  for (const c of cols) {
    const gross = big(c.netAmount);
    const absorbed = remaining < gross ? remaining : gross;
    remaining -= absorbed;
    out.set(c.key, absorbed);
  }
  return out;
}

function expectedLast60Of(c: any, absorbed: Map<string, bigint>): bigint | null {
  const split = SPLIT_OF[c.stream as CollectionStream];
  if (!split) return null;
  const p: PolicySnapshot = c.snapshot.policy;
  const bps = c.stream === "bonding_curve_creator_fee" ? p.bondingCreatorFeeLast60Bps : p.forgeLpLast60Bps;
  const gross = big(c.netAmount) - (absorbed.get(c.key) ?? 0n);
  return expectedSplit(gross < 0n ? 0n : gross, bps).last60;
}

function collectionFact(c: any, absorbed: Map<string, bigint>, linked: bigint): CollectionFact {
  return { key: c.key, stream: c.stream, signature: c.signature, slot: c.slot, ordinal: c.ordinal, asset: c.asset, recipient: c.beneficiary, gross: big(c.netAmount), expectedLast60: expectedLast60Of(c, absorbed), linked, verified: c.snapshot?.verification === "verified" && c.status === "collected" };
}

async function linkedTotals(db: Models, keys: string[]): Promise<Map<string, { observed: bigint; creditable: bigint }>> {
  const rows: any[] = keys.length ? await db.RewardFunding.aggregate([{ $match: { collectionKey: { $in: keys } } }, { $group: { _id: "$collectionKey", o: { $sum: "$observedAmount" }, c: { $sum: "$creditableAmount" } } }]) : [];
  return new Map(rows.map((x) => [x._id, { observed: big(x.o), creditable: big(x.c) }]));
}

/**
 * Link unlinked funding inflows of a launch to their collections, write credits (once per inflow) and
 * refresh the derived reconciliation rows. Returns the number of new credits. Idempotent.
 */
export async function reconcileFunding(db: Models, launch: { sourcePool: string; quoteMint: string; provider: string; tokenMint: string }, r: RevenueRuntime, opts: { limit?: number } = {}): Promise<number> {
  const limit = opts.limit ?? 500;
  const absorbed = await preActivationAbsorption(db, launch, r.policy);
  const touched = new Set<string>();
  let newCredits = 0;
  const unlinked: any[] = await db.RevenueEvent.aggregate([
    { $match: { sourcePool: launch.sourcePool, kind: "funding_inflow" } },
    { $lookup: { from: "reward_funding", localField: "key", foreignField: "key", as: "credit" } },
    { $match: { credit: { $size: 0 } } },
    { $sort: { slot: 1, ordinal: 1 } },
    { $limit: limit },
  ]);
  for (const t of unlinked) {
    const or: any[] = [{ signature: t.signature }];
    if (t.memoClaimSignature) or.push({ signature: t.memoClaimSignature });
    const base = { sourcePool: launch.sourcePool, kind: "collection", stream: { $in: SPLIT_STREAMS }, beneficiary: t.sourceOwner };
    const direct: any[] = await db.RevenueEvent.find({ ...base, $or: or }).lean();
    const window: any[] = r.correlationMode === "exclusive_window" ? await db.RevenueEvent.find({ ...base, asset: t.asset, slot: { $lte: t.slot } }).sort({ slot: -1, ordinal: -1 }).limit(200).lean() : [];
    const cands = [...new Map([...direct, ...window].map((c) => [c.key, c])).values()];
    const totals = await linkedTotals(db, cands.map((c) => c.key));
    const facts = cands.map((c) => collectionFact(c, absorbed, totals.get(c.key)?.observed ?? 0n));
    const tf: TransferFact = { key: t.key, signature: t.signature, slot: t.slot, ordinal: t.ordinal, asset: t.asset, sourceOwner: t.sourceOwner, destinationOwner: t.destinationOwner, amount: big(t.netAmount), memoClaimSignature: t.memoClaimSignature ?? null };
    const link = correlateTransfer(tf, facts, r.correlationMode);
    if (!link.linked) continue; // stays unlinked (reported); retried on the next pass (e.g. claim not yet indexed)
    const col = cands.find((c) => c.key === link.collectionKey)!;
    const fact = facts.find((c) => c.key === link.collectionKey)!;
    const already = totals.get(col.key)?.creditable ?? 0n;
    const expected = fact.expectedLast60 ?? 0n;
    const remaining = expected > already ? expected - already : 0n;
    const phaseAware = r.policy.version === "forge_phase_aware_v1" && r.policy.activationSlot !== null;
    const afterActivation = phaseAware && col.slot > r.policy.activationSlot! && t.slot > r.policy.activationSlot!;
    const reasons: string[] = [];
    if (!fact.verified) reasons.push(`collection_not_verified: ${(col.snapshot?.problems ?? []).join("; ") || col.status}`);
    if (!phaseAware) reasons.push(`policy_${r.policy.version}_does_not_fund_from_contributions`);
    else if (!afterActivation) reasons.push(`before_policy_activation_slot_${r.policy.activationSlot}`);
    if (t.status !== "observed") reasons.push(`inflow_${t.status}: ${t.excludedReason ?? ""}`);
    const amount = big(t.netAmount);
    const supported = fact.verified ? (amount < remaining ? amount : remaining) : 0n;
    const payable = reasons.length === 0 && supported > 0n;
    if (reasons.length === 0 && supported === 0n) reasons.push("exceeds_policy_amount: the claim's expected contribution is already fully funded");
    const split = SPLIT_OF[col.stream as CollectionStream]!;
    const snapshot: RevenueSnapshot = { ...col.snapshot, stream: split.contribution, feeMint: t.feeMint };
    const res = await db.RewardFunding.updateOne(
      { key: t.key },
      {
        $setOnInsert: {
          key: t.key,
          stream: split.contribution,
          collectionKey: col.key,
          correlationMethod: link.method,
          provider: launch.provider,
          tokenMint: launch.tokenMint,
          sourcePool: launch.sourcePool,
          pool: col.pool,
          signature: t.signature,
          ordinal: t.ordinal,
          slot: t.slot,
          collectionSlot: col.slot,
          blockTime: t.blockTime ?? null,
          fundingMint: t.asset,
          observedAmount: dec(amount),
          creditableAmount: dec(payable ? supported : 0n),
          excessAmount: dec(fact.verified ? amount - supported : 0n),
          status: payable ? "reconciled" : "unresolved",
          payoutEligible: payable,
          ineligibleReason: payable ? null : reasons.join(" | ").slice(0, 500),
          policy: policySnapshot(r.policy),
          snapshot,
          roundNumber: null,
          consumedAt: null,
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );
    if (res.upsertedCount) newCredits++;
    touched.add(col.key);
  }
  // Collections that have no reconciliation row yet (new claims, possibly never distributed).
  const missing: any[] = await db.RevenueEvent.aggregate([
    { $match: { sourcePool: launch.sourcePool, kind: "collection" } },
    { $lookup: { from: "revenue_reconciliations", localField: "key", foreignField: "key", as: "rec" } },
    { $match: { rec: { $size: 0 } } },
    { $limit: limit },
    { $project: { key: 1 } },
  ]);
  for (const m of missing) touched.add(m.key);
  for (const key of touched) await refreshReconciliation(db, key, absorbed);
  return newCredits;
}

/** Recompute the derived reconciliation row of one collection from its immutable event and credits. */
export async function refreshReconciliation(db: Models, collectionKey: string, absorbed: Map<string, bigint>): Promise<void> {
  const c: any = await db.RevenueEvent.findOne({ key: collectionKey }).lean();
  if (!c) return;
  const credits: any[] = await db.RewardFunding.find({ collectionKey }).sort({ slot: 1, ordinal: 1 }).lean();
  const fact = collectionFact(c, absorbed, 0n);
  const rec = reconcileCollection(fact, credits.map((x) => ({ key: x.key, amount: big(x.observedAmount), slot: x.slot, ordinal: x.ordinal })));
  const creditable = credits.reduce((s, x) => s + big(x.creditableAmount), 0n);
  const pre = absorbed.get(collectionKey) ?? 0n;
  await db.RevenueReconciliation.updateOne(
    { key: collectionKey },
    {
      $set: {
        key: collectionKey,
        stream: c.stream,
        provider: c.provider,
        tokenMint: c.tokenMint,
        sourcePool: c.sourcePool,
        pool: c.pool,
        collectionSignature: c.signature,
        collectionOrdinal: c.ordinal,
        collectionSlot: c.slot,
        collectionBlockTime: c.blockTime ?? null,
        feeMint: c.feeMint,
        asset: c.asset,
        decimals: c.decimals ?? null,
        recipient: c.beneficiary,
        creator: c.snapshot?.beneficiaries?.creator ?? null,
        gross: dec(rec.gross),
        expectedLast60: dec(rec.expectedLast60),
        expectedRetained: dec(rec.gross - rec.expectedLast60),
        actualLast60: dec(rec.actualLast60),
        creditable: dec(creditable),
        excess: dec(rec.excess),
        untransferred: dec(rec.untransferred),
        impliedRetained: dec(rec.impliedRetained),
        status: rec.status,
        verified: fact.verified,
        discrepancies: [...rec.discrepancies, ...(pre > 0n ? [`pre_activation_accrual_excluded: ${pre} (already distributed under the legacy policy)`] : [])],
        problems: c.snapshot?.problems ?? [],
        distributions: credits.map((x) => ({ transfer: x.key, signature: x.signature, ordinal: x.ordinal, slot: x.slot, method: x.correlationMethod, observed: big(x.observedAmount).toString(), creditable: big(x.creditableAmount).toString(), payoutEligible: x.payoutEligible, reason: x.ineligibleReason ?? null, roundNumber: x.roundNumber ?? null })),
        policy: c.snapshot?.policy ?? null,
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  );
}

/** Credits a round under the phase-aware policy may consume (not yet consumed, payable, in the payout asset). */
export function consumableFundingMatch(policy: FundingPolicy, snapshotSlot: number, payoutMint: string): Record<string, unknown> | null {
  if (!phaseAwareInForce(policy, snapshotSlot)) return null;
  return { payoutEligible: true, roundNumber: null, fundingMint: assetOf(payoutMint), "policy.version": "forge_phase_aware_v1", slot: { $gt: policy.activationSlot, $lte: snapshotSlot }, collectionSlot: { $gt: policy.activationSlot } };
}
