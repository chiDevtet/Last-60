/**
 * Operator-readable allocation verification report: for the configured launch, what the operator
 * declared (EXPECTED_* env), what the chain says, who the beneficiary is, which mint the fees are in,
 * and the verification outcome of every allocation that can carry creator fees.
 *
 * The on-chain value is ALWAYS the accounting source of truth; a declaration only decides whether
 * the allocation is distributable:
 *   verified     declared and equal to the chain           → distributable
 *   mismatch     declared and different                    → recorded, never paid
 *   not_declared nothing declared                          → recorded, reported, never paid
 *   unverifiable the on-chain value could not be read      → recorded, never paid
 *
 * Read-only: builds the report from an already loaded provider (PoolInfo). Nothing is signed or sent.
 */
import type { ExpectedAllocation } from "../config/env";
import type { PoolInfo } from "../providers/LaunchProvider";
import { basisDistributable, type AllocationBasis, type AllocationVerification } from "./attribution";
import { FORGEPAD_DBC_INTENDED, FORGEPAD_LAUNCHLAB_PLATFORM_CONFIG } from "./launchlabPlatform";

/**
 * Forgepad's INTENDED / DECLARED values per launch type. These are targets to check against, never
 * values used for accounting, and never proof that a given pool uses them.
 *   DBC: the owner's stated allocation — 25% platform / 75% creator pre-bond AND post-migration.
 *   LaunchLab: NOT derived from the DBC percentages. They are the values of Forgepad's actual
 *   PlatformConfig 5zZFa8Ki… as decoded on mainnet (slot 466 137 980; `bun run verify:platform-config`).
 */
export const FORGEPAD_INTENDED: Record<"meteora_dbc" | "raydium_launchlab", { key: keyof ExpectedAllocation; env: string; value: number | string; meaning: string }[]> = {
  meteora_dbc: [
    { key: "dbcCreatorTradingFeePercentage", env: "EXPECTED_DBC_CREATOR_TRADING_FEE_PERCENTAGE", value: FORGEPAD_DBC_INTENDED.preBond.creatorPct, meaning: "creator share of the bonding-curve trading fee, % (creator_trading_fee_percentage; Forgepad: 25 platform / 75 creator)" },
    { key: "dbcCreatorLpPercentage", env: "EXPECTED_DBC_CREATOR_LP_PERCENTAGE", value: FORGEPAD_DBC_INTENDED.postMigration.creatorPct, meaning: "creator share of the migrated DAMM v2 LP, % (creator liquid + permanently locked + vesting LP percentage; Forgepad: 25 / 75)" },
  ],
  raydium_launchlab: [
    { key: "launchlabPlatformConfig", env: "EXPECTED_LAUNCHLAB_PLATFORM_CONFIG", value: FORGEPAD_LAUNCHLAB_PLATFORM_CONFIG, meaning: "PlatformConfig the pool must be bound to (Forgepad's own)" },
    { key: "launchlabCreatorFeeRate", env: "EXPECTED_LAUNCHLAB_CREATOR_FEE_RATE", value: 5_000, meaning: "creator fee RATE on trade value, millionths (5000 = 0.5% of each trade, the program maximum) — not a share of the platform fee" },
    { key: "launchlabCreatorLpScale", env: "EXPECTED_LAUNCHLAB_CREATOR_LP_SCALE", value: 500_000, meaning: "PlatformConfig creator_scale VALUE, millionths of migrated LP — a config fact, NOT a creator entitlement (added to the platform Fee Key since 2026-08-17)" },
  ],
};

export interface AllocationCheckRow {
  phase: string;
  parameter: string;
  env: string;
  meaning: string;
  declared: number | string | null;
  onChain: string | null;
  forgepadIntended: number | string | null;
  /** Whether the on-chain value equals Forgepad's intended target (informational; not a verification). */
  matchesIntended: boolean | null;
  verification: AllocationVerification;
  distributable: boolean;
  /** Set when the row cannot be decided before a specific launch / migration exists (excluded from the outcome). */
  pendingLaunchEvidence?: string;
  /** Set when the chain proves there is NO such entitlement (nothing to pay; excluded from the outcome). */
  noEntitlement?: string;
  notes: string[];
}

