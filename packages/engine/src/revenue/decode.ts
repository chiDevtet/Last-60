/**
 * Pure decoding of phase-aware revenue facts from ONE normalized transaction (no I/O).
 *
 * Collections (instruction-scoped transfers, never whole-transaction balance deltas):
 *   bonding_curve_creator_fee        creator-fee claim of the bonding pool (LaunchLab claim_creator_fee
 *                                    out of the creator fee vault; DBC claim_creator_trading_fee out of
 *                                    the pool's quote/base vaults), as parsed by the provider;
 *   cpmm_creator_trading_fee         CPMM collect_creator_fee(_permissionless) transfers to pool_creator;
 *   forge_platform_lp_fee_collection LP-lock collect_cp_fees on a lock whose Fee Key was minted to the
 *                                    PlatformConfig platform_nft_wallet by the verified migration.
 * Funding inflows (last60_funding_inflow): System Program transfers (native SOL) and SPL Token /
 * Token-2022 Transfer / TransferChecked into a configured Last-60 funding destination, from a wallet
 * that can be a collection recipient of this launch (the creator, the Forge LP beneficiary, the
 * platform NFT wallet). Anything else reaching the destination is not revenue of this launch.
 */
import type { FlatInstruction, NormalizedTx } from "../chain/tx";
import { decodeTokenTransfer, subtreeTransfers, tokenAccountInfo } from "../chain/tx";
import { COLLECT_CP_FEES_DISC, RAYDIUM_CP_LOCK_PROGRAM_ID } from "../providers/migration";
import type { ParsedTransaction } from "../providers/LaunchProvider";
import { assetOf, NATIVE_SOL, parseFundingMemo, type CollectionStream, type LaunchPhase } from "../accounting/revenueStreams";

