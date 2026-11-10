/**
 * Raydium LaunchLab PlatformConfig semantics for accounting (pure; no RPC, no signing).
 *
 * Four fee streams that LAST60 keeps strictly apart (raydium-docs-v1 products/launchlab/creator-fees,
 * platform-config, reference/changelog/2026-08-17-launchlab-cpmm-only-platform-config; Raydium SDK
 * 0.2.82-alpha `Curve.calculateFee` / `Curve.splitFee`; bit-exact on mainnet TradeEvents):
 *
 *   1. Bonding-curve PLATFORM fee   rate `fee_rate`          → platform fee vault [platform_config, quote]
 *   2. Bonding-curve CREATOR fee    rate `creator_fee_rate`  → creator fee vault  [creator, quote]
 *        Σ = protocol (GlobalConfig.trade_fee_rate) + fee_rate + creator_fee_rate + share (referral arg)
 *        total = ⌈amount × Σ / 1e6⌉, creator = ⌊total × creator_fee_rate / Σ⌋, platform = ⌊total × fee_rate / Σ⌋
 *        Both are RATES ON TRADE VALUE in millionths. creator_fee_rate is NOT a share of the platform fee.
 *   3. Post-graduation CPMM CREATOR fee — a different program (Raydium CPMM) and a different rate:
 *        AmmConfig(cpswap_config).creator_fee_rate per swap, accrued to CPMM pool_creator (the launch
 *        creator unless platform_cp_creator is set), minus creator_fee_share_rate retained at collection.
 *   4. Locked-LP fees (LP-Lock "Fee Key") — LP trading fees of the LP minted at migration:
 *        after the 2026-08-17 upgrade: ONE platform Fee Key for ⌊LP × (platform_scale + creator_scale) / 1e6⌋,
 *        minted to platform_nft_wallet; the rest is burned. Before it: separate platform and creator
 *        Fee Keys. `creator_scale` is therefore never, by itself, a creator entitlement.
 *
 * LAST60_REWARD_PERCENTAGE / REWARD_PERCENTAGE is unrelated to all of these: it is LAST60's share of
 * the ELIGIBLE creator fees allocated to buyer rewards.
 */
import type { LaunchLabPlatformConfig } from "../providers/raydium/RaydiumLaunchLabProvider";
import type { AllocationVerification } from "./attribution";

/** Forgepad's LaunchLab PlatformConfig (supplied by the Forgepad owner; decoded on mainnet slot 466 137 980). */
export const FORGEPAD_LAUNCHLAB_PLATFORM_CONFIG = "5zZFa8KitVsp3qGDvCQeDZgn5YEKxAASA5EQTjVzobcX";

/**
 * Forgepad's intended Meteora DBC allocation (owner's statement): 25% platform / 75% creator both
 * before bonding completes and after migration. DBC only — it says nothing about LaunchLab.
 */
export const FORGEPAD_DBC_INTENDED = { preBond: { platformPct: 25, creatorPct: 75 }, postMigration: { platformPct: 25, creatorPct: 75 } } as const;

export const RATE_DENOMINATOR = 1_000_000n;

/**
 * Observed boundary of the 2026-08-17 LaunchLab locked-LP change on mainnet (platform 4Bu96XjU…,
 * creator_scale 100 000; test/fixtures/mainnet/forgepad-platform-config.json): the last migration
 * that minted the creator_scale Fee Key to the token CREATOR is slot 439 305 681 (2026-08-14); every
 * migration from slot 440 109 663 (2026-08-18) on minted it to the platform NFT wallet.
 * A migration after FIRST_POST is never accepted as proof of a creator Fee Key; one between the two
 * slots is judged on its lock records alone.
 */
export const LAUNCHLAB_LOCKED_LP_UPGRADE = { lastObservedPreUpgradeSlot: 439_305_681, firstObservedPostUpgradeSlot: 440_109_663 } as const;

const pct = (rate: bigint, denom = RATE_DENOMINATOR) => `${(Number(rate) / Number(denom)) * 100}%`;
const bps = (rate: bigint) => `${Number(rate) / 100} bps`;

// ── LP locks of a LaunchLab → CPMM migration ─────────────────────────────────────────────────

export interface MigrationLockFact {
  lockPda: string;
  nftMint: string;
  nftOwnerAtMigration: string;
  lpAmount: bigint | string;
}