export interface AllocationReport {
  provider: string;
  pool: string;
  tokenMint: string;
  quoteMint: string;
  role: string;
  beneficiary: string;
  creator: string;
  status: string;
  /** Mint(s) the beneficiary's fees are paid in per phase (fees in a non-payout mint are never converted). */
  feeMints: { phase: string; mint: string; note: string }[];
  rows: AllocationCheckRow[];
  bases: { id: string; phase: string; pool: string; verification: AllocationVerification; distributable: boolean; problems: string[] }[];
  /** Overall outcome: "verified" only if EVERY row is verified. */
  outcome: AllocationVerification;
  /** What is still needed to finish verification. */
  missing: string[];
  /** Entitlements that need a specific launch pool / migration transaction to verify. */
  pending: string[];
}

function rowOutcome(declared: number | string | null | undefined, onChain: string | null): AllocationVerification {
  if (declared === undefined) declared = null;
  if (declared === null) return "not_declared";
  if (onChain === null) return "unverifiable";
  return String(declared) === onChain ? "verified" : "mismatch";
}

export function buildAllocationReport(info: PoolInfo, expected: ExpectedAllocation, lpCheck?: { verification: AllocationVerification; problems: string[] }): AllocationReport {
  const rows: AllocationCheckRow[] = [];
  const fp = (key: keyof ExpectedAllocation) => (info.provider === "meteora_dbc" || info.provider === "raydium_launchlab" ? (FORGEPAD_INTENDED[info.provider].find((x) => x.key === key) ?? null) : null);
  const add = (phase: string, parameter: string, key: keyof ExpectedAllocation, onChain: string | number | boolean | null | undefined, notes: string[] = [], verificationOverride?: AllocationVerification, opts: { neverDistributable?: boolean } = {}) => {
    const intended = fp(key);
    const chain = onChain === undefined || onChain === null || onChain === "unknown" ? null : String(onChain);
    const declared = expected[key] ?? null;
    const verification = verificationOverride ?? rowOutcome(declared, chain);
    rows.push({
      phase,
      parameter,
      env: intended?.env ?? key,
      meaning: intended?.meaning ?? "",
      declared,
      onChain: chain,
      forgepadIntended: intended?.value ?? null,
      matchesIntended: intended && chain !== null ? String(intended.value) === chain : null,
      verification,
      distributable: !opts.neverDistributable && verification === "verified",
      notes,
    });
  };
  const pendingRow = (phase: string, parameter: string, meaning: string, needs: string, basis: AllocationBasis | undefined, notes: string[]) => {
    if (basis) {
      const none = phase === "migrated_lp" && basis.params.beneficiaryLocks === "" ? "the migration minted no Fee Key to the creator" : undefined;
      rows.push({ phase, parameter, env: "(from the verified migration)", meaning, declared: null, onChain: JSON.stringify(basis.params), forgepadIntended: null, matchesIntended: null, verification: basis.verification, distributable: basisDistributable(basis), ...(none ? { noEntitlement: none } : {}), notes: [...notes, ...basis.problems] });
    } else {
      rows.push({ phase, parameter, env: "(launch evidence)", meaning, declared: null, onChain: null, forgepadIntended: null, matchesIntended: null, verification: "unverifiable", distributable: false, pendingLaunchEvidence: needs, notes });
    }
  };
  const creatorRole = info.feeBeneficiaryRole === "creator";
  const feeMints: AllocationReport["feeMints"] = [];
  if (info.provider === "meteora_dbc") {
    const mode = Number(info.feeParams.collectFeeMode ?? 0);
    feeMints.push({ phase: "bonding_curve", mint: info.quoteMint, note: mode === 0 ? "collect_fee_mode 0: fees in the quote mint" : "collect_fee_mode 1: sell-side fees are taken in the base token — those are recorded as non-payout-asset fees and never converted" });
    if (creatorRole) {
      add("bonding_curve", "creator_trading_fee_percentage", "dbcCreatorTradingFeePercentage", info.feeParams.creatorTradingFeePercentage as number | undefined, ["read from the DBC PoolConfig; share of the trading fee AFTER the protocol (and referral) cut"], info.allocation?.verification);
      add("migrated_lp", "creator LP percentage (liquid + permanently locked + vesting)", "dbcCreatorLpPercentage", info.feeParams.creatorLpPercentage as number | undefined, ["after graduation the creator earns LP fees only through the DAMM v2 position NFT(s) it actually holds"], lpCheck?.verification);
    }
  } else if (info.provider === "raydium_launchlab") {
    feeMints.push({ phase: "bonding_curve", mint: info.quoteMint, note: "LaunchLab fees are always in the quote mint" });
    if (creatorRole) {
      add("bonding_curve", "PlatformConfig the pool is bound to", "launchlabPlatformConfig", info.accounts.platformConfig, ["identifies the launch platform; a rate alone is not an identity (other platforms use the same creator_fee_rate)"]);
      add("bonding_curve", "creator_fee_rate (PlatformConfig)", "launchlabCreatorFeeRate", info.feeParams.creatorFeeRate as string | undefined, [
        "a FEE RATE on trade value, denominator 1 000 000 — not a share of the platform fee (fee_rate) or of any other fee",
        "total_fee = ceil(amount × (protocol + platform + creator + share rates) / 1e6); creator_fee = floor(total_fee × creator_rate / Σrates); protocol takes the rounding remainder",
        `bonding basis (platform config AND rate): ${info.allocation?.verification ?? "?"}`,
      ]);
      const scaleNotes = [
        "config fact only — NEVER distributable by itself: since the Raydium LaunchLab upgrade of 2026-08-17, migrations add creator_scale to the ONE platform-owned Fee Key minted to platform_nft_wallet; no creator Fee Key is created (raydium-docs-v1 products/launchlab/creator-fees).",
      ];
      add("migrated_lp", "creator_scale (PlatformConfig value)", "launchlabCreatorLpScale", info.feeParams.creatorScale as string | undefined, scaleNotes, undefined, { neverDistributable: true });
      pendingRow("migrated_lp", "creator-owned locked-LP Fee Key", "LP fees of a Fee Key the migration transaction actually minted to the creator", "the migration transaction's lock records (a creator Fee Key exists only for pre-upgrade migrations)", info.destination?.lpAllocation, ["platform-owned locked LP (platform_scale + creator_scale) is never attributed to the creator"]);
      pendingRow("post_migration_trading", "CPMM creator fee (post-graduation)", "CPMM creator fee collected to the CPMM pool_creator, net of the protocol share", "the migration transaction (CPMM pool_creator, enable_creator_fee, creator_fee_on), the CreatorFeeShare PDA and later collection instructions", info.destination?.allocation, ["independent of the bonding-curve creator fee and of locked-LP fees", "direct creator revenue: never Asteroid Protocol funding, never part of the Forge LP split", "params show creator_fee_on, the AmmConfig default share rate, the per-creator CreatorFeeShare override and the effective rate; an unverified mode or rate is never distributable"]);
    }
  } else if (info.provider === "pump_fun") {
    feeMints.push({ phase: "bonding_curve", mint: info.quoteMint, note: "pump.fun fees are native SOL (accounted as the SOL asset)" });
    if (creatorRole) {
      add("bonding_curve", "coin creator (BondingCurve.creator)", "pumpfunCreator", info.creator, [
        "pump.fun pays the creator fee to the coin's creator; its RATE comes from the pump-fees schedule (it changes with the market cap) and is read per trade from TradeEvent.creator_fee",
        "declared with EXPECTED_PUMPFUN_CREATOR, default the configured creator wallet (the wallet the coin is launched from)",
        "holder-reward and cashback coins pay the creator fee to holders / traders and are never distributable",
      ], info.allocation?.verification);
      pendingRow("post_migration_trading", "PumpSwap coin creator fee (post-graduation)", "coin creator fee of each PumpSwap trade, exact in the trade's own event", "the migration transaction and the PumpSwap pool (coin_creator must be the same creator wallet)", info.destination?.allocation, ["pump.fun gives the creator no LP at graduation: there is no migrated-LP stream"]);
    }
  }
  if (!creatorRole) {
    rows.push({ phase: "bonding_curve", parameter: `${info.feeBeneficiaryRole} share`, env: "(none)", meaning: `no declaration exists for the "${info.feeBeneficiaryRole}" role`, declared: null, onChain: JSON.stringify(info.allocation?.params ?? {}), forgepadIntended: null, matchesIntended: null, verification: "not_declared", distributable: false, notes: ["only the creator role has declarable expectations; other roles are recorded but not distributable"] });
  }
  const bases = [info.allocation, info.destination?.allocation, info.destination?.lpAllocation].filter(Boolean).map((b) => {
    const x = b as AllocationBasis;
    return { id: x.id, phase: x.phase, pool: x.pool, verification: x.verification, distributable: basisDistributable(x), problems: x.problems };
  });
  if (info.destination) feeMints.push({ phase: info.destination.kind === "dbc_damm_v2" ? "migrated_lp" : "post_migration_trading", mint: info.quoteMint, note: "destination fees can accrue in BOTH pool mints; only the payout-asset mint is distributable, the other is recorded and never converted" });
  const order: AllocationVerification[] = ["mismatch", "unverifiable", "not_declared", "verified"];
  const decided = rows.filter((r) => !r.pendingLaunchEvidence && !r.noEntitlement);
  const outcome = decided.length ? order.find((o) => decided.some((r) => r.verification === o))! : "not_declared";
  const missing: string[] = [];
  const pending = rows.filter((r) => r.pendingLaunchEvidence).map((r) => `${r.parameter}: requires ${r.pendingLaunchEvidence}`);
  for (const r of decided) {
    if (r.verification === "not_declared") missing.push(`declare ${r.env} (the intended value) to verify ${r.parameter}`);
    if (r.verification === "unverifiable") missing.push(`${r.parameter}: on-chain value could not be read or proven — ${r.notes[0] ?? ""}`.trim());
    if (r.verification === "mismatch") missing.push(`${r.parameter}: chain says ${r.onChain}, ${r.env}=${r.declared}; resolve with Forgepad (the chain value is what is accounted)`);
  }
  return { provider: info.provider, pool: info.poolAddress, tokenMint: info.tokenMint, quoteMint: info.quoteMint, role: info.feeBeneficiaryRole, beneficiary: info.beneficiary, creator: info.creator, status: info.status, feeMints, rows, bases, outcome, missing, pending };
}

