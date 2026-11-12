/**
 * Pure decoding of phase-aware revenue facts from ONE normalized transaction (no I/O).
 *
 * Collections (instruction-scoped transfers, never whole-transaction balance deltas):
 *   bonding_curve_creator_fee        creator-fee claim of the bonding pool (LaunchLab claim_creator_fee
 *                                    out of the creator fee vault; DBC claim_creator_trading_fee out of
 *                                    the pool's quote/base vaults; pump.fun collect_creator_fee out of
 *                                    the creator vault, in native SOL), as parsed by the provider;
 *   cpmm_creator_trading_fee         CPMM collect_creator_fee(_permissionless) transfers to pool_creator;
 *   damm_v2_creator_lp_fee           DAMM v2 claim_position_fee on a migration position of the verified
 *                                    Meteora DBC graduation, transfers out of the pool's token vaults;
 *   pumpswap_creator_fee             pump_amm collect_coin_creator_fee out of the creator's coin creator
 *                                    vault, after a verified pump.fun → PumpSwap graduation;
 *   forge_platform_lp_fee_collection LP-lock collect_cp_fees on a lock whose Fee Key was minted to the
 *                                    PlatformConfig platform_nft_wallet by the verified migration.
 * Funding inflows (last60_funding_inflow): System Program transfers (native SOL) and SPL Token /
 * Token-2022 Transfer / TransferChecked into a configured Last-60 funding destination, from a wallet
 * that can be a collection recipient of this launch (the creator, the Forge LP beneficiary, the
 * platform NFT wallet). Anything else reaching the destination is not revenue of this launch.
 */
import type { FlatInstruction, NormalizedTx } from "../chain/tx";
import { childInstructions, decodeTokenTransfer, SPL_TOKEN_2022_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID, subtreeTransfers, tokenAccountInfo } from "../chain/tx";
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { COLLECT_CP_FEES_DISC, RAYDIUM_CP_LOCK_PROGRAM_ID } from "../providers/migration";
import type { ParsedTransaction } from "../providers/LaunchProvider";
import { assetOf, FORGE_CREATOR_DISTRIBUTION, NATIVE_SOL, parseCustodyMemo, parseFundingMemo, type CollectionStream, type FundingRoute, type LaunchPhase } from "../accounting/revenueStreams";

export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const MEMO_PROGRAM_IDS = new Set(["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "Memo1UhkJRfHyvLMcVucJwxXeuD728EQVDDwQDxFMNo"]);
export const ATA_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
/**
 * Programs a Forge creator-distribution transaction may contain. Forgepad's `sendPayouts` builds
 * System `transfer`s, an idempotent ATA create and an SPL `TransferChecked` (plus the compute budget a
 * wallet adds). Anything else (an LP harvest, a Jupiter swap, an unknown program) is not that payout.
 */
export const FORGE_DISTRIBUTION_PROGRAMS = new Set([SYSTEM_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID, SPL_TOKEN_2022_PROGRAM_ID, ATA_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID, ...MEMO_PROGRAM_IDS]);

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
  /** Vaults that bonding-curve creator-fee claims are paid out of (LaunchLab creator fee vault / DBC pool vaults / pump.fun creator vault). */
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
  /** Funding inflows only: how the funds reached Last-60 (null for collections). */
  route: FundingRoute | null;
  evidence: Record<string, string | number | boolean | null>;
}

const keyOf = (d: Pick<RevenueDraft, "stream" | "signature" | "ordinal" | "feeMint">) => `${d.stream}:${d.signature}:${d.ordinal}:${d.feeMint}`;
export { keyOf as revenueEventKey };

/**
 * The candidate whose associated token account for `mint` (under `tokenProgram`) is `account`, else null.
 * An ATA address is a PDA of (owner, token program, mint), so a match proves ownership without the
 * account still existing — but only for these explicit candidates, never by searching.
 */
export function ataOwnerOf(account: string, mint: string, tokenProgram: string, candidates: readonly (string | null | undefined)[]): string | null {
  if (tokenProgram !== SPL_TOKEN_PROGRAM_ID && tokenProgram !== SPL_TOKEN_2022_PROGRAM_ID) return null;
  for (const c of candidates) {
    if (!c) continue;
    try {
      if (getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(c), true, new PublicKey(tokenProgram), ASSOCIATED_TOKEN_PROGRAM_ID).toBase58() === account) return c;
    } catch {
      /* not a valid key */
    }
  }
  return null;
}

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

