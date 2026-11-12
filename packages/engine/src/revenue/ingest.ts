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
 *   3. Forge's EXISTING post-migration creator payouts (route forge_creator_distribution: the platform
 *      Fee Key holder pays the launch creator its 50 % in a separate, memo-less transaction) are queued
 *      in `funding_attributions` and attributed by `attributeForgeDistributions` — launch-scoped,
 *      structural, complete-index evidence (accounting/revenueStreams.ts `attributeForgeDistribution`),
 *      never by amount; anything ambiguous is recorded and never payable.
 * Works in any order: a transfer indexed before its claim stays unlinked until the claim arrives;
 * a claim whose distribution never comes stays "awaiting_distribution" with its untransferred balance.
 */
import { PublicKey } from "@solana/web3.js";
import type { ClientSession } from "mongoose";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { Models } from "../db/models";
import { big, dec } from "../db/decimal";
import type { NormalizedTx } from "../chain/tx";
import type { LaunchProvider, ParsedTransaction, PoolInfo } from "../providers/LaunchProvider";
import { coveredThroughSlot, cursorId } from "../indexer/cursor";
import { MigrationAwareProvider } from "../providers/MigrationAwareProvider";
import { CpmmDestination } from "../providers/destination/cpmm";
import { RaydiumLaunchLabProvider } from "../providers/raydium/RaydiumLaunchLabProvider";
import { EXCLUSION } from "../accounting/attribution";
import {
  assetOf,
  attributeForgeDistribution,
  correlateTransfer,
  FORGE_CREATOR_DISTRIBUTION,
  CURRENT_PHASE_AWARE_VERSION,
  expectedSplit,
  isPhaseAwareVersion,
  PAYABLE_CORRELATION_METHODS,
  phaseAwareInForce,
  STREAM_INFO,
  policySnapshot,
  reconcileCollection,
  SPLIT_OF,
  type CollectionFact,
  type CollectionStream,
  type CorrelationMethod,
  type ForgeAttribution,
  type ForgeDistributionTx,
  type ForgeHarvestTx,
  type FundingCorrelationMode,
  type FundingPolicy,
  type PolicySnapshot,
  type RevenueSnapshot,
  type TransferFact,
} from "../accounting/revenueStreams";
import { extractRevenue, revenueEventKey, type RevenueDraft, type RevenueLaunchFacts } from "./decode";
import { claimTransferUse, ingestCustodyTransfers, transferKeyOf } from "../custody/custody";

export interface RevenueRuntime {
  cluster: string;
  policy: FundingPolicy;
  fundingDestinations: string[];
  forgePlatformLpBeneficiary: string | null;
  correlationMode: FundingCorrelationMode;
  /** Custody workflow (memo-matched custody transfers into the dedicated payout wallet). */
  custody?: { enabled: boolean; payoutWallet: string | null; requestTtlMs?: number };
}

/** Revenue runtime from the application configuration (null when the config predates PR #6, e.g. tests). */
export function revenueRuntimeOf(cfg: { solana: { cluster: string }; revenue?: { policy: FundingPolicy; fundingDestinations: string[]; forgePlatformLpBeneficiary: string | null; correlationMode: FundingCorrelationMode; custody?: RevenueRuntime["custody"]; activation?: { pending: boolean } } }): RevenueRuntime | null {
  if (!cfg.revenue?.policy) return null;
  // An automatic activation slot not yet pinned (resolveFundingActivation runs at boot): record nothing
  // rather than stamp records with a placeholder policy (fail closed).
  if (cfg.revenue.activation?.pending) return null;
  return { cluster: cfg.solana.cluster, policy: cfg.revenue.policy, fundingDestinations: cfg.revenue.fundingDestinations, forgePlatformLpBeneficiary: cfg.revenue.forgePlatformLpBeneficiary, correlationMode: cfg.revenue.correlationMode, custody: cfg.revenue.custody };
}

/**
 * Forge's associated token account for the launch token: the account its LP harvests credit (the SDK's
 * `harvestLockLp` uses the owner's ATA for the non-WSOL leg) and its creator payouts debit (Forgepad
 * `sendPayouts`). Watching it from the migration slot observes exactly this launch's harvests and
 * anchored payouts — without reading the platform wallet's whole, multi-launch history.
 * Empty unless the Forge beneficiary is declared and a verified LaunchLab → CPMM destination is attached.
 */
export function forgeDistributionWatch(info: Pick<PoolInfo, "tokenMint" | "baseTokenProgram" | "destination">, r: Pick<RevenueRuntime, "forgePlatformLpBeneficiary"> | null | undefined): { address: string; fromSlot: number }[] {
  const d = info.destination;
  if (!r?.forgePlatformLpBeneficiary || !d || d.kind !== "launchlab_cpmm" || !d.supported) return [];
  try {
    const ata = getAssociatedTokenAddressSync(new PublicKey(info.tokenMint), new PublicKey(r.forgePlatformLpBeneficiary), true, new PublicKey(info.baseTokenProgram)).toBase58();
    return [{ address: ata, fromSlot: d.migrationSlot }];
  } catch {
    return []; // unknown token program / invalid keys: nothing to watch, attribution stays pending (fail closed)
  }
}