/** Plain-text rendering for terminals and runbooks. */
export function renderAllocationReport(r: AllocationReport): string {
  const L: string[] = [];
  L.push(`Allocation verification — ${r.provider} pool ${r.pool}`);
  L.push(`  token ${r.tokenMint}  quote ${r.quoteMint}  status ${r.status}`);
  L.push(`  role ${r.role}  beneficiary ${r.beneficiary}  (pool creator ${r.creator})`);
  for (const m of r.feeMints) L.push(`  fee mint [${m.phase}] ${m.mint} — ${m.note}`);
  L.push("");
  for (const x of r.rows) {
    L.push(`  [${x.phase}] ${x.parameter}`);
    L.push(`      ${x.meaning}`);
    L.push(`      declared ${x.env}=${x.declared ?? "(not set)"}   on-chain ${x.onChain ?? "(unreadable)"}   Forgepad intended ${x.forgepadIntended ?? "—"}${x.matchesIntended === null ? "" : x.matchesIntended ? " (chain matches)" : " (chain DIFFERS)"}`);
    L.push(x.noEntitlement ? `      → NO ENTITLEMENT: ${x.noEntitlement} (nothing to distribute)` : x.pendingLaunchEvidence ? `      → PENDING LAUNCH EVIDENCE: ${x.pendingLaunchEvidence} (NOT distributable)` : `      → ${x.verification.toUpperCase()}${x.distributable ? " (distributable)" : " (recorded, NOT distributable)"}`);
    for (const n of x.notes) L.push(`      · ${n}`);
  }
  if (r.bases.length) {
    L.push("");
    L.push("  allocation bases:");
    for (const b of r.bases) L.push(`    ${b.id} [${b.phase}] pool ${b.pool}: ${b.verification}${b.distributable ? "" : " — not distributable"}${b.problems.length ? ` (${b.problems.join("; ")})` : ""}`);
  }
  L.push("");
  L.push(`  OUTCOME: ${r.outcome.toUpperCase()}`);
  for (const m of r.missing) L.push(`  needed: ${m}`);
  for (const m of r.pending) L.push(`  launch-specific: ${m}`);
  return L.join("\n");
}