export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const MEMO_PROGRAM_IDS = new Set(["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "Memo1UhkJRfHyvLMcVucJwxXeuD728EQVDDwQDxFMNo"]);

/** Facts about the launch needed to classify revenue (built from the loaded provider and config). */
export interface RevenueLaunchFacts {
  provider: string;
  tokenMint: string;
  quoteMint: string;
  sourcePool: string;
  /** Bonding pool creator (on-chain `pool.creator`), or null when unknown. */
  creator: string | null;
  /** Configured beneficiary role: bonding-curve creator-fee claims are parsed only for role "creator". */
  role: string;
  /** Vaults that bonding-curve creator-fee claims are paid out of (LaunchLab creator fee vault / DBC pool vaults). */
  creatorClaimVaults: string[];
  /** Verified graduation destination (CPMM), when attached. */
  destination: null | {
    pool: string;
    kind: string;
    migrationSlot: number;
    token0Mint?: string;
    token1Mint?: string;
    token0Vault?: string;
    token1Vault?: string;
    poolCreator?: string;
    /** Locks whose Fee Key the migration minted to platform_nft_wallet; null = not recorded on the spec. */
    platformLocks: string[] | null;
    platformNftWallet: string | null;
  };
  fundingDestinations: string[];
  forgePlatformLpBeneficiary: string | null;
}

export interface RevenueDraft {
  kind: "collection" | "funding_inflow";
  stream: CollectionStream | "last60_funding_inflow";
  launchPhase: LaunchPhase | null;
  pool: string;
  signature: string;
  slot: number;
  blockTime: number | null;
  instructionIndex: number;
  innerInstructionIndex: number | null;
  ordinal: number;
  feeMint: string;
  asset: string;
  decimals: number | null;
  grossAmount: bigint | null;
  netAmount: bigint;
  sourceAccount: string | null;
  destinationAccount: string | null;
  sourceOwner: string | null;
  destinationOwner: string | null;
  beneficiary: string | null;
  memoClaimSignature: string | null;
  evidence: Record<string, string | number | boolean | null>;
}

const keyOf = (d: Pick<RevenueDraft, "stream" | "signature" | "ordinal" | "feeMint">) => `${d.stream}:${d.signature}:${d.ordinal}:${d.feeMint}`;
export { keyOf as revenueEventKey };

function decimalsOf(tx: NormalizedTx, account: string): number | null {
  const b = tx.postTokenBalances.find((x) => x.account === account) ?? tx.preTokenBalances.find((x) => x.account === account);
  return b ? b.decimals : null;
}

/** `last60:v1:<signature>` memos in the transaction; null when none, "ambiguous" when they disagree. */
export function fundingMemoOf(tx: NormalizedTx): string | null | "ambiguous" {
  const sigs = new Set<string>();
  for (const ix of tx.instructions) {
    if (!MEMO_PROGRAM_IDS.has(ix.programId)) continue;
    const s = parseFundingMemo(ix.data.toString("utf8"));
    if (s) sigs.add(s);
  }
  if (sigs.size === 0) return null;
  return sigs.size === 1 ? [...sigs][0]! : "ambiguous";
}

/** System Program `Transfer` (instruction tag 2): [from, to], u64 lamports at byte 4. */
export function decodeSystemTransfer(ix: FlatInstruction): { from: string; to: string; lamports: bigint } | null {
  if (ix.programId !== SYSTEM_PROGRAM_ID || ix.data.length < 12 || ix.accounts.length < 2) return null;
  if (ix.data.readUInt32LE(0) !== 2) return null;
  return { from: ix.accounts[0]!, to: ix.accounts[1]!, lamports: ix.data.readBigUInt64LE(4) };
}

export function extractRevenue(tx: NormalizedTx, parsed: ParsedTransaction, f: RevenueLaunchFacts): RevenueDraft[] {
  if (tx.err) return [];
  const out: RevenueDraft[] = [];
  const byOrdinal = new Map(tx.instructions.map((ix) => [ix.ordinal, ix]));
  const pos = (ordinal: number) => {
    const ix = byOrdinal.get(ordinal);
    return { instructionIndex: ix?.topIndex ?? -1, innerInstructionIndex: ix?.innerIndex ?? null, ordinal };
  };
  const common = (pool: string) => ({ pool, signature: tx.signature, slot: tx.slot, blockTime: tx.blockTime, memoClaimSignature: null as string | null });

  // 1. Bonding-curve creator-fee collections (only the configured creator role parses them).
  if (f.role === "creator" && f.creatorClaimVaults.length) {
    const vaults = new Set(f.creatorClaimVaults);
    for (const c of parsed.claims) {
      if (c.pool && c.pool !== f.sourcePool) continue;
      const ixOrdinal = typeof c.evidence?.instruction === "number" ? (c.evidence.instruction as number) : null;
      const ix = ixOrdinal !== null ? byOrdinal.get(ixOrdinal) : null;
      if (!ix) continue; // no instruction-scoped evidence → not a collection we can attribute
      for (const t of subtreeTransfers(tx, ix)) {
        if (!vaults.has(t.source) || t.amount === 0n) continue;
        const info = tokenAccountInfo(tx, t.destination);
        const mint = t.mint ?? info?.mint ?? tokenAccountInfo(tx, t.source)?.mint ?? null;
        if (!mint) continue;
        out.push({
          kind: "collection",
          stream: "bonding_curve_creator_fee",
          launchPhase: "bonding_curve",
          ...common(f.sourcePool),
          ...pos(t.ordinal),
          feeMint: mint,
          asset: assetOf(mint),
          decimals: decimalsOf(tx, t.destination),
          grossAmount: t.amount,
          netAmount: t.amount,
          sourceAccount: t.source,
          destinationAccount: t.destination,
          sourceOwner: null,
          destinationOwner: info?.owner ?? null,
          beneficiary: info?.owner ?? null,
          evidence: { claimInstruction: ix.ordinal, claimer: c.claimer, vault: t.source, transfer: t.ordinal },
        });
      }
    }
  }

  // 2. CPMM creator-fee collections (direct creator revenue; parsed by the CPMM destination adapter).
  for (const a of parsed.attributions ?? []) {
    if (a.kind !== "creator_fee_collection" || a.phase !== "post_migration_trading" || !f.destination) continue;
    const ordinal = Number(a.evidence?.transfer ?? NaN);
    if (!Number.isInteger(ordinal)) continue;
    const to = String(a.evidence?.to ?? "");
    out.push({
      kind: "collection",
      stream: "cpmm_creator_trading_fee",
      launchPhase: "post_migration",
      ...common(f.destination.pool),
      ...pos(ordinal),
      feeMint: a.feeMint,
      asset: assetOf(a.feeMint),
      decimals: to ? decimalsOf(tx, to) : null,
      // The accrued (pre-share) amount is not in the transaction: only the net transfer is observed.
      grossAmount: null,
      netAmount: a.creatorAmount + a.excludedAmount,
      sourceAccount: String(a.evidence?.from ?? "") || null,
      destinationAccount: to || null,
      sourceOwner: null,
      destinationOwner: (a.evidence?.recipient as string | null) ?? null,
      beneficiary: (a.evidence?.recipient as string | null) ?? null,
      evidence: { collectionInstruction: Number(a.evidence?.instruction ?? -1), poolCreator: (a.evidence?.poolCreator as string | null) ?? null },
    });
  }

  // 3. Forge platform LP fee collections (LP-lock collect_cp_fees on a platform-owned Fee Key).
  const d = f.destination;
  if (d && d.kind === "launchlab_cpmm" && d.token0Vault && d.token1Vault) {
    const vaultMint = (v: string) => (v === d.token0Vault ? d.token0Mint! : v === d.token1Vault ? d.token1Mint! : null);
    for (const ix of tx.instructions) {
      if (ix.programId !== RAYDIUM_CP_LOCK_PROGRAM_ID || !ix.data.subarray(0, 8).equals(COLLECT_CP_FEES_DISC) || ix.accounts[6] !== d.pool) continue;
      const lockPda = ix.accounts[3]!;
      const feeKeyHolder = ix.accounts[1]!;
      const platformLock = d.platformLocks === null ? null : d.platformLocks.includes(lockPda);
      // Locks known NOT to be platform-owned (creator Fee Keys of historical migrations, others)
      // are not Forge revenue. Unknown (spec without lock facts) is recorded only when the Forge
      // beneficiary itself collected, and then as unresolved (see revenue/ingest.ts).
      if (platformLock === false) continue;
      if (platformLock === null && feeKeyHolder !== f.forgePlatformLpBeneficiary) continue;
      for (const t of subtreeTransfers(tx, ix)) {
        const mint = vaultMint(t.source);
        if (!mint || t.amount === 0n) continue;
        const recipient = tokenAccountInfo(tx, t.destination)?.owner ?? null;
        out.push({
          kind: "collection",
          stream: "forge_platform_lp_fee_collection",
          launchPhase: "post_migration",
          ...common(d.pool),
          ...pos(t.ordinal),
          feeMint: mint,
          asset: assetOf(mint),
          decimals: decimalsOf(tx, t.destination),
          grossAmount: t.amount,
          netAmount: t.amount,
          sourceAccount: t.source,
          destinationAccount: t.destination,
          sourceOwner: null,
          destinationOwner: recipient,
          beneficiary: recipient,
          evidence: { collectInstruction: ix.ordinal, lockPda, feeKeyHolder, platformLock: platformLock === null ? "unknown" : true },
        });
      }
    }
  }

  // 4. Funding inflows into configured Last-60 destinations.
  const destinations = new Set(f.fundingDestinations);
  if (destinations.size) {
    const sources = new Set([f.creator, f.forgePlatformLpBeneficiary, f.destination?.platformNftWallet].filter((x): x is string => !!x));
    const memo = fundingMemoOf(tx);
    const memoSig = memo === "ambiguous" ? null : memo;
    for (const ix of tx.instructions) {
      const sys = decodeSystemTransfer(ix);
      if (sys) {
        if (!destinations.has(sys.to) || destinations.has(sys.from) || !sources.has(sys.from) || sys.lamports === 0n) continue;
        out.push({
          kind: "funding_inflow",
          stream: "last60_funding_inflow",
          launchPhase: null,
          ...common(f.sourcePool),
          ...pos(ix.ordinal),
          memoClaimSignature: memoSig,
          feeMint: NATIVE_SOL,
          asset: assetOf(NATIVE_SOL),
          decimals: 9,
          grossAmount: sys.lamports,
          netAmount: sys.lamports,
          sourceAccount: sys.from,
          destinationAccount: sys.to,
          sourceOwner: sys.from,
          destinationOwner: sys.to,
          beneficiary: sys.to,
          evidence: { program: "system", memo: memo === "ambiguous" ? "ambiguous" : memo },
        });
        continue;
      }
      const t = decodeTokenTransfer(ix);
      if (!t || t.amount === 0n) continue;
      const dst = tokenAccountInfo(tx, t.destination);
      if (!dst?.owner || !destinations.has(dst.owner)) continue;
      const src = tokenAccountInfo(tx, t.source);
      const sourceOwner = src?.owner ?? t.authority;
      if (destinations.has(sourceOwner) || !sources.has(sourceOwner)) continue;
      // Destination ownership and mint come from the transaction's own token-balance metadata; a
      // TransferChecked mint must agree with it (else the inflow is not accepted).
      if (t.mint && t.mint !== dst.mint) continue;
      out.push({
        kind: "funding_inflow",
        stream: "last60_funding_inflow",
        launchPhase: null,
        ...common(f.sourcePool),
        ...pos(ix.ordinal),
        memoClaimSignature: memoSig,
        feeMint: dst.mint,
        asset: assetOf(dst.mint),
        decimals: decimalsOf(tx, t.destination),
        grossAmount: t.amount,
        netAmount: t.amount,
        sourceAccount: t.source,
        destinationAccount: t.destination,
        sourceOwner,
        destinationOwner: dst.owner,
        beneficiary: dst.owner,
        evidence: { program: t.program === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" ? "token-2022" : "token", memo: memo === "ambiguous" ? "ambiguous" : memo },
      });
    }
  }
  return out;
}