/** Addresses the indexer must also watch so funding inflows in separate transactions are observed. */
export function revenueWatchAddresses(r: (Pick<RevenueRuntime, "fundingDestinations"> & Partial<Pick<RevenueRuntime, "forgePlatformLpBeneficiary" | "custody">>) | null | undefined, info?: Pick<PoolInfo, "tokenMint" | "baseTokenProgram" | "destination"> | null): string[] {
  if (!r) return [];
  const forge = info && "forgePlatformLpBeneficiary" in r ? forgeDistributionWatch(info, r as Pick<RevenueRuntime, "forgePlatformLpBeneficiary">).map((w) => w.address) : [];
  // The dedicated payout wallet is watched when custody is enabled (memo-matched custody transfers).
  const payout = r.custody?.enabled && r.custody.payoutWallet ? [r.custody.payoutWallet] : [];
  return [...new Set([...r.fundingDestinations, ...forge, ...payout])];
}

/** Launch facts the Forge creator-distribution attribution needs (null: the route is not applicable). */
export interface ForgeLaunchContext {
  creator: string;
  tokenMint: string;
  forgeWallet: string;
  /** Cursor ids whose coverage must reach a distribution's slot (destination pool + Forge's token account). */
  coverageKeys: string[];
}

export function forgeLaunchContextOf(provider: LaunchProvider, r: RevenueRuntime): ForgeLaunchContext | null {
  const info = provider.info();
  const d = info.destination;
  if (!r.forgePlatformLpBeneficiary || !info.creator || !d || d.kind !== "launchlab_cpmm") return null;
  const watch = forgeDistributionWatch(info, r);
  if (!watch.length) return null;
  return { creator: info.creator, tokenMint: info.tokenMint, forgeWallet: r.forgePlatformLpBeneficiary, coverageKeys: [d.pool, ...watch.map((w) => w.address)].map((a) => cursorId(info.provider, info.poolAddress, a)) };
}

/** Launch facts for revenue classification, from the loaded provider (and its verified destination spec). */
export function revenueFactsOf(provider: LaunchProvider, r: RevenueRuntime): RevenueLaunchFacts {
  const info = provider.info();
  const inner = provider instanceof MigrationAwareProvider ? provider.inner : provider;
  const dest = provider instanceof MigrationAwareProvider ? provider.destination : null;
  const pc = inner instanceof RaydiumLaunchLabProvider ? inner.platformConfigState() : null;
  const vaults = info.provider === "meteora_dbc" ? [info.accounts.quoteVault, info.accounts.baseVault] : info.provider === "raydium_launchlab" ? [info.accounts.creatorFeeVault] : info.provider === "pump_fun" ? [info.accounts.creatorVault] : [info.accounts.creatorClaimVault];
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
    if ((info.provider === "raydium_launchlab" || info.provider === "pump_fun") && (await sharedVaultMixed(db, f.sourcePool, d.slot))) problems.push("shared_creator_vault_mixed_with_other_pools: the claim includes other pools' creator fees and cannot be apportioned");
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
  if (d.stream === "damm_v2_creator_lp_fee") {
    // Meteora DBC → DAMM v2: LP fees the creator claimed from a migration position of the verified destination.
    const a = info.destination?.allocation;
    if (!f.creator) problems.push("missing_creator_association");
    else if (d.beneficiary !== f.creator) problems.push(`recipient ${d.beneficiary ?? "?"} is not the launch creator ${f.creator}`);
    if (d.evidence.positionOwner !== f.creator) problems.push(`position NFT holder ${String(d.evidence.positionOwner ?? "?")} is not the launch creator`);
    if (!f.destination || f.destination.kind !== "dbc_damm_v2") problems.push("no_verified_damm_v2_destination");
    const v = a?.verification ?? "not_declared";
    if (v !== "verified") problems.push(`migrated_lp_allocation_${v}${a?.problems.length ? `: ${a.problems.join("; ")}` : ""}`);
    return { verification: problems.length ? (v === "mismatch" ? "mismatch" : "unverifiable") : "verified", problems, effectiveFeeConfig: { position: String(d.evidence.position ?? ""), migratedLpBasis: a?.id ?? null, creatorLpPercentage: (info.feeParams.creatorLpPercentage as string | number | undefined) ?? null } };
  }
  if (d.stream === "pumpswap_creator_fee") {
    // pump.fun → PumpSwap: coin creator fees the launch creator collected from its PumpSwap vault.
    const a = info.destination?.allocation;
    if (!f.creator) problems.push("missing_creator_association");
    else if (d.beneficiary !== f.creator) problems.push(`recipient ${d.beneficiary ?? "?"} is not the launch creator ${f.creator}`);
    if (!f.destination || f.destination.kind !== "pumpfun_pumpswap") problems.push("no_verified_pumpswap_destination");
    const v = a?.verification ?? "not_declared";
    if (v !== "verified") problems.push(`pumpswap_creator_fee_basis_${v}${a?.problems.length ? `: ${a.problems.join("; ")}` : ""}`);
    // The vault is shared by every graduated coin of the creator: a collection that includes another
    // pool's fees cannot be apportioned to this launch.
    if (f.destination && (await sharedVaultMixed(db, f.sourcePool, d.slot, f.destination.pool))) problems.push("shared_creator_vault_mixed_with_other_pools: the collection includes other coins' creator fees and cannot be apportioned");
    return { verification: problems.length ? (v === "mismatch" ? "mismatch" : "unverifiable") : "verified", problems, effectiveFeeConfig: { coinCreator: (a?.params?.coinCreator as string | undefined) ?? null, creatorVault: String(d.evidence.vault ?? ""), pumpswapBasis: a?.id ?? null } };
  }
  if (d.stream === "cpmm_creator_trading_fee") {
    const a = info.destination?.allocation;
    if (f.destination?.poolCreator && d.beneficiary !== f.destination.poolCreator) problems.push("recipient is not the CPMM pool_creator");
    if (a && a.verification !== "verified") problems.push(`cpmm_creator_fee_basis_${a.verification}${a.problems.length ? `: ${a.problems.join("; ")}` : ""}`);
    const p = a?.params ?? {};
    return { verification: problems.length ? "unverifiable" : "verified", problems, effectiveFeeConfig: { creatorFeeRate: (p.creatorFeeRate as string) ?? null, creatorFeeOn: (p.creatorFeeOn as string) ?? null, ammConfigCreatorFeeShareRate: (p.creatorFeeShareRate as string) ?? null, creatorFeeShareOverride: (p.creatorFeeShareOverride as string) ?? null, effectiveCreatorFeeShareRate: (p.effectiveCreatorFeeShareRate as string) ?? null } };
  }
  // funding inflow: destination configured and owner/mint validated by the decoder.
  if (d.route === FORGE_CREATOR_DISTRIBUTION) {
    if (d.evidence.problems) problems.push(...String(d.evidence.problems).split(" | "));
    if (d.destinationOwner !== f.creator) problems.push(`recipient_not_launch_creator: ${d.destinationOwner ?? "?"}`);
    return { verification: problems.length ? "unverifiable" : "verified", problems, effectiveFeeConfig: {} };
  }
  if (d.evidence.memo === "ambiguous") problems.push("multiple_distinct_last60_memos");
  return { verification: "verified", problems, effectiveFeeConfig: {} };
}

