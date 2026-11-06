/**
 * Synthetic transactions that mirror Forge's EXISTING post-migration flow, instruction for instruction
 * (chiDevtet/Forgepad-Newest `new-ui` @ 5acce50, templates/fun-launch/scripts/Raypostmigration.js):
 *
 *   harvest  `raydium.cpmm.harvestLockLp({ closeWsol: true })` — LP-lock `collect_cp_fees` on the
 *            platform Fee Key, signed and paid by the Forge wallet; the launch-token leg lands in the
 *            Forge wallet's ATA, the WSOL leg in a temporary account that is closed (unwrapped).
 *   payout   `sendPayouts` — a SEPARATE legacy transaction, fee payer = Forge wallet, no memo:
 *              SystemProgram.transfer(Forge → creator, creatorLamports)
 *              [SystemProgram.transfer(Forge → rewards distributor, rewardsLamports)]   (distributor mode only)
 *              createAssociatedTokenAccountIdempotent(Forge, creatorAta, creator, mint)
 *              createTransferChecked(forgeAta, mint, creatorAta, Forge, creatorTokenRaw, decimals)
 *            with `postMigrationSplit`: no distributor → creator ⌊basis × 5000 / 10⁴⌋ and ⌊token × 5000 / 10⁴⌋.
 *
 * No Forgepad LaunchLab launch has a live harvest yet, so these are synthetic (over the real
 * LaunchLab → CPMM migration fixture), never claimed to be mainnet transactions.
 */
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import type { Models } from "../src/db/models";
import { COLLECT_CP_FEES_DISC, RAYDIUM_CPMM_PROGRAM_ID, RAYDIUM_CP_LOCK_PROGRAM_ID } from "../src/providers/migration";
import type { DestinationSpec } from "../src/providers/destination";
import { MigrationAwareProvider } from "../src/providers/MigrationAwareProvider";
import { RaydiumLaunchLabProvider } from "../src/providers/raydium/RaydiumLaunchLabProvider";
import { WSOL_MINT } from "../src/accounting/revenueStreams";
import { ATA_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID, SYSTEM_PROGRAM_ID } from "../src/revenue/decode";
import { forgeLaunchContextOf, reconcileFunding, type RevenueRuntime } from "../src/revenue/ingest";
import { SPL_TOKEN_PROGRAM_ID } from "../src/chain/tx";
import { addr, buildTx, opaque, splTransfer, splTransferChecked, systemTransfer, type Ix } from "./revenueTx";
import { baseSpec, CREATOR, FORGE, launchRef, llBonding, llPlatform, providerOf, runtime, TOKEN } from "./revenueLaunch";

export const TOKEN_DECIMALS = 6;
const half = (x: bigint) => (x * 5_000n) / 10_000n; // Forgepad postMigrationSplit `bps(amount, 5000)`

export interface Launch {
  p: MigrationAwareProvider;
  spec: DestinationSpec;
  creator: string;
  tokenMint: string;
  quoteMint: string;
}

/** The fixture launch (real LaunchLab → CPMM migration, real platform lock, real creator, WSOL quote). */
export async function fixtureLaunch(): Promise<Launch> {
  const p = await providerOf();
  const spec = await baseSpec();
  return { p, spec, creator: CREATOR, tokenMint: p.info().tokenMint, quoteMint: WSOL_MINT };
}

/**
 * Another Forge launch in the same database: its own bonding pool, token mint, CPMM pool and vaults,
 * creator (default: a new one) and quote mint (default WSOL; e.g. a USD1-like mint to exercise
 * Forge's Jupiter conversion). Same PlatformConfig, platform Fee Key wallet and lock program.
 */
export async function syntheticLaunch(o: { creator?: string; quoteMint?: string } = {}): Promise<Launch> {
  const s = await baseSpec();
  const tokenMint = addr();
  const creator = o.creator ?? addr();
  const quoteMint = o.quoteMint ?? WSOL_MINT;
  const poolAddress = addr();
  const expected = { dbcCreatorTradingFeePercentage: null, dbcCreatorLpPercentage: null, launchlabCreatorFeeRate: Number(llPlatform.creatorFeeRate), launchlabCreatorLpScale: null, launchlabPlatformConfig: llBonding.platformConfig };
  const ll = new RaydiumLaunchLabProvider(null, { poolAddress, tokenMint, role: "creator", expected });
  ll.hydrate({ ...llBonding, creator, baseMint: tokenMint, quoteMint }, llPlatform, { baseTokenProgram: TOKEN, quoteTokenProgram: TOKEN });
  const spec: DestinationSpec = { ...s, pool: addr(), ctx: { ...s.ctx, sourcePool: poolAddress, baseMint: tokenMint, quoteMint, beneficiary: creator }, cpmm: { ...s.cpmm!, token0Mint: quoteMint, token1Mint: tokenMint, token0Vault: addr(), token1Vault: addr(), poolCreator: creator } };
  const p = new MigrationAwareProvider(ll, null);
  p.attach({ ...spec, ctx: { ...spec.ctx, beneficiary: creator } });
  return { p, spec, creator, tokenMint, quoteMint };
}

