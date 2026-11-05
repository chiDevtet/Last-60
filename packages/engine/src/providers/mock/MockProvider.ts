/**
 * Mock launch provider for local testing and automated tests. It decodes a synthetic program
 * ("MOCK") whose instruction data encodes trades, so the complete pipeline — RPC JSON →
 * normalizer → provider → indexer → database → rewards engine — runs without mainnet.
 *
 * Instruction data layout: [kind u8 (1 buy, 2 sell, 3 claim)] [quote u64] [base u64] [totalFee u64] [eligibleFee u64]
 * Accounts: [trader, pool]
 */
import { PublicKey, TransactionInstruction, type PublicKey as PK } from "@solana/web3.js";
import { WSOL_MINT } from "@last60/shared";
import type { NormalizedTx } from "../../chain/tx";
import type { ClaimPlan, FeeSourceState, LaunchProvider, ParsedTransaction, PoolInfo } from "../LaunchProvider";

export const MOCK_PROGRAM_ID = new PublicKey(Buffer.alloc(32, 0x4d)).toBase58();
export const MOCK_POOL = new PublicKey(Buffer.alloc(32, 0x50)).toBase58();
export const MOCK_MINT = new PublicKey(Buffer.alloc(32, 0x54)).toBase58();
export const MOCK_CREATOR = new PublicKey(Buffer.alloc(32, 0x43)).toBase58();

export function encodeMockTrade(kind: "buy" | "sell" | "claim", quote: bigint, base = 0n, totalFee = 0n, eligibleFee = 0n): Buffer {
  const b = Buffer.alloc(33);
  b[0] = kind === "buy" ? 1 : kind === "sell" ? 2 : 3;
  b.writeBigUInt64LE(quote, 1);
  b.writeBigUInt64LE(base, 9);
  b.writeBigUInt64LE(totalFee, 17);
  b.writeBigUInt64LE(eligibleFee, 25);
  return b;
}

export class MockProvider implements LaunchProvider {
  readonly id = "mock" as const;
  readonly programId = MOCK_PROGRAM_ID;
  unclaimed = 0n;
  private readonly pool: PoolInfo;

  constructor(opts: { poolAddress?: string; tokenMint?: string; beneficiary?: string } = {}) {
    const poolAddress = opts.poolAddress ?? MOCK_POOL;
    this.pool = {
      provider: "mock",
      programId: MOCK_PROGRAM_ID,
      poolAddress,
      tokenMint: opts.tokenMint ?? MOCK_MINT,
      quoteMint: WSOL_MINT,
      baseDecimals: 6,
      quoteDecimals: 9,
      baseTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      quoteTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      creator: opts.beneficiary ?? MOCK_CREATOR,
      feeBeneficiaryRole: "creator",
      beneficiary: opts.beneficiary ?? MOCK_CREATOR,
      status: "bonding",
      feeParams: { note: "mock provider — synthetic data only" },
      accounts: {},
      watchAddresses: [poolAddress],
      slot: 0,
    };
  }

  async load() {
    return this.pool;
  }
  info() {
    return this.pool;
  }
  supportedQuoteAssets() {
    return [WSOL_MINT];
  }

  parseTransaction(tx: NormalizedTx): ParsedTransaction {
    const out: ParsedTransaction = { swaps: [], claims: [], anomalies: [] };
    if (tx.err) return out;
    for (const ix of tx.instructions) {
      if (ix.programId !== MOCK_PROGRAM_ID || ix.accounts[1] !== this.pool.poolAddress) continue;
      const d = ix.data;
      if (d.length < 33) {
        out.anomalies.push("malformed mock instruction");
        continue;
      }
      const kind = d[0];
      const quote = d.readBigUInt64LE(1);
      if (kind === 3) {
        out.claims.push({ signature: tx.signature, claimer: ix.accounts[0]!, quoteAmount: quote, baseAmount: 0n, slot: tx.slot, blockTime: tx.blockTime });
        continue;
      }
      if (kind !== 1 && kind !== 2) {
        out.anomalies.push(`unknown mock kind ${kind}`);
        continue;
      }
      out.swaps.push({
        signature: tx.signature,
        eventIndex: ix.ordinal,
        side: kind === 1 ? "buy" : "sell",
        trader: ix.accounts[0]!,
        traderSource: "payer",
        quoteAmount: quote,
        baseAmount: d.readBigUInt64LE(9),
        totalFee: d.readBigUInt64LE(17),
        totalFeeMint: WSOL_MINT,
        eligibleFee: d.readBigUInt64LE(25),
        eligibleFeeMint: WSOL_MINT,
        slot: tx.slot,
        blockTime: tx.blockTime,
      });
    }
    return out;
  }

  async getFeeSourceState(): Promise<FeeSourceState> {
    return { slot: 0, unclaimedQuote: this.unclaimed, unclaimedBase: 0n, mayIncludeOtherPools: false, source: "mock" };
  }

  async buildClaimInstructions(claimer: PK, destination: PK): Promise<ClaimPlan> {
    return {
      instructions: [new TransactionInstruction({ programId: new PublicKey(MOCK_PROGRAM_ID), keys: [{ pubkey: claimer, isSigner: true, isWritable: true }, { pubkey: destination, isSigner: false, isWritable: true }], data: encodeMockTrade("claim", 0n) })],
      signer: claimer,
      description: "mock claim",
    };
  }
}