/** LaunchLab / pump.fun: did other pools deposit into the shared creator vault since the previous claim? */
async function sharedVaultMixed(db: Models, sourcePool: string, claimSlot: number, destinationPool: string | null = null): Promise<boolean> {
  // Bonding-curve vault by default; with `destinationPool`, the vault of that graduation destination.
  const prev: any = await db.FeeClaim.findOne({ pool: destinationPool ?? sourcePool, slot: { $lt: claimSlot } }, { slot: 1 }).sort({ slot: -1 }).lean();
  return !!(await db.FeeAttribution.exists({ sourcePool, destinationPool, kind: "shared_vault_inflow", excludedReason: EXCLUSION.otherPoolSharedVault, slot: { $lte: claimSlot, ...(prev ? { $gt: prev.slot } : {}) } }));
}

export interface RevenueIngestResult {
  newEvents: number;
  newCredits: number;
}

/** Decode, verify and persist the revenue facts of one transaction, then reconcile the launch. Idempotent. */
export async function ingestRevenue(db: Models, tx: NormalizedTx, parsed: ParsedTransaction, provider: LaunchProvider, r: RevenueRuntime, opts: { commitment: "confirmed" | "finalized" }): Promise<RevenueIngestResult> {
  const f = revenueFactsOf(provider, r);
  // Custody transfers (last60:custody:v1 memo) are matched to their open request; they are never revenue.
  await ingestCustodyTransfers(db, tx, r.custody, opts.commitment);
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
            route: d.route,
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
  // Forge creator-distribution legs enter the attribution queue (idempotent; re-ingestion of the
  // transaction after a crash between the two writes re-seeds it). Only legs whose event row is the
  // forge route (an inflow first recorded on another route is never reinterpreted).
  const forgeDrafts = drafts.filter((d) => d.route === FORGE_CREATOR_DISTRIBUTION);
  if (forgeDrafts.length) {
    const keys = forgeDrafts.map((d) => revenueEventKey(d));
    const stored: any[] = await db.RevenueEvent.find({ key: { $in: keys }, sourcePool: f.sourcePool, route: FORGE_CREATOR_DISTRIBUTION }, { key: 1, signature: 1, slot: 1, ordinal: 1, asset: 1, netAmount: 1, sourceOwner: 1, destinationOwner: 1 }).lean();
    if (stored.length) {
      await db.FundingAttribution.bulkWrite(
        stored.map((e) => ({ updateOne: { filter: { key: e.key }, update: { $setOnInsert: { key: e.key, route: FORGE_CREATOR_DISTRIBUTION, sourcePool: f.sourcePool, tokenMint: f.tokenMint, signature: e.signature, slot: e.slot, ordinal: e.ordinal, asset: e.asset, amount: e.netAmount, sourceOwner: e.sourceOwner, destinationOwner: e.destinationOwner, status: "pending", payoutEligible: false, reasons: [], candidates: [], evaluations: 0, createdAt: new Date() } }, upsert: true } })),
        { ordered: false },
      );
    }
  }
  const newCredits = await reconcileFunding(db, { sourcePool: f.sourcePool, quoteMint: f.quoteMint, provider: info.provider, tokenMint: f.tokenMint, forge: forgeLaunchContextOf(provider, r) }, r);
  return { newEvents: res.upsertedCount ?? 0, newCredits };
}