export interface LockClassification {
  /** Locks whose Fee Key was minted to platform_nft_wallet (platform-owned locked LP). */
  platformLocks: { lockPda: string; nftMint: string }[];
  /** Locks proven to be the beneficiary's own creator Fee Key. */
  creatorLocks: { lockPda: string; nftMint: string }[];
  /** Locks minted to anyone else. */
  otherLocks: { lockPda: string; nftMint: string }[];
  /** Whether a creator-owned locked-LP entitlement is PROVEN by the migration's lock records. */
  creatorEntitlement: "proven" | "none" | "unprovable";
  problems: string[];
}

/**
 * Pure: classify the LP locks created by ONE migration transaction. A creator LP entitlement is
 * "proven" only when the lock records match the PRE-upgrade layout exactly:
 *   - the beneficiary is not the platform NFT wallet (else a platform Fee Key is indistinguishable);
 *   - exactly one lock was minted to the beneficiary, creator_scale > 0;
 *   - exactly one platform lock when platform_scale > 0 (none otherwise), nothing else;
 *   - when both exist, their LP amounts are in the platform_scale : creator_scale ratio (floor rounding).
 * After the 2026-08-17 upgrade the program mints ONE platform Fee Key, so a correct post-upgrade
 * migration always yields "none" for the creator.
 */
export function classifyLaunchLabLocks(o: { locks: MigrationLockFact[]; beneficiary: string; platformNftWallet: string | null | undefined; platformScale: bigint | null | undefined; creatorScale: bigint | null | undefined; migrationSlot?: number | null }): LockClassification {
  const out: LockClassification = { platformLocks: [], creatorLocks: [], otherLocks: [], creatorEntitlement: "none", problems: [] };
  const ref = (l: MigrationLockFact) => ({ lockPda: l.lockPda, nftMint: l.nftMint });
  const wallet = o.platformNftWallet ?? null;
  const candidates: MigrationLockFact[] = [];
  const platform: MigrationLockFact[] = [];
  for (const l of o.locks) {
    if (wallet && l.nftOwnerAtMigration === wallet) {
      platform.push(l);
      out.platformLocks.push(ref(l));
    } else if (l.nftOwnerAtMigration === o.beneficiary) candidates.push(l);
    else out.otherLocks.push(ref(l));
  }
  if (!wallet) {
    // Without the platform NFT wallet a platform lock cannot be told apart from a creator lock.
    if (o.locks.some((l) => l.nftOwnerAtMigration === o.beneficiary)) {
      out.creatorEntitlement = "unprovable";
      out.problems.push("platform_nft_wallet unknown: a lock minted to the beneficiary cannot be proven to be a creator Fee Key rather than the platform's");
      out.creatorLocks.push(...o.locks.filter((l) => l.nftOwnerAtMigration === o.beneficiary).map(ref));
    }
    return out;
  }
  if (wallet === o.beneficiary) {
    if (platform.length) out.problems.push(`the beneficiary ${o.beneficiary} is the platform NFT wallet: the ${platform.length} Fee Key(s) minted to it are platform-owned locked LP, never a creator entitlement`);
    return out;
  }
  const cs = o.creatorScale ?? null;
  const ps = o.platformScale ?? null;
  if (!candidates.length) {
    if (cs !== null && cs > 0n) out.problems.push(`creator_scale is ${cs} but the migration minted no Fee Key to the creator — consistent with the 2026-08-17 LaunchLab upgrade, which adds creator_scale to the platform's Fee Key; the creator has no migrated-LP entitlement`);
    return out;
  }
  out.creatorLocks.push(...candidates.map(ref));
  const fail = (m: string) => {
    out.creatorEntitlement = "unprovable";
    out.problems.push(m);
    return out;
  };
  if (o.migrationSlot !== undefined && o.migrationSlot !== null && o.migrationSlot >= LAUNCHLAB_LOCKED_LP_UPGRADE.firstObservedPostUpgradeSlot) return fail(`migration slot ${o.migrationSlot} is after the 2026-08-17 locked-LP upgrade (observed from slot ${LAUNCHLAB_LOCKED_LP_UPGRADE.firstObservedPostUpgradeSlot}): the program no longer mints creator Fee Keys, so a lock minted to the creator cannot be a creator_scale entitlement`);
  if (cs === null || ps === null) return fail("platform_scale / creator_scale unknown: the creator lock cannot be checked against the platform's split");
  if (cs === 0n) return fail(`creator_scale is 0 but ${candidates.length} lock(s) were minted to the creator at migration`);
  if (candidates.length !== 1) return fail(`${candidates.length} locks were minted to the creator; the pre-upgrade layout mints exactly one creator Fee Key`);
  if (out.otherLocks.length) return fail(`${out.otherLocks.length} lock(s) minted to neither the platform NFT wallet nor the creator`);
  const expectedPlatform = ps > 0n ? 1 : 0;
  if (platform.length !== expectedPlatform) return fail(`platform_scale ${ps} implies ${expectedPlatform} platform lock(s), the migration created ${platform.length}`);
  if (platform.length === 1) {
    const c = BigInt(candidates[0]!.lpAmount);
    const p = BigInt(platform[0]!.lpAmount);
    const skew = c * ps - p * cs;
    const bound = ps > cs ? ps : cs;
    if ((skew < 0n ? -skew : skew) > bound) return fail(`lock amounts creator ${c} : platform ${p} are not in the creator_scale ${cs} : platform_scale ${ps} ratio`);
  }
  out.creatorEntitlement = "proven";
  return out;
}

