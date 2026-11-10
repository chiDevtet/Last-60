/**
 * Meteora DBC pool addresses from the token mint.
 *
 * A DBC pool is the PDA ["pool", config, max(base, quote), min(base, quote)] of the DBC program
 * (keys compared as bytes), so — unlike a Raydium LaunchLab pool — it depends on the pool's config,
 * which is chosen at launch. With the config known it is derived (`deriveDbcPool`); without it the
 * pool is found on chain by its base mint (`discoverDbcPool`): VirtualPool accounts store `base_mint`
 * at byte 136 (8 discriminator + 64 volatility tracker + config + creator). Both verified against
 * mainnet pools.
 */
import { PublicKey } from "@solana/web3.js";
import { WSOL_MINT } from "@last60/shared";
import type { AccountInfoRaw } from "../../chain/rpc";

export const DBC_PROGRAM = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
/** Anchor discriminator of `VirtualPool` (transfer-hook pools use another account type and are not supported). */
export const DBC_VIRTUAL_POOL_DISC = Buffer.from([213, 224, 5, 209, 98, 69, 119, 92]);
export const DBC_VIRTUAL_POOL_SIZE = 424;
export const DBC_POOL_BASE_MINT_OFFSET = 136;
export const DBC_POOL_CONFIG_OFFSET = 72;

/** The DBC pool of `tokenMint` under `config`, quoted in `quoteMint` (default SOL). Throws on an invalid key. */
export function deriveDbcPool(config: string, tokenMint: string, quoteMint: string = WSOL_MINT): string {
  const base = new PublicKey(tokenMint).toBuffer();
  const quote = new PublicKey(quoteMint).toBuffer();
  const [hi, lo] = Buffer.compare(base, quote) > 0 ? [base, quote] : [quote, base];
  return PublicKey.findProgramAddressSync([Buffer.from("pool"), new PublicKey(config).toBuffer(), hi, lo], new PublicKey(DBC_PROGRAM))[0].toBase58();
}

type ProgramAccountsRpc = { getProgramAccounts(programId: string, o: { filters: unknown[]; dataSlice?: { offset: number; length: number } }): Promise<{ pubkey: string; account: AccountInfoRaw }[]> };

export type DbcDiscovery = { status: "found"; pool: string; config: string } | { status: "not_found" } | { status: "ambiguous"; pools: string[] } | { status: "unsupported"; reason: string };

/**
 * Find the DBC pool whose base mint is `tokenMint`. Each candidate is re-checked: owned by DBC, a
 * VirtualPool, base mint equal to the token, and its address re-derived from its own config — so a
 * result is the program's canonical pool for that mint, never a look-alike account.
 */
export async function discoverDbcPool(rpc: Partial<ProgramAccountsRpc>, tokenMint: string, quoteMint: string = WSOL_MINT): Promise<DbcDiscovery> {
  if (!rpc.getProgramAccounts) return { status: "unsupported", reason: "this RPC client cannot search program accounts" };
  const mint = new PublicKey(tokenMint);
  const rows = await rpc.getProgramAccounts(DBC_PROGRAM, { filters: [{ dataSize: DBC_VIRTUAL_POOL_SIZE }, { memcmp: { offset: DBC_POOL_BASE_MINT_OFFSET, bytes: mint.toBase58() } }] });
  const pools: { pool: string; config: string }[] = [];
  for (const r of rows) {
    const d = Buffer.from(r.account.data);
    if (r.account.owner !== DBC_PROGRAM || !d.subarray(0, 8).equals(DBC_VIRTUAL_POOL_DISC)) continue;
    if (!d.subarray(DBC_POOL_BASE_MINT_OFFSET, DBC_POOL_BASE_MINT_OFFSET + 32).equals(mint.toBuffer())) continue;
    const config = new PublicKey(d.subarray(DBC_POOL_CONFIG_OFFSET, DBC_POOL_CONFIG_OFFSET + 32)).toBase58();
    if (deriveDbcPool(config, tokenMint, quoteMint) !== r.pubkey) continue;
    pools.push({ pool: r.pubkey, config });
  }
  if (pools.length === 1) return { status: "found", ...pools[0]! };
  if (pools.length > 1) return { status: "ambiguous", pools: pools.map((p) => p.pool) };
  return { status: "not_found" };
}