// ── reconciliation ──────────────────────────────────────────────────────────────────────────

const SPLIT_STREAMS: CollectionStream[] = ["bonding_curve_creator_fee", "forge_platform_lp_fee_collection", "damm_v2_creator_lp_fee", "pumpswap_creator_fee"];

/**
 * Bonding-curve creator fees that accrued at or before the activation slot were already distributed
 * under the legacy policy (as REWARD_PERCENTAGE of creator-allocated fees). Collections after
 * activation absorb that unclaimed pre-activation balance first (FIFO), so it is never funded twice.
 * Returns the absorbed amount per bonding collection key.
 */
export async function preActivationAbsorption(db: Models, launch: { sourcePool: string; quoteMint: string }, policy: Pick<FundingPolicy, "activationSlot" | "version">): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (!isPhaseAwareVersion(policy.version) || policy.activationSlot === null) return out;
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
  // The DAMM v2 creator LP stream funds rewards at the bonding-curve creator share (revenueStreams.ts).
  const bps = c.stream === "forge_platform_lp_fee_collection" ? p.forgeLpLast60Bps : p.bondingCreatorFeeLast60Bps;
  const gross = big(c.netAmount) - (absorbed.get(c.key) ?? 0n);
  return expectedSplit(gross < 0n ? 0n : gross, bps).last60;
}

function collectionFact(c: any, absorbed: Map<string, bigint>, linked: bigint): CollectionFact {
  return { key: c.key, stream: c.stream, signature: c.signature, slot: c.slot, ordinal: c.ordinal, asset: c.asset, recipient: c.beneficiary, gross: big(c.netAmount), expectedLast60: expectedLast60Of(c, absorbed), linked, verified: c.snapshot?.verification === "verified" && c.status === "collected" };
}

export async function linkedTotals(db: Models, keys: string[], excludeCredits: string[] = [], session?: ClientSession): Promise<Map<string, { observed: bigint; creditable: bigint }>> {
  const agg = () => {
    const a = db.RewardFunding.aggregate([{ $match: { collectionKey: { $in: keys }, ...(excludeCredits.length ? { key: { $nin: excludeCredits } } : {}) } }, { $group: { _id: "$collectionKey", o: { $sum: "$observedAmount" }, c: { $sum: "$creditableAmount" } } }]);
    return session ? a.session(session) : a;
  };
  const rows: any[] = keys.length ? await agg() : [];
  return new Map(rows.map((x) => [x._id, { observed: big(x.o), creditable: big(x.c) }]));
}

export type LaunchRef = { sourcePool: string; quoteMint: string; provider: string; tokenMint: string; forge?: ForgeLaunchContext | null };

/**
 * Write the ONE credit of a funding inflow linked to a collection ($setOnInsert on the inflow key:
 * concurrent or repeated passes can never write a second one, nor change the first). Every policy
 * condition is evaluated here, for every correlation method alike; `o.supported` lets a method bound
 * the creditable amount further (never raise it) and `o.extraReasons` add method-specific refusals.
 */
