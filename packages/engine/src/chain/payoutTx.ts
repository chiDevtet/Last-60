/**
 * One payout = one transaction = one recipient.
 *   SOL: ComputeBudget + SystemProgram.transfer (+ memo)
 *   SPL: ComputeBudget + createATA(idempotent) + transferChecked (+ memo); Token-2022 aware.
 */
import bs58 from "bs58";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { WSOL_MINT } from "@last60/shared";

export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

export interface PayoutTxParams {
  payer: Keypair;
  recipient: string;
  amount: bigint;
  mint: string;
  blockhash: string;
  priorityFeeMicroLamports: number;
  computeUnitLimit: number;
  memo?: string | null;
  token?: { program: string; decimals: number };
}

export function assertValidRecipient(recipient: string, payer: string): PublicKey {
  const pk = new PublicKey(recipient);
  if (pk.toBase58() !== recipient) throw new Error(`recipient ${recipient} is not canonical base58`);
  if (!PublicKey.isOnCurve(pk.toBytes())) throw new Error(`recipient ${recipient} is off-curve (program address); refusing to pay`);
  if (recipient === payer) throw new Error("recipient is the payout wallet itself");
  return pk;
}

/**
 * Construction only: the UNSIGNED payout transaction. Signing is done by the payout signer
 * (signer/payoutSigner.ts), which re-validates every instruction against a fenced authorization.
 */
export function buildUnsignedPayoutTransaction(p: Omit<PayoutTxParams, "payer"> & { payer: PublicKey }): Transaction {
  if (p.amount <= 0n) throw new Error("payout amount must be positive");
  const payer = p.payer;
  const to = assertValidRecipient(p.recipient, payer.toBase58());
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: p.computeUnitLimit }),
    ...(p.priorityFeeMicroLamports > 0 ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: p.priorityFeeMicroLamports })] : []),
  ];
  if (p.mint === WSOL_MINT) {
    if (p.amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("SOL payout exceeds safe integer range");
    ixs.push(SystemProgram.transfer({ fromPubkey: payer, toPubkey: to, lamports: p.amount }));
  } else {
    if (!p.token) throw new Error("SPL payout requires token program and decimals");
    const mint = new PublicKey(p.mint);
    const program = new PublicKey(p.token.program);
    const fromAta = getAssociatedTokenAddressSync(mint, payer, false, program);
    const toAta = getAssociatedTokenAddressSync(mint, to, false, program);
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(payer, toAta, to, mint, program));
    ixs.push(createTransferCheckedInstruction(fromAta, mint, toAta, payer, p.amount, p.token.decimals, [], program));
  }
  if (p.memo) ixs.push(new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(p.memo, "utf8") }));
  return new Transaction({ feePayer: payer, recentBlockhash: p.blockhash }).add(...ixs);
}

/** Construction + signing with a raw keypair (kept for tooling and tests; the worker uses PayoutSigner). */
export function buildPayoutTransaction(p: PayoutTxParams): { tx: Transaction; signature: string; serialized: string } {
  const tx = buildUnsignedPayoutTransaction({ ...p, payer: p.payer.publicKey });
  tx.sign(p.payer);
  const signature = bs58.encode(tx.signature!);
  return { tx, signature, serialized: tx.serialize().toString("base64") };
}
