/**
 * Holder draw: besides the most recent qualifying buyers, every paying round also rewards
 * HOLDER_COUNT wallets drawn at random from the token's holders.
 *
 * Eligible: a wallet (an on-curve address — never a pool vault or other program account) whose
 * token accounts of the launch mint together hold at least MIN_HOLDER_TOKENS whole tokens
 * (default 100,000 = 0.01 % of a 1,000,000,000 supply), that is not one of the round's paid buyers
 * and not an excluded wallet (creator, fee beneficiary, payout wallet, EXCLUDED_WALLETS).
 *
 * The draw is random but reproducible: a 32-byte seed from the OS CSPRNG is generated once per
 * round and stored with it. Every eligible wallet is ranked by SHA-256(seed ":" wallet) and the
 * lowest HOLDER_COUNT hashes win, so the same seed and holder set always give the same winners
 * (a resumed execution reuses the stored draw; it is never drawn twice).
 */
import { createHash, randomBytes } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { ChainRpc } from "../chain/rpc";

/** SPL token account layout: mint (0..32), owner (32..64), amount u64 LE (64..72). */
const TOKEN_ACCOUNT_SIZE = 165;

export interface HolderBalance {
  wallet: string;
  balance: bigint;
}

export interface HolderDraw {
  seed: string;
  /** Wallets that met every eligibility rule at the draw. */
  eligibleCount: number;
  recipients: HolderBalance[];
}

/** Whole tokens → base units of the mint. */
export function holderMinBalance(minTokens: bigint, decimals: number): bigint {
  return minTokens * 10n ** BigInt(decimals);
}

export function newHolderSeed(): string {
  return randomBytes(32).toString("hex");
}

/** Balance of the mint per owner wallet (all of an owner's token accounts summed), from chain state. */
export async function fetchHolderBalances(rpc: ChainRpc, mint: string, tokenProgram: string): Promise<Map<string, bigint>> {
  const filters: unknown[] = [{ memcmp: { offset: 0, bytes: mint } }];
  // Token accounts of the original program have a fixed size; Token-2022 accounts carry extensions.
  if (tokenProgram === TOKEN_PROGRAM_ID.toBase58()) filters.unshift({ dataSize: TOKEN_ACCOUNT_SIZE });
  const rows = await rpc.getProgramAccounts(tokenProgram, { filters, dataSlice: { offset: 32, length: 40 }, commitment: "confirmed" });
  const balances = new Map<string, bigint>();
  for (const r of rows) {
    const d = r.account.data;
    if (d.length < 40) continue;
    const amount = d.readBigUInt64LE(32);
    if (amount === 0n) continue;
    const owner = new PublicKey(d.subarray(0, 32)).toBase58();
    balances.set(owner, (balances.get(owner) ?? 0n) + amount);
  }
  return balances;
}

function isWallet(address: string): boolean {
  try {
    return PublicKey.isOnCurve(new PublicKey(address).toBytes());
  } catch {
    return false;
  }
}

/** Pure draw: deterministic for a given seed and holder set. */
export function drawHolders(o: { balances: Map<string, bigint>; minBalance: bigint; count: number; excluded: Set<string>; seed: string }): HolderDraw {
  const eligible: (HolderBalance & { h: string })[] = [];
  for (const [wallet, balance] of o.balances) {
    if (balance < o.minBalance || o.excluded.has(wallet) || !isWallet(wallet)) continue;
    eligible.push({ wallet, balance, h: createHash("sha256").update(`${o.seed}:${wallet}`).digest("hex") });
  }
  eligible.sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
  return { seed: o.seed, eligibleCount: eligible.length, recipients: eligible.slice(0, Math.max(0, o.count)).map(({ wallet, balance }) => ({ wallet, balance })) };
}