/** Verification of the migrated-LP basis from the lock classification and the creator_scale declaration. */
export function launchLabLpVerification(cls: LockClassification, scaleCheck: { verification: AllocationVerification; problems: string[] }): { verification: AllocationVerification; problems: string[] } {
  if (cls.creatorEntitlement === "proven") return { verification: scaleCheck.verification, problems: [...scaleCheck.problems, ...cls.problems] };
  // No proven creator Fee Key: never distributable, whatever was declared about creator_scale.
  return { verification: "unverifiable", problems: [...scaleCheck.problems, ...cls.problems, ...(cls.problems.length ? [] : ["the migration minted no Fee Key to the creator: no creator-owned locked-LP entitlement"])] };
}

// ── Operator interpretation of a decoded PlatformConfig ──────────────────────────────────────

export interface FieldExplanation {
  field: string;
  value: string;
  units: string;
  meaning: string;
}

export interface FeeStreamInterpretation {
  stream: "bonding_platform_fee" | "bonding_creator_fee" | "cpmm_creator_fee" | "platform_locked_lp" | "creator_locked_lp";
  beneficiary: string;
  /** confirmed: fully determined by this PlatformConfig (+ CPMM AmmConfig); launch: needs a specific pool / migration tx. */
  status: "confirmed" | "requires_launch_evidence" | "none";
  formula: string;
  explanation: string;
  payableByLast60: string;
}

export interface CpmmConfigFacts {
  address: string;
  tradeFeeRate: bigint;
  protocolFeeRate: bigint;
  fundFeeRate: bigint;
  creatorFeeRate: bigint;
  creatorFeeShareRate: bigint;
}

