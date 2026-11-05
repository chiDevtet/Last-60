/**
 * Provider abstraction. The rewards engine, database, API and frontend depend only on the types
 * in this file; switching LAUNCH_PROVIDER swaps the adapter and nothing else.
 *
 * Adapters must be honest about what the chain tells them:
 *   - `parseTransaction` is PURE (no I/O) and derives everything from decoded program events.
 *   - `eligibleFee` uses the exact integer formula the on-chain program applies.
 *   - Unknown/undecodable program activity on the pool is reported as an anomaly, never guessed.
 */
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { NormalizedTx } from "../chain/tx";

export type ProviderId = "meteora_dbc" | "raydium_launchlab" | "mock";
export type FeeBeneficiaryRole = "creator" | "partner" | "platform";
export type PoolStatus = "bonding" | "migrating" | "migrated";

export interface PoolInfo {
  provider: ProviderId;
  programId: string;
  poolAddress: string;
  tokenMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
  baseTokenProgram: string;
  quoteTokenProgram: string;
  creator: string;
  feeBeneficiaryRole: FeeBeneficiaryRole;
  /** The wallet entitled to the eligible fee share (and the signer of claims). */
  beneficiary: string;
  status: PoolStatus;
  /** Provider-specific fee parameters, for display and audit. */
  feeParams: Record<string, string | number | boolean>;
  /** Provider-specific addresses (config, vaults, fee vaults...). */
  accounts: Record<string, string>;
  /** Addresses the indexer must watch to observe every swap and every claim. */
  watchAddresses: string[];
  /** Slot at which this info was read. */
  slot: number;
}

export interface NormalizedSwap {
  signature: string;
  /** Stable index of the event inside the transaction (event CPI ordinal). */
  eventIndex: number;
  side: "buy" | "sell";
  trader: string;
  traderSource: "payer" | "balance_owner" | "fee_payer";
  /** Buy: gross quote spent incl. fees. Sell: net quote received. Base units. */
  quoteAmount: bigint;
  /** Buy: base received. Sell: base sold. Base units. */
  baseAmount: bigint;
  /** All fees charged by the program on this trade (all parties), in `totalFeeMint`. */
  totalFee: bigint;
  totalFeeMint: string;
  /** The beneficiary's share, computed with the program's own integer formula. */
  eligibleFee: bigint;
  eligibleFeeMint: string;
  slot: number;
  blockTime: number | null;
}

export interface NormalizedFeeClaim {
  signature: string;
  claimer: string;
  quoteAmount: bigint;
  baseAmount: bigint;
  slot: number;
  blockTime: number | null;
}

export interface ParsedTransaction {
  swaps: NormalizedSwap[];
  claims: NormalizedFeeClaim[];
  /** Things that touched the pool but could not be interpreted (alerted, never counted). */
  anomalies: string[];
}

export interface FeeSourceState {
  slot: number;
  /** Unclaimed eligible fees held on-chain for the beneficiary. */
  unclaimedQuote: bigint;
  unclaimedBase: bigint;
  /** True if the on-chain balance may include fees from other pools (LaunchLab creator vault). */
  mayIncludeOtherPools: boolean;
  source: string;
}

export interface ClaimPlan {
  instructions: TransactionInstruction[];
  /** Signer that must sign (the beneficiary). */
  signer: PublicKey;
  description: string;
}

export interface LaunchProvider {
  readonly id: ProviderId;
  readonly programId: string;
  /** Read and validate on-chain pool/config state. Throws on mismatch (wrong mint, wrong program...). */
  load(): Promise<PoolInfo>;
  /** Cached info from the last load/refresh. */
  info(): PoolInfo;
  /** Quote assets this provider supports for SOL-denominated accounting. */
  supportedQuoteAssets(): string[];
  parseTransaction(tx: NormalizedTx): ParsedTransaction;
  getFeeSourceState(): Promise<FeeSourceState>;
  /**
   * Instructions that claim the beneficiary's fees and deliver the payout asset to `destination`
   * (unwrapping WSOL when the payout asset is native SOL).
   */
  buildClaimInstructions(claimer: PublicKey, destination: PublicKey): Promise<ClaimPlan>;
}

export class ProviderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderValidationError";
  }
}

/**
 * Resolve who actually traded. Neither program puts the trader in its event, so we use the
 * emitting instruction's `payer` if it signed the transaction; otherwise (program-owned routing
 * accounts) the signer whose balance of `mint` moved in the trade's direction; else the fee payer.
 */
export function resolveTrader(
  tx: NormalizedTx,
  payer: string | undefined,
  mint: string,
  side: "buy" | "sell",
): { trader: string; source: NormalizedSwap["traderSource"] } {
  if (payer && tx.signers.has(payer)) return { trader: payer, source: "payer" };
  let best: { owner: string; delta: bigint } | null = null;
  const deltas = new Map<string, bigint>();
  for (const b of tx.postTokenBalances) if (b.mint === mint && b.owner) deltas.set(b.owner, (deltas.get(b.owner) ?? 0n) + b.amount);
  for (const b of tx.preTokenBalances) if (b.mint === mint && b.owner) deltas.set(b.owner, (deltas.get(b.owner) ?? 0n) - b.amount);
  for (const [owner, d] of deltas) {
    if (!tx.signers.has(owner)) continue;
    const directional = side === "buy" ? d : -d;
    if (directional > 0n && (!best || directional > best.delta)) best = { owner, delta: directional };
  }
  if (best) return { trader: best.owner, source: "balance_owner" };
  return { trader: tx.feePayer, source: "fee_payer" };
}
