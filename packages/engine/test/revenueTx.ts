/**
 * Synthetic NormalizedTx builder for revenue tests (instruction-level, with token-balance metadata),
 * for transaction shapes not observed on mainnet yet (Forge's claim + distribution flows).
 */
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import type { FlatInstruction, NormalizedTx, TokenBalance } from "../src/chain/tx";
import { SPL_TOKEN_PROGRAM_ID } from "../src/chain/tx";
import { SYSTEM_PROGRAM_ID } from "../src/revenue/decode";

export const addr = () => Keypair.generate().publicKey.toBase58();
export const sig = () => bs58.encode(Keypair.generate().secretKey.subarray(0, 64));
export const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

export type Ix = { programId: string; accounts: string[]; data: Buffer; inner?: Ix[] };

export const systemTransfer = (from: string, to: string, lamports: bigint): Ix => {
  const d = Buffer.alloc(12);
  d.writeUInt32LE(2, 0);
  d.writeBigUInt64LE(lamports, 4);
  return { programId: SYSTEM_PROGRAM_ID, accounts: [from, to], data: d };
};
export const splTransfer = (src: string, dst: string, authority: string, amount: bigint): Ix => {
  const d = Buffer.alloc(9);
  d[0] = 3;
  d.writeBigUInt64LE(amount, 1);
  return { programId: SPL_TOKEN_PROGRAM_ID, accounts: [src, dst, authority], data: d };
};
export const splTransferChecked = (src: string, mint: string, dst: string, authority: string, amount: bigint, decimals = 9): Ix => {
  const d = Buffer.alloc(10);
  d[0] = 12;
  d.writeBigUInt64LE(amount, 1);
  d[9] = decimals;
  return { programId: SPL_TOKEN_PROGRAM_ID, accounts: [src, mint, dst, authority], data: d };
};
export const memo = (text: string): Ix => ({ programId: MEMO, accounts: [], data: Buffer.from(text, "utf8") });
export const opaque = (programId: string, accounts: string[], data: Buffer, inner: Ix[] = []): Ix => ({ programId, accounts, data, inner });

/** Build a NormalizedTx; `tokens` gives token-account metadata (owner, mint, decimals). */
export function buildTx(o: { signature?: string; slot: number; ixs: Ix[]; tokens?: Record<string, { owner: string; mint: string; decimals?: number }>; feePayer?: string; err?: unknown }): NormalizedTx {
  const instructions: FlatInstruction[] = [];
  let ordinal = 0;
  o.ixs.forEach((ix, topIndex) => {
    instructions.push({ ordinal: ordinal++, topIndex, innerIndex: null, stackHeight: 1, stackHeightKnown: true, programId: ix.programId, accounts: ix.accounts, data: ix.data });
    (ix.inner ?? []).forEach((inner, innerIndex) => instructions.push({ ordinal: ordinal++, topIndex, innerIndex, stackHeight: 2, stackHeightKnown: true, programId: inner.programId, accounts: inner.accounts, data: inner.data }));
  });
  const balances: TokenBalance[] = Object.entries(o.tokens ?? {}).map(([account, t], i) => ({ accountIndex: i, account, mint: t.mint, owner: t.owner, programId: SPL_TOKEN_PROGRAM_ID, amount: 0n, decimals: t.decimals ?? 9 }));
  const feePayer = o.feePayer ?? addr();
  return { signature: o.signature ?? sig(), slot: o.slot, blockTime: 1_790_000_000 + o.slot, version: 0, err: o.err ?? null, fee: 5000n, feePayer, signers: new Set([feePayer]), accountKeys: [feePayer], instructions, preTokenBalances: balances, postTokenBalances: balances, preBalances: [], postBalances: [], logMessages: [] };
}