export function explainPlatformConfig(c: LaunchLabPlatformConfig): FieldExplanation[] {
  const s = (x: unknown) => (x === null || x === undefined ? "(default / none)" : String(x));
  return [
    { field: "epoch", value: s(c.epoch), units: "Solana epoch", meaning: "epoch of the last PlatformConfig update" },
    { field: "platform_fee_wallet", value: s(c.platformFeeWallet), units: "pubkey", meaning: "signs claim_platform_fee(_from_vault); receives the bonding-curve PLATFORM fee" },
    { field: "platform_nft_wallet", value: s(c.platformLockNftWallet), units: "pubkey", meaning: "receives the platform locked-LP Fee Key NFT at CPMM migration" },
    { field: "platform_scale", value: s(c.platformScale), units: "millionths of migrated LP", meaning: `platform locked-LP share (${pct(c.platformScale ?? 0n)})` },
    { field: "creator_scale", value: s(c.creatorScale), units: "millionths of migrated LP", meaning: `${pct(c.creatorScale ?? 0n)} of migrated LP — since 2026-08-17 ADDED TO THE PLATFORM's Fee Key, not a creator entitlement` },
    { field: "burn_scale", value: s(c.burnScale), units: "millionths of migrated LP", meaning: `${pct(c.burnScale ?? 0n)} of migrated LP burned` },
    { field: "fee_rate", value: s(c.feeRate), units: "millionths of trade value", meaning: `bonding-curve PLATFORM fee rate: ${bps(c.feeRate)} = ${pct(c.feeRate)} of each trade` },
    { field: "creator_fee_rate", value: s(c.creatorFeeRate), units: "millionths of trade value", meaning: `bonding-curve CREATOR fee rate: ${bps(c.creatorFeeRate)} = ${pct(c.creatorFeeRate)} of each trade (NOT a share of the platform fee; cap 5000)` },
    { field: "name / web / img", value: `${s(c.name)} / ${s(c.web)} / ${s(c.img)}`, units: "utf-8", meaning: "branding" },
    { field: "cpswap_config", value: s(c.cpConfig), units: "pubkey (CPMM AmmConfig)", meaning: "AmmConfig of the CPMM pool created at graduation — sets the post-graduation trade and creator fee rates" },
    { field: "transfer_fee_extension_auth", value: s(c.transferFeeExtensionAuth), units: "pubkey", meaning: "Token-2022 transfer-fee authorities for Token-2022 launches (no effect on SPL launches)" },
    { field: "platform_vesting_wallet", value: s(c.platformVestingWallet), units: "pubkey", meaning: "receives the platform's vested base tokens" },
    { field: "platform_vesting_scale", value: s(c.platformVestingScale), units: "millionths of total_locked_amount", meaning: `platform share of the launch's vested tokens (${pct(c.platformVestingScale ?? 0n)}); tokens, not fees` },
    { field: "platform_cp_creator", value: s(c.platformCpCreator), units: "pubkey", meaning: c.platformCpCreator ? "recorded as CPMM pool_creator at graduation — it, not the launch creator, receives CPMM creator fees" : "default: the LAUNCH CREATOR becomes the CPMM pool_creator and receives CPMM creator fees" },
    { field: "restrict_global_config", value: s(c.restrictGlobalConfig), units: "flag", meaning: "1 = launches need a PlatformAllowConfig for their GlobalConfig (no fee effect)" },
    { field: "restrict_curve_param", value: s(c.restrictCurveParam), units: "flag", meaning: "1 = launches must satisfy the PlatformCurveRule (no fee effect)" },
    { field: "curve_rule_manager", value: s(c.curveRuleManager), units: "pubkey", meaning: "may manage PlatformCurveRule accounts (no fee effect)" },
  ];
}