/** Distinct `last60:custody:v1:<id>` memos in the transaction (custody transfers, never contributions). */
export function custodyMemosOf(tx: NormalizedTx): string[] {
  const ids = new Set<string>();
  for (const ix of tx.instructions) {
    if (!MEMO_PROGRAM_IDS.has(ix.programId)) continue;
    const id = parseCustodyMemo(ix.data.toString("utf8"));
    if (id) ids.add(id);
  }
  return [...ids];
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
  const common = (pool: string) => ({ pool, signature: tx.signature, slot: tx.slot, blockTime: tx.blockTime, memoClaimSignature: null as string | null, route: null as FundingRoute | null });

  // 1. Bonding-curve creator-fee collections (only the configured creator role parses them).
  if (f.role === "creator" && f.creatorClaimVaults.length) {
    const vaults = new Set(f.creatorClaimVaults);
    for (const c of parsed.claims) {
      if (c.pool && c.pool !== f.sourcePool) continue;
      const ixOrdinal = typeof c.evidence?.instruction === "number" ? (c.evidence.instruction as number) : null;
      const ix = ixOrdinal !== null ? byOrdinal.get(ixOrdinal) : null;
      if (!ix) continue; // no instruction-scoped evidence → not a collection we can attribute
      if (c.evidence?.native === true) {
        // pump.fun collect_creator_fee: native SOL, moved by the System Program transfers the claim
        // instruction itself invoked (vault → creator). The program's event must state the same total.
        const paid = childInstructions(tx, ix).map((x) => ({ ix: x, t: decodeSystemTransfer(x) })).filter((x): x is { ix: FlatInstruction; t: NonNullable<ReturnType<typeof decodeSystemTransfer>> } => !!x.t && vaults.has(x.t.from) && x.t.lamports > 0n);
        if (paid.reduce((a, x) => a + x.t.lamports, 0n) !== c.quoteAmount) continue; // event and transfers disagree → not attributable
        for (const p of paid) {
          out.push({
            kind: "collection",
            stream: "bonding_curve_creator_fee",
            launchPhase: "bonding_curve",
            ...common(f.sourcePool),
            ...pos(p.ix.ordinal),
            feeMint: NATIVE_SOL,
            asset: assetOf(NATIVE_SOL),
            decimals: 9,
            grossAmount: p.t.lamports,
            netAmount: p.t.lamports,
            sourceAccount: p.t.from,
            destinationAccount: p.t.to,
            sourceOwner: null,
            destinationOwner: p.t.to,
            beneficiary: p.t.to,
            evidence: { claimInstruction: ix.ordinal, claimer: c.claimer, vault: p.t.from, transfer: p.ix.ordinal, event: String(c.evidence?.event ?? ""), native: true },
          });
        }
        continue;
      }
      for (const t of subtreeTransfers(tx, ix)) {
        if (!vaults.has(t.source) || t.amount === 0n) continue;
        const info = tokenAccountInfo(tx, t.destination);
        const mint = t.mint ?? info?.mint ?? tokenAccountInfo(tx, t.source)?.mint ?? null;
        if (!mint) continue;
        // A claim into an ATA that the same transaction creates and closes (the usual WSOL claim → unwrap)
        // leaves no token-balance record, so the owner is proven from the ATA address instead.
        const owner = info?.owner ?? ataOwnerOf(t.destination, mint, t.program, [f.creator, c.claimer]);
        out.push({
          kind: "collection",
          stream: "bonding_curve_creator_fee",
          launchPhase: "bonding_curve",
          ...common(f.sourcePool),
          ...pos(t.ordinal),
          feeMint: mint,
          asset: assetOf(mint),
          decimals: decimalsOf(tx, t.destination) ?? t.decimals ?? null,
          grossAmount: t.amount,
          netAmount: t.amount,
          sourceAccount: t.source,
          destinationAccount: t.destination,
          sourceOwner: null,
          destinationOwner: owner,
          beneficiary: owner,
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

  // 3b. Meteora DBC → DAMM v2: LP fees claimed from the migration positions (claim_position_fee,
  //     already restricted to the destination's migration positions by the DAMM v2 adapter). Only the
  //     launch creator's claims are the creator's revenue; the partner's position is not this launch's.
  if (d && d.kind === "dbc_damm_v2" && f.role === "creator") {
    for (const c of parsed.claims) {
      if (c.pool !== d.pool || c.evidence?.event !== "EvtClaimPositionFee") continue;
      const ixOrdinal = typeof c.evidence?.instruction === "number" ? (c.evidence.instruction as number) : null;
      const ix = ixOrdinal !== null ? byOrdinal.get(ixOrdinal) : null;
      // claim_position_fee accounts: [pool_authority, pool, position, token_a_account, token_b_account, token_a_vault, token_b_vault, token_a_mint, token_b_mint, position_nft_account, owner, …]
      if (!ix || ix.accounts[1] !== d.pool) continue;
      const owner = (c.evidence?.owner as string | undefined) ?? ix.accounts[10] ?? null;
      if (!owner || owner !== f.creator) continue;
      const vaultMint = new Map([[ix.accounts[5]!, ix.accounts[7]!], [ix.accounts[6]!, ix.accounts[8]!]]);
      for (const t of subtreeTransfers(tx, ix)) {
        const mint = vaultMint.get(t.source);
        if (!mint || t.amount === 0n) continue;
        const info = tokenAccountInfo(tx, t.destination);
        const recipient = info?.owner ?? ataOwnerOf(t.destination, mint, t.program, [f.creator, owner]);
        out.push({
          kind: "collection",
          stream: "damm_v2_creator_lp_fee",
          launchPhase: "post_migration",
          ...common(d.pool),
          ...pos(t.ordinal),
          feeMint: mint,
          asset: assetOf(mint),
          decimals: decimalsOf(tx, t.destination) ?? t.decimals ?? null,
          grossAmount: t.amount,
          netAmount: t.amount,
          sourceAccount: t.source,
          destinationAccount: t.destination,
          sourceOwner: null,
          destinationOwner: recipient,
          beneficiary: recipient,
          evidence: { claimInstruction: ix.ordinal, position: String(c.evidence?.position ?? ix.accounts[2] ?? ""), positionOwner: owner, vault: t.source, transfer: t.ordinal },
        });
      }
    }
  }

  // 3c. pump.fun → PumpSwap: coin creator fees collected from the creator's vault (collect_coin_creator_fee,
  //     already restricted to the launch creator's own vault by the PumpSwap adapter).
  if (d && d.kind === "pumpfun_pumpswap" && f.role === "creator") {
    for (const c of parsed.claims) {
      if (c.pool !== d.pool || c.evidence?.event !== "CollectCoinCreatorFeeEvent") continue;
      const ixOrdinal = typeof c.evidence?.instruction === "number" ? (c.evidence.instruction as number) : null;
      const ix = ixOrdinal !== null ? byOrdinal.get(ixOrdinal) : null;
      const vault = String(c.evidence?.vault ?? "");
      if (!ix || !vault) continue;
      const paid = subtreeTransfers(tx, ix).filter((t) => t.source === vault && t.amount > 0n);
      if (paid.reduce((a, t) => a + t.amount, 0n) !== c.quoteAmount) continue; // event and transfers disagree → not attributable
      for (const t of paid) {
        const info = tokenAccountInfo(tx, t.destination);
        const mint = t.mint ?? info?.mint ?? f.quoteMint;
        // Collected into a WSOL account the same transaction creates and closes: owner proven from the ATA address.
        const recipient = info?.owner ?? ataOwnerOf(t.destination, mint, t.program, [f.creator, c.claimer]);
        out.push({
          kind: "collection",
          stream: "pumpswap_creator_fee",
          launchPhase: "post_migration",
          ...common(d.pool),
          ...pos(t.ordinal),
          feeMint: mint,
          asset: assetOf(mint),
          decimals: decimalsOf(tx, t.destination) ?? t.decimals ?? null,
          grossAmount: t.amount,
          netAmount: t.amount,
          sourceAccount: t.source,
          destinationAccount: t.destination,
          sourceOwner: null,
          destinationOwner: recipient,
          beneficiary: recipient,
          evidence: { claimInstruction: ix.ordinal, claimer: c.claimer, vault, transfer: t.ordinal, event: "CollectCoinCreatorFeeEvent" },
        });
      }
    }
  }

  // 4. Forge's existing post-migration creator distributions (route forge_creator_distribution).
  const forge = forgeCreatorDistribution(tx, f);
  const forgeLegs = new Set(forge.map((x) => x.ordinal));
  out.push(...forge);

  // 5. Funding inflows into configured Last-60 destinations. A transaction declared as a CUSTODY
  //    transfer (last60:custody:v1 memo) moves an already-credited contribution into the payout wallet:
  //    it is never a second contribution, so none of its transfers is recorded as a funding inflow.
  const destinations = new Set(f.fundingDestinations);
  if (destinations.size && custodyMemosOf(tx).length === 0) {
    const sources = new Set([f.creator, f.forgePlatformLpBeneficiary, f.destination?.platformNftWallet].filter((x): x is string => !!x));
    const memo = fundingMemoOf(tx);
    const memoSig = memo === "ambiguous" ? null : memo;
    for (const ix of tx.instructions) {
      if (forgeLegs.has(ix.ordinal)) continue; // already recorded as a Forge creator distribution leg
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
          route: "last60_destination",
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
        route: "last60_destination",
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

/**
 * Forge's EXISTING post-migration creator payout (Forgepad `scripts/Raypostmigration.js`,
 * `sendPayouts`, on `new-ui` @ 5acce50), observed as is — Last-60 requires no Forgepad change:
 *
 *   harvest tx  : LP-lock `collect_cp_fees` on the platform Fee Key → fees into the Forge wallet
 *                 (token leg into its associated token account; WSOL leg unwrapped to native SOL);
 *   payout tx   : a SEPARATE transaction, fee payer and signer = the Forge wallet, no memo:
 *                   System transfer        Forge → creator   ⌊SOL basis × 50 %⌋   (no rewards distributor)
 *                   ATA create (idempotent) + TransferChecked Forge → creator, launch token, ⌊token leg × 50 %⌋
 *                 With a Forge rewards distributor the same transaction also pays the distributor and
 *                 the creator gets 25 % — not the approved model; recorded, never credited.
 *
 * A transaction is a candidate when the Forge wallet pays the launch creator, or pays THIS launch's
 * token to anyone in a transfer-only transaction. Every Forge outflow of a candidate is recorded as a
 * leg (route forge_creator_distribution); the shape is checked here and the result stored as evidence:
 * fee payer, programs, one transfer per asset, every outflow to the creator, no foreign mint, and the
 * anchor (a leg in this launch's token mint — the launch identity). Attribution to a harvest happens
 * in revenue/ingest.ts (never by amount).
 */
export function forgeCreatorDistribution(tx: NormalizedTx, f: RevenueLaunchFacts): RevenueDraft[] {
  const W = f.forgePlatformLpBeneficiary;
  const C = f.creator;
  const d = f.destination;
  if (tx.err || !W || !C || C === W || !d || d.kind !== "launchlab_cpmm" || tx.slot <= d.migrationSlot) return [];
  type Leg = { ordinal: number; mint: string; to: string | null; toAccount: string; fromAccount: string; amount: bigint; decimals: number | null; program: string; mintMismatch: boolean };
  const legs: Leg[] = [];
  const topProgram = new Map(tx.instructions.filter((ix) => ix.innerIndex === null).map((ix) => [ix.topIndex, ix.programId]));
  for (const ix of tx.instructions) {
    const sys = decodeSystemTransfer(ix);
    // The ATA program tops up rent with an inner System transfer when the address was pre-funded:
    // account creation, not a payout.
    if (sys && ix.innerIndex !== null && topProgram.get(ix.topIndex) === ATA_PROGRAM_ID) continue;
    if (sys) {
      if (sys.from === W && sys.to !== W && sys.lamports > 0n) legs.push({ ordinal: ix.ordinal, mint: NATIVE_SOL, to: sys.to, toAccount: sys.to, fromAccount: sys.from, amount: sys.lamports, decimals: 9, program: "system", mintMismatch: false });
      continue;
    }
    const t = decodeTokenTransfer(ix);
    if (!t || t.amount === 0n) continue;
    const src = tokenAccountInfo(tx, t.source);
    if ((src?.owner ?? t.authority) !== W) continue;
    const dst = tokenAccountInfo(tx, t.destination);
    if (dst?.owner === W) continue; // internal move between Forge's own accounts
    const mint = dst?.mint ?? src?.mint ?? t.mint;
    if (!mint) continue;
    legs.push({ ordinal: ix.ordinal, mint, to: dst?.owner ?? null, toAccount: t.destination, fromAccount: t.source, amount: t.amount, decimals: decimalsOf(tx, t.destination), program: t.program === SPL_TOKEN_2022_PROGRAM_ID ? "token-2022" : "token", mintMismatch: !!t.mint && (t.mint !== mint || (!!src && src.mint !== mint)) });
  }
  const programs = [...new Set(tx.instructions.map((ix) => ix.programId))];
  const transferOnly = programs.every((p) => FORGE_DISTRIBUTION_PROGRAMS.has(p));
  const toCreator = legs.filter((l) => l.to === C);
  const anchorLegs = toCreator.filter((l) => l.mint === f.tokenMint);
  // Transfers into a configured Last-60 funding destination keep their own route (PR #6 / #7: same
  // transaction or memo); they still count as non-creator outflows for the shape of this transaction.
  const destinations = new Set(f.fundingDestinations);
  // (A leg to the launch creator always takes this route, even if the creator wallet is also listed
  // as a funding destination: this route tries the same-transaction / memo evidence first.)
  const recorded = legs.filter((l) => l.to === C || !(l.to && destinations.has(l.to)));
  const candidate = toCreator.length > 0 || (transferOnly && recorded.some((l) => l.mint === f.tokenMint));
  if (!candidate) return [];
  // A payout that carries ANOTHER token (and not this launch's) belongs to that launch — e.g. the same
  // creator's other Forge launch. It is that launch's revenue (recorded by its own indexer, if Last-60
  // indexes it), never this launch's: not recorded here, so it can never be attributed here.
  if (!anchorLegs.length && toCreator.some((l) => l.mint !== NATIVE_SOL && l.mint !== f.tokenMint)) return [];
  const problems: string[] = [];
  if (tx.feePayer !== W) problems.push(`fee_payer_not_forge_platform_wallet: ${tx.feePayer}`);
  if (d.platformNftWallet && d.platformNftWallet !== W) problems.push(`forge_wallet_${W}_is_not_the_platform_nft_wallet_${d.platformNftWallet}`);
  if (!transferOnly) problems.push(`unexpected_programs: ${programs.filter((p) => !FORGE_DISTRIBUTION_PROGRAMS.has(p)).join(",")}`);
  const others = [...new Set(legs.filter((l) => l.to !== C).map((l) => l.to ?? `unknown-owner:${l.toAccount}`))];
  if (others.length) problems.push(`forge_outflow_to_non_creator: ${others.join(",")} (not the approved creator-50 % payout, e.g. Forge's rewards-distributor 25/50/25 split)`);
  const foreign = [...new Set(toCreator.filter((l) => l.mint !== NATIVE_SOL && l.mint !== f.tokenMint).map((l) => l.mint))];
  if (foreign.length) problems.push(`foreign_mint_leg: ${foreign.join(",")} (not this launch's token)`);
  const perAsset = new Map<string, number>();
  for (const l of toCreator) perAsset.set(assetOf(l.mint), (perAsset.get(assetOf(l.mint)) ?? 0) + 1);
  const dupAssets = [...perAsset].filter(([, n]) => n > 1).map(([a]) => a);
  if (dupAssets.length) problems.push(`multiple_transfers_in_one_asset: ${dupAssets.join(",")}`);
  if (legs.some((l) => l.mintMismatch)) problems.push("transfer_checked_mint_mismatch");
  if (!anchorLegs.length) problems.push(`no_launch_anchor: no ${f.tokenMint} leg from the Forge wallet to the creator (a SOL transfer alone never identifies the launch)`);
  const memo = fundingMemoOf(tx);
  if (memo === "ambiguous") problems.push("multiple_distinct_last60_memos");
  return recorded.map((l) => ({
    kind: "funding_inflow" as const,
    stream: "last60_funding_inflow" as const,
    launchPhase: null,
    pool: f.sourcePool,
    signature: tx.signature,
    slot: tx.slot,
    blockTime: tx.blockTime,
    instructionIndex: tx.instructions.find((ix) => ix.ordinal === l.ordinal)?.topIndex ?? -1,
    innerInstructionIndex: tx.instructions.find((ix) => ix.ordinal === l.ordinal)?.innerIndex ?? null,
    ordinal: l.ordinal,
    feeMint: l.mint,
    asset: assetOf(l.mint),
    decimals: l.decimals,
    grossAmount: l.amount,
    netAmount: l.amount,
    sourceAccount: l.fromAccount,
    destinationAccount: l.toAccount,
    sourceOwner: W,
    destinationOwner: l.to,
    beneficiary: l.to,
    memoClaimSignature: memo === "ambiguous" ? null : memo,
    route: FORGE_CREATOR_DISTRIBUTION,
    evidence: {
      program: l.program,
      route: FORGE_CREATOR_DISTRIBUTION,
      // A leg of THIS launch's token from Forge to the creator: evidence of a Forge post-migration
      // payout of this launch (also when other shape problems make it unpayable).
      anchored: anchorLegs.length > 0,
      anchorMint: f.tokenMint,
      toCreator: l.to === C,
      feePayer: tx.feePayer,
      legs: legs.length,
      problems: problems.join(" | ") || null,
      memo: memo === "ambiguous" ? "ambiguous" : memo,
    },
  }));
}
