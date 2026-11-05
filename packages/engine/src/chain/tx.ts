/**
 * Version-agnostic normalisation of `getTransaction(..., {encoding: "json"})` results.
 * Works for legacy, v0 (address lookup tables) and v1 transactions: account keys are
 * static keys + loaded writable + loaded readonly, in that order (Solana runtime ordering).
 */
import bs58 from "bs58";

export interface TokenBalance {
  accountIndex: number;
  account: string;
  mint: string;
  owner: string | null;
  programId: string | null;
  amount: bigint;
  decimals: number;
}

export interface FlatInstruction {
  ordinal: number; // position in execution order across the whole tx
  topIndex: number; // index of the top-level instruction this belongs to
  innerIndex: number | null; // null for top-level
  stackHeight: number; // 1 = top-level
  stackHeightKnown: boolean;
  programId: string;
  accounts: string[];
  data: Buffer;
}

export interface NormalizedTx {
  signature: string;
  slot: number;
  blockTime: number | null;
  version: number | "legacy";
  err: unknown | null;
  fee: bigint;
  feePayer: string;
  signers: Set<string>;
  accountKeys: string[];
  instructions: FlatInstruction[];
  preTokenBalances: TokenBalance[];
  postTokenBalances: TokenBalance[];
  preBalances: bigint[];
  postBalances: bigint[];
  logMessages: string[];
}

export function normalizeTransaction(raw: any): NormalizedTx {
  if (!raw?.transaction?.message || !raw.meta) throw new Error("normalizeTransaction: unexpected transaction shape");
  const msg = raw.transaction.message;
  const meta = raw.meta;
  const accountKeys: string[] = [
    ...(msg.accountKeys as string[]),
    ...((meta.loadedAddresses?.writable as string[]) ?? []),
    ...((meta.loadedAddresses?.readonly as string[]) ?? []),
  ];
  const numSigners: number = msg.header?.numRequiredSignatures ?? 1;
  const signers = new Set(accountKeys.slice(0, numSigners));
  const key = (i: number) => {
    const k = accountKeys[i];
    if (k === undefined) throw new Error(`account index ${i} out of range (${accountKeys.length} keys)`);
    return k;
  };

  const innerByTop = new Map<number, any[]>();
  for (const group of meta.innerInstructions ?? []) innerByTop.set(group.index, group.instructions ?? []);

  const instructions: FlatInstruction[] = [];
  let ordinal = 0;
  (msg.instructions as any[]).forEach((ix, topIndex) => {
    instructions.push({
      ordinal: ordinal++,
      topIndex,
      innerIndex: null,
      stackHeight: 1,
      stackHeightKnown: true,
      programId: key(ix.programIdIndex),
      accounts: (ix.accounts as number[]).map(key),
      data: Buffer.from(bs58.decode(ix.data ?? "")),
    });
    (innerByTop.get(topIndex) ?? []).forEach((inner, innerIndex) => {
      const known = typeof inner.stackHeight === "number";
      instructions.push({
        ordinal: ordinal++,
        topIndex,
        innerIndex,
        stackHeight: known ? inner.stackHeight : 2,
        stackHeightKnown: known,
        programId: key(inner.programIdIndex),
        accounts: (inner.accounts as number[]).map(key),
        data: Buffer.from(bs58.decode(inner.data ?? "")),
      });
    });
  });

  const tb = (arr: any[] | undefined): TokenBalance[] =>
    (arr ?? []).map((b) => ({
      accountIndex: b.accountIndex,
      account: key(b.accountIndex),
      mint: b.mint,
      owner: b.owner ?? null,
      programId: b.programId ?? null,
      amount: BigInt(b.uiTokenAmount?.amount ?? "0"),
      decimals: b.uiTokenAmount?.decimals ?? 0,
    }));

  return {
    signature: raw.transaction.signatures[0],
    slot: raw.slot,
    blockTime: raw.blockTime ?? null,
    version: raw.version ?? "legacy",
    err: meta.err ?? null,
    fee: BigInt(meta.fee ?? 0),
    feePayer: accountKeys[0]!,
    signers,
    accountKeys,
    instructions,
    preTokenBalances: tb(meta.preTokenBalances),
    postTokenBalances: tb(meta.postTokenBalances),
    preBalances: (meta.preBalances ?? []).map((n: number) => BigInt(n)),
    postBalances: (meta.postBalances ?? []).map((n: number) => BigInt(n)),
    logMessages: meta.logMessages ?? [],
  };
}

/** Net token balance change per (owner, mint) across the transaction. */
export function tokenDeltasByOwner(tx: NormalizedTx, mint: string): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const add = (owner: string | null, v: bigint) => {
    if (!owner) return;
    out.set(owner, (out.get(owner) ?? 0n) + v);
  };
  for (const b of tx.postTokenBalances) if (b.mint === mint) add(b.owner, b.amount);
  for (const b of tx.preTokenBalances) if (b.mint === mint) add(b.owner, -b.amount);
  return out;
}

/** Net change of a specific token account across the transaction. */
export function tokenAccountDelta(tx: NormalizedTx, account: string): bigint {
  const post = tx.postTokenBalances.find((b) => b.account === account)?.amount ?? 0n;
  const pre = tx.preTokenBalances.find((b) => b.account === account)?.amount ?? 0n;
  return post - pre;
}