export function interpretPlatformConfig(c: LaunchLabPlatformConfig, cpmm: CpmmConfigFacts | null): FeeStreamInterpretation[] {
  const lockedShare = (c.platformScale ?? 0n) + (c.creatorScale ?? 0n);
  const out: FeeStreamInterpretation[] = [
    {
      stream: "bonding_platform_fee",
      beneficiary: c.platformFeeWallet,
      status: "confirmed",
      formula: `platform_fee = ⌊⌈amount × Σ / 1e6⌉ × ${c.feeRate} / Σ⌋, Σ = protocol + ${c.feeRate} + ${c.creatorFeeRate} + share`,
      explanation: `${pct(c.feeRate)} of each bonding-curve trade's quote amount (protocol rate and referral share come from the pool's GlobalConfig and the trade)`,
      payableByLast60: "never (platform revenue)",
    },
    {
      stream: "bonding_creator_fee",
      beneficiary: "the pool's creator (PoolState.creator)",
      status: "requires_launch_evidence",
      formula: `creator_fee = ⌊⌈amount × Σ / 1e6⌉ × ${c.creatorFeeRate} / Σ⌋ — accounted from each TradeEvent.creator_fee, cross-checked with the creator-vault transfer`,
      explanation: `rate CONFIRMED: ${pct(c.creatorFeeRate)} of each trade's quote amount, independent of and additional to the platform fee (${c.feeRate > 0n ? `creator : platform = ${c.creatorFeeRate} : ${c.feeRate}` : "no platform fee"}). Which wallet is the creator needs the specific pool`,
      payableByLast60: "eligible when the pool is bound to this PlatformConfig and both are declared and verified",
    },
    {
      stream: "cpmm_creator_fee",
      beneficiary: c.platformCpCreator ?? "the launch creator (platform_cp_creator is default)",
      status: "requires_launch_evidence",
      formula: cpmm
        ? `accrued per CPMM swap at AmmConfig ${cpmm.address} creator_fee_rate ${cpmm.creatorFeeRate} (${pct(cpmm.creatorFeeRate)} of swap value); at collection the protocol keeps ⌊accrued × ${cpmm.creatorFeeShareRate} / 1e6⌋ (${pct(cpmm.creatorFeeShareRate)}); Asteroid Protocol counts only what the collection instruction transferred`
        : `AmmConfig ${c.cpConfig ?? "?"} not read`,
      explanation: "separate program and rate from the bonding-curve creator fee; requires the migration tx (CPMM pool_creator, enable_creator_fee, creator_fee_on) to verify",
      payableByLast60: "eligible only after a verified migration with pool_creator = creator, creator fee enabled, and a verified bonding basis",
    },
    {
      stream: "platform_locked_lp",
      beneficiary: c.platformLockNftWallet ?? "?",
      status: lockedShare > 0n ? "confirmed" : "none",
      formula: `platform locked LP = ⌊LP × (${c.platformScale} + ${c.creatorScale}) / 1e6⌋ (post-2026-08-17 migration); burned = rest`,
      explanation: lockedShare > 0n ? `${pct(lockedShare)} of migrated LP is locked under ONE platform Fee Key minted to platform_nft_wallet; its LP fees are platform-owned` : "no locked LP",
      payableByLast60: "never (platform-owned)",
    },
    {
      stream: "creator_locked_lp",
      beneficiary: "only a Fee Key the migration tx actually minted to the creator",
      status: "requires_launch_evidence",
      formula: "none under the current program: creator_scale is added to the platform Fee Key",
      explanation: `creator_scale ${c.creatorScale} is NOT a creator entitlement. Only a pre-upgrade migration whose lock records show a separate creator Fee Key (and match the scales) proves one`,
      payableByLast60: "only with a proven creator Fee Key from the migration tx (never from creator_scale)",
    },
  ];
  return out;
}

export function renderPlatformConfigReport(r: { address: string; owner: string; slot: number; size: number; fields: FieldExplanation[]; streams: FeeStreamInterpretation[]; cpmm: CpmmConfigFacts | null; problems: string[]; notes: string[] }): string {
  const L: string[] = [];
  L.push(`LaunchLab PlatformConfig ${r.address}`);
  L.push(`  owner ${r.owner}  size ${r.size} bytes  read at slot ${r.slot}`);
  L.push("");
  L.push("  fields (decoded on-chain):");
  for (const f of r.fields) L.push(`    ${f.field.padEnd(28)} ${f.value}\n${" ".repeat(33)}[${f.units}] ${f.meaning}`);
  if (r.cpmm) {
    L.push("");
    L.push(`  CPMM AmmConfig ${r.cpmm.address} (cpswap_config, decoded on-chain):`);
    L.push(`    trade_fee_rate ${r.cpmm.tradeFeeRate}  protocol_fee_rate ${r.cpmm.protocolFeeRate}  fund_fee_rate ${r.cpmm.fundFeeRate}  [millionths; protocol/fund are millionths OF the trade fee]`);
    L.push(`    creator_fee_rate ${r.cpmm.creatorFeeRate} [millionths of swap value]  creator_fee_share_rate ${r.cpmm.creatorFeeShareRate} [millionths of accrued creator fee kept by the protocol at collection]`);
  }
  L.push("");
  L.push("  accounting interpretation:");
  for (const s of r.streams) {
    L.push(`    [${s.status === "confirmed" ? "CONFIRMED" : s.status === "none" ? "NONE" : "NEEDS LAUNCH EVIDENCE"}] ${s.stream} → ${s.beneficiary}`);
    L.push(`        ${s.formula}`);
    L.push(`        ${s.explanation}`);
    L.push(`        Asteroid Protocol: ${s.payableByLast60}`);
  }
  for (const n of r.notes) L.push(`  note: ${n}`);
  L.push("");
  L.push(r.problems.length ? `  RESULT: NOT VERIFIED\n${r.problems.map((p) => `  problem: ${p}`).join("\n")}` : "  RESULT: DECODED AND VALIDATED (configuration confirmed; launch-specific items above still need a pool / migration)");
  return L.join("\n");
}
