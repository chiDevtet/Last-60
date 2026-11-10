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

export const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SPL_TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/**
 * Instructions executed *directly* by `parent` (one frame down the stack, inside the same top-level
 * instruction). Requires stack heights (every RPC that returns innerInstructions since v1.14); if a
 * height is unknown the instruction is attributed conservatively to no parent.
 */
export function childInstructions(tx: NormalizedTx, parent: FlatInstruction): FlatInstruction[] {
  const out: FlatInstruction[] = [];
  for (const ix of tx.instructions) {
    if (ix.ordinal <= parent.ordinal || ix.topIndex !== parent.topIndex) continue;
    if (!ix.stackHeightKnown || !parent.stackHeightKnown) break;
    if (ix.stackHeight <= parent.stackHeight) break; // the parent frame has returned
    if (ix.stackHeight === parent.stackHeight + 1) out.push(ix);
  }
  return out;
}

export interface TokenTransfer {
  ordinal: number;
  program: string;
  source: string;
  destination: string;
  authority: string;
  amount: bigint;
  mint: string | null;
  /** TransferChecked carries the mint's decimals; null for a plain Transfer. */
  decimals?: number | null;
}

/** Decode an SPL Token / Token-2022 `Transfer` (3) or `TransferChecked` (12) instruction, else null. */
export function decodeTokenTransfer(ix: FlatInstruction): TokenTransfer | null {
  if (ix.programId !== SPL_TOKEN_PROGRAM_ID && ix.programId !== SPL_TOKEN_2022_PROGRAM_ID) return null;
  const tag = ix.data[0];
  if (tag === 3 && ix.data.length >= 9 && ix.accounts.length >= 3) {
    return { ordinal: ix.ordinal, program: ix.programId, source: ix.accounts[0]!, destination: ix.accounts[1]!, authority: ix.accounts[2]!, amount: ix.data.readBigUInt64LE(1), mint: null };
  }
  if (tag === 12 && ix.data.length >= 10 && ix.accounts.length >= 4) {
    return { ordinal: ix.ordinal, program: ix.programId, source: ix.accounts[0]!, destination: ix.accounts[2]!, authority: ix.accounts[3]!, amount: ix.data.readBigUInt64LE(1), mint: ix.accounts[1]!, decimals: ix.data[9]! };
  }
  return null;
}

/**
 * Token transfers performed by `parent` itself or by any program it invoked (its whole CPI subtree).
 * This is the instruction-specific view used instead of whole-transaction balance deltas, so that a
 * claim and a trade in the same transaction are never conflated.
 */
export function subtreeTransfers(tx: NormalizedTx, parent: FlatInstruction): TokenTransfer[] {
  const out: TokenTransfer[] = [];
  for (const ix of tx.instructions) {
    if (ix.ordinal <= parent.ordinal || ix.topIndex !== parent.topIndex) continue;
    if (!ix.stackHeightKnown || !parent.stackHeightKnown) break;
    if (ix.stackHeight <= parent.stackHeight) break;
    const t = decodeTokenTransfer(ix);
    if (t) out.push(t);
  }
  return out;
}

/** Owner and mint of a token account as reported in the transaction's token balance metadata. */
export function tokenAccountInfo(tx: NormalizedTx, account: string): { owner: string | null; mint: string } | null {
  const b = tx.postTokenBalances.find((x) => x.account === account) ?? tx.preTokenBalances.find((x) => x.account === account);
  return b ? { owner: b.owner, mint: b.mint } : null;
}

/**
 * Anchor `emit!` (log-based) events: "Program data: <base64>" lines emitted while `programId` is the
 * innermost executing program. Returned in log order. `truncated` is true when the runtime cut the
 * log, in which case callers must not treat a missing event as absence.
 */
export function programDataLogs(tx: NormalizedTx, programId: string): { data: Buffer[]; truncated: boolean } {
  const stack: string[] = [];
  const data: Buffer[] = [];
  let truncated = false;
  for (const line of tx.logMessages) {
    if (line === "Log truncated") truncated = true;
    const inv = /^Program (\S+) invoke \[\d+\]$/.exec(line);
    if (inv) {
      stack.push(inv[1]!);
      continue;
    }
    if (/^Program (\S+) (success|failed)/.test(line)) {
      stack.pop();
      continue;
    }
    if (line.startsWith("Program data: ") && stack[stack.length - 1] === programId) data.push(Buffer.from(line.slice(14), "base64"));
  }
  return { data, truncated };
}