export async function writeCredit(
  db: Models,
  launch: LaunchRef,
  r: RevenueRuntime,
  t: any,
  col: any,
  fact: CollectionFact,
  method: CorrelationMethod,
  alreadyCreditable: bigint,
  o: { supported?: bigint; excess?: bigint; extraReasons?: string[]; attribution?: Record<string, unknown> | null; session?: ClientSession } = {},
): Promise<{ inserted: boolean; payable: boolean; reasons: string[] }> {
  // One on-chain transfer, one use: a transfer already used as a custody transfer is never also a
  // contribution (and the reservation makes a later custody binding of this transfer impossible).
  const use = await claimTransferUse(db, { key: transferKeyOf(t.signature, t.ordinal), use: "reward_funding", ref: t.key, signature: t.signature, ordinal: t.ordinal }, o.session);
  if (!use.ok) return { inserted: false, payable: false, reasons: [`transfer_already_used_as_${use.existing}`] };
  const expected = fact.expectedLast60 ?? 0n;
  const remaining = expected > alreadyCreditable ? expected - alreadyCreditable : 0n;
  const phaseAware = r.policy.version === CURRENT_PHASE_AWARE_VERSION && r.policy.activationSlot !== null;
  const afterActivation = phaseAware && col.slot > r.policy.activationSlot! && t.slot > r.policy.activationSlot!;
  const split = SPLIT_OF[col.stream as CollectionStream]!;
  // Creator attribution: both Last-60 contributions are creator allocations (75 % of the creator's
  // bonding fee; the creator's 50 % allocation of Forge's LP claims) and must name the launch creator.
  const creator: string | null = col.snapshot?.beneficiaries?.creator ?? null;
  const forgeRoute = t.route === FORGE_CREATOR_DISTRIBUTION;
  const reasons: string[] = [...(o.extraReasons ?? [])];
  if (!fact.verified) reasons.push(`collection_not_verified: ${(col.snapshot?.problems ?? []).join("; ") || col.status}`);
  if (!phaseAware) reasons.push(r.policy.version === "forge_phase_aware_v1" ? "policy_forge_phase_aware_v1_retired" : `policy_${r.policy.version}_does_not_fund_from_contributions`);
  else if (!afterActivation) reasons.push(`before_policy_activation_slot_${r.policy.activationSlot}`);
  if (!PAYABLE_CORRELATION_METHODS.includes(method)) reasons.push(`correlation_${method}_not_payable: the transfer does not name its claim (same transaction or last60:v1 memo required)`);
  if (method === "forge_distribution_sequence" && !forgeRoute) reasons.push("forge_distribution_sequence_requires_the_forge_creator_route");
  if (!creator) reasons.push("missing_creator_attribution");
  // Forge creator route: the funds reached the launch creator (the creator's allocation, dedicated to
  // Last-60) — never another wallet, and only for a Forge platform LP claim.
  if (forgeRoute && t.destinationOwner !== creator) reasons.push(`recipient_${t.destinationOwner}_is_not_the_launch_creator_${creator}`);
  if (forgeRoute && col.stream !== "forge_platform_lp_fee_collection") reasons.push("forge_creator_route_only_settles_forge_platform_lp_claims");
  // The contribution must leave the wallet that actually received the claim (creator for bonding fees,
  // Forge's Fee Key holder for LP fees); correlation already enforces it — re-checked here explicitly.
  if (t.sourceOwner !== col.beneficiary) reasons.push(`source_${t.sourceOwner}_is_not_the_claim_recipient_${col.beneficiary}`);
  if (t.status !== "observed") reasons.push(`inflow_${t.status}: ${t.excludedReason ?? ""}`);
  const amount = big(t.netAmount);
  let supported = fact.verified ? (amount < remaining ? amount : remaining) : 0n;
  if (o.supported !== undefined && o.supported < supported) supported = o.supported;
  const payable = reasons.length === 0 && supported > 0n;
  if (reasons.length === 0 && supported === 0n) reasons.push("exceeds_policy_amount: the claim's expected contribution is already fully funded");
  const excess = o.excess !== undefined ? o.excess : fact.verified ? amount - supported : 0n;
  const snapshot: RevenueSnapshot = { ...col.snapshot, stream: split.contribution, feeMint: t.feeMint };
  const res = await db.RewardFunding.updateOne(
    { key: t.key },
    {
      $setOnInsert: {
        key: t.key,
        stream: split.contribution,
        collectionKey: col.key,
        correlationMethod: method,
        route: t.route ?? "last60_destination",
        attribution: o.attribution ?? null,
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
        // Funding contribution record (docs/REWARD_FUNDING.md §5): the claim, its expected allocation
        // and the observed payment are kept side by side and never merged.
        launchPhase: col.launchPhase,
        collectionSignature: col.signature,
        collectedAmount: dec(big(col.netAmount)),
        expectedAllocation: dec(expected),
        sourceWallet: t.sourceOwner,
        destinationWallet: t.destinationOwner,
        creator,
        allocationOwner: STREAM_INFO[split.contribution].allocationOwner,
        policyVersion: r.policy.version,
        observedAmount: dec(amount),
        creditableAmount: dec(payable ? supported : 0n),
        excessAmount: dec(excess < 0n ? 0n : excess),
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
    { upsert: true, ...(o.session ? { session: o.session } : {}) },
  );
  return { inserted: !!res.upsertedCount, payable, reasons };
}

/**
 * Link unlinked funding inflows of a launch to their collections, write credits (once per inflow) and
 * refresh the derived reconciliation rows. Returns the number of new credits. Idempotent.
 */
export async function reconcileFunding(db: Models, launch: LaunchRef, r: RevenueRuntime, opts: { limit?: number } = {}): Promise<number> {
  const limit = opts.limit ?? 500;
  const absorbed = await preActivationAbsorption(db, launch, r.policy);
  const touched = new Set<string>();
  let newCredits = 0;
  // Inflows into Last-60 funding destinations (PR #6 / #7 behaviour, unchanged). Forge creator
  // distributions are attributed separately, from their bounded queue (below).
  const unlinked: any[] = await db.RevenueEvent.aggregate([
    { $match: { sourcePool: launch.sourcePool, kind: "funding_inflow", route: { $ne: FORGE_CREATOR_DISTRIBUTION } } },
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
    const link = correlateTransfer(transferFact(t), facts, r.correlationMode);
    if (!link.linked) continue; // stays unlinked (reported); retried on the next pass (e.g. claim not yet indexed)
    const col = cands.find((c) => c.key === link.collectionKey)!;
    const fact = facts.find((c) => c.key === link.collectionKey)!;
    const w = await writeCredit(db, launch, r, t, col, fact, link.method, totals.get(col.key)?.creditable ?? 0n);
    if (w.inserted) newCredits++;
    touched.add(col.key);
  }
  if (launch.forge) {
    const f = await attributeForgeDistributions(db, launch, launch.forge, r, absorbed, limit);
    newCredits += f.newCredits;
    for (const k of f.touched) touched.add(k);
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

const transferFact = (t: any): TransferFact => ({ key: t.key, signature: t.signature, slot: t.slot, ordinal: t.ordinal, asset: t.asset, sourceOwner: t.sourceOwner, destinationOwner: t.destinationOwner, amount: big(t.netAmount), memoClaimSignature: t.memoClaimSignature ?? null });

/** Bounds of the attribution window queries; hitting one makes the decision `candidate_window_too_large`. */
const HARVEST_ROWS = 24;
const WINDOW_DISTRIBUTION_ROWS = 64;

/**
 * Attribute queued Forge creator distributions of ONE launch (route forge_creator_distribution).
 * Bounded and indexed: reads only `pending` queue rows of this launch (oldest first), and per
 * distribution only the launch's latest harvests at or before its slot and the launch's other
 * distributions in [previous harvest, distribution]. Never scans the platform wallet's or the
 * launch's whole history; other launches (other mints / creators) are never candidates.
 *
 * Decisions are deterministic functions of indexed events (never of credits already written), so
 * repeated, concurrent or restarted passes reach the same decision; credits are written once
 * ($setOnInsert) and a decided row is never re-evaluated.
 */
export async function attributeForgeDistributions(db: Models, launch: LaunchRef, forge: ForgeLaunchContext, r: RevenueRuntime, absorbed: Map<string, bigint>, limit = 500): Promise<{ newCredits: number; touched: Set<string>; decided: number }> {
  const touched = new Set<string>();
  let newCredits = 0;
  let decided = 0;
  const queue: any[] = await db.FundingAttribution.find({ sourcePool: launch.sourcePool, status: "pending" }, { signature: 1, slot: 1 }).sort({ slot: 1, ordinal: 1 }).limit(limit).lean();
  if (!queue.length) return { newCredits, touched, decided };
  const covered = await forgeCoverage(db, forge);
  const signatures = [...new Set(queue.map((q) => q.signature))];
  const writer: CreditWriter = async (p) => {
    const w = await writeCredit(db, launch, r, p.t, p.col, p.fact, p.method, p.alreadyCreditable, p.o);
    if (w.inserted) newCredits++;
    touched.add(p.col.key);
    return w;
  };
  for (const sig of signatures) {
    const ev = await evaluateForgeDistribution(db, launch, forge, absorbed, sig, covered, writer);
    if (!ev) continue;
    // Record the decisions (pending → decided, conditionally; a decided row is never rewritten).
    for (const e of ev.legsAll) {
      const dcs = ev.decisions.get(e.key);
      if (!dcs) continue;
      const credit: any = dcs.status === "linked" ? await db.RewardFunding.findOne({ key: e.key }, { collectionKey: 1, collectionSignature: 1, correlationMethod: 1, payoutEligible: 1, ineligibleReason: 1 }).lean() : null;
      const set: Record<string, unknown> = { evaluatedAt: new Date(), reasons: credit ? (credit.ineligibleReason ? String(credit.ineligibleReason).split(" | ") : []) : dcs.reasons, candidates: dcs.candidates, evidence: dcs.evidence ?? null };
      if (dcs.status !== "pending") {
        Object.assign(set, { status: dcs.status, payoutEligible: !!credit?.payoutEligible, collectionKey: credit?.collectionKey ?? null, collectionSignature: credit?.collectionSignature ?? null, correlationMethod: credit?.correlationMethod ?? null });
        decided++;
      }
      await db.FundingAttribution.updateOne({ key: e.key, status: "pending" }, { $set: set, $inc: { evaluations: 1 } });
    }
  }
  return { newCredits, touched, decided };
}

/** Indexing coverage of the launch's Forge attribution addresses (min over cursors; null = unknown). */
export async function forgeCoverage(db: Models, forge: ForgeLaunchContext): Promise<number | null> {
  const coverages = await Promise.all(forge.coverageKeys.map((k) => coveredThroughSlot(db, k)));
  return coverages.some((c) => c === null) ? null : Math.min(...(coverages as number[]));
}

/** Everything `writeCredit` needs for one linked leg (the deterministic result of the attribution). */
export interface CreditPlan {
  t: any;
  col: any;
  fact: CollectionFact;
  method: CorrelationMethod;
  /** Creditable amount already linked to the collection by OTHER transfers (bounds this credit). */
  alreadyCreditable: bigint;
  o: { supported?: bigint; excess?: bigint; extraReasons?: string[]; attribution?: Record<string, unknown> | null };
  /** Credit keys excluded when `alreadyCreditable` was computed (re-checked by recovery). */
  excludeKeys: string[];
}
export type CreditWriter = (p: CreditPlan) => Promise<{ inserted: boolean; payable: boolean; reasons: string[] }>;
export interface ForgeLegDecisionRecord {
  status: "linked" | "unresolved" | "pending";
  reasons: string[];
  candidates: string[];
  collection?: any;
  method?: CorrelationMethod;
  payable?: boolean;
  evidence?: Record<string, unknown>;
  /** For linked legs: the credit the normal algorithm writes. */
  plan?: CreditPlan;
  /** For sequence attributions: the pure attribution result. */
  attribution?: ForgeAttribution;
}

/**
 * The normal, deterministic attribution of ONE Forge creator-distribution transaction (explicit
 * same-transaction / memo evidence first, then the structural sequence attribution). Used by the
 * attribution pass (with a writer that writes credits) and — unchanged — by operator recovery, which
 * passes `write = null` to obtain the decisions and credit plans without writing anything.
 */
export async function evaluateForgeDistribution(db: Models, launch: LaunchRef, forge: ForgeLaunchContext, absorbed: Map<string, bigint>, sig: string, covered: number | null, write: CreditWriter | null): Promise<{ legsAll: any[]; decisions: Map<string, ForgeLegDecisionRecord>; slot: number; harvestCandidates: string[]; windowTruncated: boolean } | null> {
  const legsAll: any[] = await db.RevenueEvent.find({ sourcePool: launch.sourcePool, kind: "funding_inflow", route: FORGE_CREATOR_DISTRIBUTION, signature: sig }).sort({ ordinal: 1 }).lean();
  if (!legsAll.length) return null;
  const run: CreditWriter = write ?? (async () => ({ inserted: false, payable: false, reasons: [] }));
  const slot = legsAll[0].slot;
  const toCreator = legsAll.filter((e) => e.destinationOwner === forge.creator);
  const decisions = new Map<string, ForgeLegDecisionRecord>();
  for (const e of legsAll) if (e.destinationOwner !== forge.creator) decisions.set(e.key, { status: "unresolved", reasons: [`recipient_not_launch_creator: ${e.destinationOwner ?? "?"} (Forge outflow in a creator-distribution transaction; never Asteroid Protocol funding)`], candidates: [] });
  let harvestCandidates: string[] = [];
  let windowTruncated = false;

  // (a) Explicit evidence first: same transaction as the harvest, or a last60:v1 memo naming it.
  const remainingLegs: any[] = [];
  for (const t of toCreator) {
    const or: any[] = [{ signature: t.signature }];
    if (t.memoClaimSignature) or.push({ signature: t.memoClaimSignature });
    const cands: any[] = await db.RevenueEvent.find({ sourcePool: launch.sourcePool, kind: "collection", stream: "forge_platform_lp_fee_collection", beneficiary: t.sourceOwner, $or: or }).lean();
    if (!cands.length) {
      remainingLegs.push(t);
      continue;
    }
    const totals = await linkedTotals(db, cands.map((c) => c.key), [t.key]);
    const facts = cands.map((c) => collectionFact(c, absorbed, totals.get(c.key)?.observed ?? 0n));
    const link = correlateTransfer(transferFact(t), facts, "strict");
    if (!link.linked) {
      remainingLegs.push(t);
      continue;
    }
    const col = cands.find((c) => c.key === link.collectionKey)!;
    const plan: CreditPlan = { t, col, fact: facts.find((c) => c.key === col.key)!, method: link.method, alreadyCreditable: totals.get(col.key)?.creditable ?? 0n, o: {}, excludeKeys: [t.key] };
    const w = await run(plan);
    decisions.set(t.key, { status: "linked", reasons: w.reasons, candidates: [col.signature], collection: col, method: link.method, payable: w.payable, plan });
  }

  // (b) Forge's existing memo-less payout: structural sequence attribution.
  if (remainingLegs.length) {
    const harvestRows: any[] = await db.RevenueEvent.find({ sourcePool: launch.sourcePool, stream: "forge_platform_lp_fee_collection", slot: { $lte: slot } }).sort({ slot: -1, ordinal: -1 }).limit(HARVEST_ROWS).lean();
    const harvests = groupHarvests(harvestRows, absorbed);
    harvestCandidates = harvests.map((h) => h.signature);
    // The window must reach the harvest before the latest one (or the start of the launch's harvests).
    const distinctSlots = [...new Set(harvests.filter((h) => h.slot < slot).map((h) => h.slot))].sort((a, b) => b - a);
    let truncated = harvestRows.length === HARVEST_ROWS && distinctSlots.length < 2;
    const lo = distinctSlots[1] ?? distinctSlots[0] ?? slot;
    const windowRows: any[] = await db.RevenueEvent.find({ sourcePool: launch.sourcePool, kind: "funding_inflow", route: FORGE_CREATOR_DISTRIBUTION, "evidence.anchored": true, slot: { $gte: lo, $lte: slot }, signature: { $ne: sig } }, { signature: 1, slot: 1, evidence: 1 }).limit(WINDOW_DISTRIBUTION_ROWS).lean();
    if (windowRows.length === WINDOW_DISTRIBUTION_ROWS) truncated = true;
    windowTruncated = truncated;
    const distributions: ForgeDistributionTx[] = [...new Map(windowRows.map((w) => [w.signature, { signature: w.signature, slot: w.slot, anchored: true, problems: [], legs: [] }])).values()];
    const problems = [...new Set(legsAll.flatMap((e) => (e.evidence?.problems ? String(e.evidence.problems).split(" | ") : [])))];
    const d: ForgeDistributionTx = { signature: sig, slot, anchored: !!legsAll[0].evidence?.anchored, problems, legs: remainingLegs.map(transferFact) };
    const harvestKeys = harvests.flatMap((h) => h.legs.map((l) => l.key));
    const exclude = legsAll.map((e) => e.key);
    const totals = await linkedTotals(db, harvestKeys, exclude);
    const linkedElsewhere = new Map([...totals].map(([k, v]) => [k, v.creditable]));
    const result: ForgeAttribution = attributeForgeDistribution(d, { harvests, distributions, coveredThroughSlot: covered, windowTruncated: truncated, tokenAsset: assetOf(forge.tokenMint), linkedElsewhere });
    const evidence = { method: "forge_distribution_sequence", distributionSignature: sig, distributionSlot: slot, anchorMint: forge.tokenMint, forgeWallet: forge.forgeWallet, creator: forge.creator, coveredThroughSlot: covered, ...(result.outcome === "linked" ? { harvestSignature: result.harvest, harvestSlot: result.harvestSlot, previousHarvestSignature: result.previousHarvest } : {}) };
    if (result.outcome === "pending") {
      for (const t of remainingLegs) decisions.set(t.key, { status: "pending", reasons: result.reasons, candidates: [], attribution: result });
    } else if (result.outcome === "unresolved") {
      for (const t of remainingLegs) decisions.set(t.key, { status: "unresolved", reasons: result.reasons, candidates: result.candidates, evidence, attribution: result });
    } else {
      const H = harvestRows.filter((c) => c.signature === result.harvest);
      for (const leg of result.legs) {
        const t = remainingLegs.find((x) => x.key === leg.transferKey)!;
        const col = leg.collectionKey ? H.find((c) => c.key === leg.collectionKey) : null;
        if (!col) {
          decisions.set(t.key, { status: "unresolved", reasons: leg.reasons, candidates: [result.harvest], evidence, attribution: result });
          continue;
        }
        const plan: CreditPlan = { t, col, fact: collectionFact(col, absorbed, 0n), method: "forge_distribution_sequence", alreadyCreditable: linkedElsewhere.get(col.key) ?? 0n, o: { supported: leg.creditable, excess: leg.excess, extraReasons: leg.reasons, attribution: evidence }, excludeKeys: exclude };
        const w = await run(plan);
        decisions.set(t.key, { status: "linked", reasons: w.reasons, candidates: [result.harvest], collection: col, method: "forge_distribution_sequence", payable: w.payable, evidence, plan, attribution: result });
      }
    }
  }
  return { legsAll, decisions, slot, harvestCandidates, windowTruncated };
}

/** Group LP-collection rows into harvest transactions (per-mint legs), for the pure attribution. */
function groupHarvests(rows: any[], absorbed: Map<string, bigint>): ForgeHarvestTx[] {
  const by = new Map<string, ForgeHarvestTx>();
  for (const c of rows) {
    const h = by.get(c.signature) ?? by.set(c.signature, { signature: c.signature, slot: c.slot, legs: [] }).get(c.signature)!;
    h.legs.push(collectionFact(c, absorbed, 0n));
  }
  return [...by.values()];
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
        discrepancies: [...rec.discrepancies, ...(pre > 0n ? [`pre_activation_accrual_excluded: ${pre} (already distributed under the legacy policy)`] : []), ...(creditable > rec.expectedLast60 ? [`over_credited: ${creditable} credited > ${rec.expectedLast60} expected (concurrent reconciliation); the round consumption guard never consumes more than expected`] : [])],
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
  return { payoutEligible: true, roundNumber: null, fundingMint: assetOf(payoutMint), "policy.version": CURRENT_PHASE_AWARE_VERSION, correlationMethod: { $in: [...PAYABLE_CORRELATION_METHODS] }, slot: { $gt: policy.activationSlot, $lte: snapshotSlot }, collectionSlot: { $gt: policy.activationSlot } };
}