export const forgeAta = (l: Launch, owner = FORGE) => getAssociatedTokenAddressSync(new PublicKey(l.tokenMint), new PublicKey(owner), true, new PublicKey(TOKEN)).toBase58();

/** Forge's harvest: `collect_cp_fees` on the platform lock, quote leg (token0) and token leg (token1). */
export function harvestTx(l: Launch, o: { slot: number; quote: bigint; token: bigint; signature?: string; lock?: string; signer?: string }) {
  const c = l.spec.cpmm!;
  const signer = o.signer ?? FORGE;
  const tmpWsol = addr(); // harvestLockLp: WSOL leg into a temporary account (closed afterwards)
  const ataToken = forgeAta(l, signer);
  const lock = o.lock ?? c.platformLocks![0]!.lockPda;
  const accts = [addr(), signer, addr(), lock, RAYDIUM_CPMM_PROGRAM_ID, addr(), l.spec.pool];
  const inner: Ix[] = [];
  if (o.quote > 0n) inner.push(splTransfer(c.token0Vault, tmpWsol, "auth", o.quote));
  if (o.token > 0n) inner.push(splTransfer(c.token1Vault, ataToken, "auth", o.token));
  const ixs: Ix[] = [opaque(COMPUTE_BUDGET_PROGRAM_ID, [], Buffer.from([2, 0, 0, 0, 0])), opaque(RAYDIUM_CP_LOCK_PROGRAM_ID, accts, Buffer.concat([COLLECT_CP_FEES_DISC, Buffer.alloc(8)]), inner)];
  return buildTx({ signature: o.signature, slot: o.slot, feePayer: signer, ixs, tokens: { [tmpWsol]: { owner: signer, mint: c.token0Mint, decimals: 9 }, [ataToken]: { owner: signer, mint: c.token1Mint, decimals: TOKEN_DECIMALS } } });
}

/**
 * Forge's payout (`sendPayouts`). Defaults reproduce the no-distributor split of a harvest exactly:
 * creator SOL = ⌊quote × 50 %⌋ (`sol`), token = ⌊token × 50 %⌋ (`token`). `distributor` adds the
 * rewards-distributor leg of the 25/50/25 mode; `from` / `to` / `mint` / `feePayer` / `extra` let
 * tests break the shape on purpose.
 */
export function payoutTx(l: Launch, o: { slot: number; sol?: bigint; token?: bigint; signature?: string; to?: string; from?: string; mint?: string; feePayer?: string; distributor?: { wallet: string; lamports: bigint }; extra?: Ix[] }) {
  const from = o.from ?? FORGE;
  const to = o.to ?? l.creator;
  const mint = o.mint ?? l.tokenMint;
  const ixs: Ix[] = [];
  const tokens: Record<string, { owner: string; mint: string; decimals?: number }> = {};
  if ((o.sol ?? 0n) > 0n) ixs.push(systemTransfer(from, to, o.sol!));
  if (o.distributor) ixs.push(systemTransfer(from, o.distributor.wallet, o.distributor.lamports));
  if ((o.token ?? 0n) > 0n) {
    const src = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(from), true, new PublicKey(TOKEN)).toBase58();
    const dst = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(to), true, new PublicKey(TOKEN)).toBase58();
    ixs.push(opaque(ATA_PROGRAM_ID, [from, dst, to, mint, SYSTEM_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID], Buffer.from([1])));
    ixs.push(splTransferChecked(src, mint, dst, from, o.token!, TOKEN_DECIMALS));
    tokens[src] = { owner: from, mint, decimals: TOKEN_DECIMALS };
    tokens[dst] = { owner: to, mint, decimals: TOKEN_DECIMALS };
  }
  ixs.push(...(o.extra ?? []));
  return buildTx({ signature: o.signature, slot: o.slot, feePayer: o.feePayer ?? from, ixs, tokens });
}

/** Forge's payout for a harvest of (quote, token) under the no-distributor split. */
export const forgeSplit = (quote: bigint, token: bigint) => ({ sol: half(quote), token: half(token) });

/** Mark the launch's attribution coverage addresses as completely indexed through `slot` (indexer cursors). */
export async function markCovered(db: Models, l: Launch, slot: number, r: RevenueRuntime = runtime()) {
  const ctx = forgeLaunchContextOf(l.p, r)!;
  for (const id of ctx.coverageKeys) await db.WorkerState.updateOne({ _id: id }, { $max: { syncedThroughSlot: slot } }, { upsert: true });
}

/** One reconciliation pass of a launch, with its Forge attribution context (as the CLI / indexer run it). */
export const reconcile = (db: Models, l: Launch, r: RevenueRuntime = runtime()) => reconcileFunding(db, { ...launchRef(l.p), forge: forgeLaunchContextOf(l.p, r) }, r);
