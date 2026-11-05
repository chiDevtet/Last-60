/** Offline helpers for tests built on real mainnet fixtures. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";

const FIX = join(import.meta.dir, "fixtures/mainnet");
export const loadFixture = (name: string) => JSON.parse(readFileSync(join(FIX, name), "utf8"));

/** Read-only RPC stub serving a fixture's account snapshot (optionally tampered). */
export function fixtureRpc(fx: any, patch: (addr: string, acc: { owner: string; data: Buffer } | null) => { owner: string; data: Buffer } | null = (_a, x) => x): any {
  const acc = (a: string) => {
    const raw = fx.accounts[a] ? { owner: fx.accounts[a].owner, data: Buffer.from(fx.accounts[a].data, "base64") } : null;
    const p = patch(a, raw);
    return p ? { ...p, lamports: 0, executable: false } : null;
  };
  return {
    getAccountInfo: async (a: string) => ({ slot: fx.slot, value: acc(a) }),
    getMultipleAccounts: async (as: string[]) => ({ slot: fx.slot, value: as.map(acc) }),
    getTokenLargestAccounts: async (mint: string) => ({
      slot: fx.slot,
      value: Object.keys(fx.accounts)
        .map((a) => [a, acc(a)] as const)
        .filter(([, v]) => v && v.data.length >= 72 && new PublicKey(v.data.subarray(0, 32)).toBase58() === mint)
        .map(([a, v]) => ({ address: a, amount: v!.data.readBigUInt64LE(64) })),
    }),
  };
}

