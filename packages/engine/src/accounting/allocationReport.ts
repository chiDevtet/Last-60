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

/**
 * Forgepad's INTENDED creator allocation per launch type (as communicated for this deployment).
 * These are targets to check against, never values used for accounting, and never proof that a
 * given pool uses them.
 */
export const FORGEPAD_INTENDED: Record<"meteora_dbc" | "raydium_launchlab", { key: keyof ExpectedAllocation; env: string; value: number; meaning: string }[]> = {
  meteora_dbc: [
    { key: "dbcCreatorTradingFeePercentage", env: "EXPECTED_DBC_CREATOR_TRADING_FEE_PERCENTAGE", value: 75, meaning: "creator share of the bonding-curve trading fee, % (creator_trading_fee_percentage)" },
    { key: "dbcCreatorLpPercentage", env: "EXPECTED_DBC_CREATOR_LP_PERCENTAGE", value: 75, meaning: "creator share of the migrated DAMM v2 LP, % (creator liquid + permanently locked + vesting LP percentage)" },
  ],
  raydium_launchlab: [
    { key: "launchlabCreatorFeeRate", env: "EXPECTED_LAUNCHLAB_CREATOR_FEE_RATE", value: 5_000, meaning: "creator fee RATE on trade value, millionths (5000 = 0.5% of each trade; the program maximum)" },
    { key: "launchlabCreatorLpScale", env: "EXPECTED_LAUNCHLAB_CREATOR_LP_SCALE", value: 500_000, meaning: "creator_scale of migrated LP, millionths (500000 = 50%)" },
  ],
};

export interface AllocationCheckRow {
  phase: string;
  parameter: string;
  env: string;
  meaning: string;
  declared: number | null;
  onChain: string | null;
  forgepadIntended: number | null;
  /** Whether the on-chain value equals Forgepad's intended target (informational; not a verification). */
  matchesIntended: boolean | null;
  verification: AllocationVerification;
  distributable: boolean;
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
}

function rowOutcome(declared: number | null, onChain: string | null): AllocationVerification {
  if (declared === null) return "not_declared";
  if (onChain === null) return "unverifiable";
  return String(declared) === onChain ? "verified" : "mismatch";
}

export function buildAllocationReport(info: PoolInfo, expected: ExpectedAllocation, lpCheck?: { verification: AllocationVerification; problems: string[] }): AllocationReport {
  const rows: AllocationCheckRow[] = [];
  const fp = (key: keyof ExpectedAllocation) => (info.provider === "meteora_dbc" || info.provider === "raydium_launchlab" ? (FORGEPAD_INTENDED[info.provider].find((x) => x.key === key) ?? null) : null);
  const add = (phase: string, parameter: string, key: keyof ExpectedAllocation, onChain: string | number | boolean | null | undefined, notes: string[] = [], verificationOverride?: AllocationVerification) => {
    const intended = fp(key);
    const chain = onChain === undefined || onChain === null || onChain === "unknown" ? null : String(onChain);
    const declared = expected[key];
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
      distributable: verification === "verified",
      notes,
    });
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
      add("bonding_curve", "creator_fee_rate (PlatformConfig)", "launchlabCreatorFeeRate", info.feeParams.creatorFeeRate as string | undefined, [
        "a FEE RATE on trade value, denominator 1 000 000 — not a share of the other fees",
        "total_fee = ceil(amount × (protocol + platform + creator + share rates) / 1e6); creator_fee = floor(total_fee × creator_rate / Σrates); protocol takes the rounding remainder",
      ], info.allocation?.verification);
      const scaleNotes = ["Raydium LaunchLab upgrade of 2026-08-17: new / updated PlatformConfigs must have creator_scale = 0, and migrations executed after the upgrade fold creator_scale into ONE platform-owned Fee Key — a creator Fee Key is no longer created (raydium-docs-v1 products/launchlab/creator-fees). The migrated-LP entitlement is therefore decided by the lock records of the actual migration transaction, never by creator_scale alone."];
      add("migrated_lp", "creator_scale (PlatformConfig)", "launchlabCreatorLpScale", info.feeParams.creatorScale as string | undefined, scaleNotes, lpCheck?.verification);
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
  const outcome = rows.length ? order.find((o) => rows.some((r) => r.verification === o))! : "not_declared";
  const missing: string[] = [];
  for (const r of rows) {
    if (r.verification === "not_declared") missing.push(`declare ${r.env} (the intended value) to verify ${r.parameter}`);
    if (r.verification === "unverifiable") missing.push(`${r.parameter}: on-chain value could not be read or proven — ${r.notes[0] ?? ""}`.trim());
    if (r.verification === "mismatch") missing.push(`${r.parameter}: chain says ${r.onChain}, ${r.env}=${r.declared}; resolve with Forgepad (the chain value is what is accounted)`);
  }
  return { provider: info.provider, pool: info.poolAddress, tokenMint: info.tokenMint, quoteMint: info.quoteMint, role: info.feeBeneficiaryRole, beneficiary: info.beneficiary, creator: info.creator, status: info.status, feeMints, rows, bases, outcome, missing };
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
    L.push(`      → ${x.verification.toUpperCase()}${x.distributable ? " (distributable)" : " (recorded, NOT distributable)"}`);
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
  return L.join("\n");
}
