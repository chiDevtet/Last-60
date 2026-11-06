/**
 * Shared launch for phase-aware revenue tests: the REAL LaunchLab → CPMM graduation fixture (verified
 * migration, real platform lock, real creator), with synthetic Forge / creator claim and distribution
 * transactions (no Forgepad LaunchLab launch has a live Forge LP claim yet).
 */
import { Keypair } from "@solana/web3.js";
import { normalizeTransaction } from "../src/chain/tx";
import { instructionDiscriminator } from "../src/chain/anchorEvents";
import type { Models } from "../src/db/models";
import { RaydiumLaunchLabProvider, decodeLaunchLabPlatformConfig, decodeLaunchLabPool, LAUNCHLAB_PROGRAM_ID } from "../src/providers/raydium/RaydiumLaunchLabProvider";
import { COLLECT_CP_FEES_DISC, RAYDIUM_CPMM_PROGRAM_ID, RAYDIUM_CP_LOCK_PROGRAM_ID, parseMigration, verifyMigration } from "../src/providers/migration";
import { destinationSpec, type DestinationSpec } from "../src/providers/destination";
import { MigrationAwareProvider } from "../src/providers/MigrationAwareProvider";
import { APPROVED_SHARES, makeFundingPolicy, WSOL_MINT } from "../src/accounting/revenueStreams";
import { ingestRevenue, type RevenueRuntime } from "../src/revenue/ingest";
import { fixtureRpc, loadFixture } from "./fixtureRpc";
import { addr, buildTx, opaque, splTransfer } from "./revenueTx";

export const llFx = loadFixture("migration-launchlab-cpmm.json");
const cFx = loadFixture("destination-cpmm.json");
export const lM = parseMigration(normalizeTransaction(llFx.tx), "raydium_launchlab", llFx.bondingPool)!;
const llBonding = decodeLaunchLabPool(Buffer.from(llFx.accounts[llFx.bondingPool].data, "base64"));
const llPlatform = decodeLaunchLabPlatformConfig(Buffer.from(llFx.accounts[llBonding.platformConfig].data, "base64"));
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const CREATOR = llBonding.creator;
/** The PlatformConfig platform NFT wallet: owner of Forge's platform Fee Key. */
export const FORGE = llPlatform.platformLockNftWallet!;
export const DEST = Keypair.generate().publicKey.toBase58();
export const ACT = lM.slot + 10;
export const PLATFORM_LOCK = lM.locks![0]!.lockPda;

let spec: DestinationSpec;
export async function baseSpec(): Promise<DestinationSpec> {
  if (spec) return spec;
  const v = await verifyMigration(fixtureRpc({ ...llFx, accounts: { ...cFx.accounts, ...llFx.accounts } }), lM, { base: lM.baseMint, quote: lM.quoteMint, bondingCreator: CREATOR, platform: { cpConfig: llPlatform.cpConfig, platformCpCreator: null } });
  spec = destinationSpec(launch().info, v, launch().ll.lpCheck, { platformNftWallet: FORGE, creatorScale: "0", platformScale: "1000000" })!;
  return spec;
}
function launch(o: { verified?: boolean } = {}) {
  const expected = { dbcCreatorTradingFeePercentage: null, dbcCreatorLpPercentage: null, launchlabCreatorFeeRate: o.verified === false ? null : Number(llPlatform.creatorFeeRate), launchlabCreatorLpScale: null, launchlabPlatformConfig: o.verified === false ? null : llBonding.platformConfig };
  const ll = new RaydiumLaunchLabProvider(null, { poolAddress: llFx.bondingPool, tokenMint: lM.baseMint, role: "creator", expected });
  const info = ll.hydrate(llBonding, llPlatform, { baseTokenProgram: TOKEN, quoteTokenProgram: TOKEN });
  return { ll, info };
}
export async function providerOf(o: { verified?: boolean } = {}): Promise<MigrationAwareProvider> {
  const s = await baseSpec();
  const p = new MigrationAwareProvider(launch(o).ll, null);
  p.attach({ ...s, ctx: { ...s.ctx, beneficiary: CREATOR } });
  return p;
}
export const policyV2 = (activationSlot = ACT) => makeFundingPolicy({ version: "forge_phase_aware_v2", activationSlot, ...APPROVED_SHARES });
export const runtime = (o: Partial<RevenueRuntime> = {}): RevenueRuntime => ({ cluster: "mainnet-beta", policy: policyV2(), fundingDestinations: [DEST], forgePlatformLpBeneficiary: FORGE, correlationMode: "strict", ...o });

const CLAIM_CREATOR = instructionDiscriminator("claim_creator_fee");
/** LP-lock collect_cp_fees on a lock: token0 (WSOL) and optional token1 legs paid to `payTo`'s token accounts. */
export function lpClaimIx(o: { lock?: string; signer?: string; payTo?: string; amount0?: bigint; amount1?: bigint } = {}) {
  const c = spec.cpmm!;
  const signer = o.signer ?? FORGE;
  const payTo = o.payTo ?? signer;
  const ata0 = addr();
  const ata1 = addr();
  const accts = [addr(), signer, addr(), o.lock ?? PLATFORM_LOCK, RAYDIUM_CPMM_PROGRAM_ID, addr(), spec.pool];
  const amount1 = o.amount1 ?? 0n;
  const inner = [splTransfer(c.token0Vault, ata0, "auth", o.amount0 ?? 1_000_000n), ...(amount1 > 0n ? [splTransfer(c.token1Vault, ata1, "auth", amount1)] : [])];
  return { ix: opaque(RAYDIUM_CP_LOCK_PROGRAM_ID, accts, Buffer.concat([COLLECT_CP_FEES_DISC, Buffer.alloc(8)]), inner), tokens: { [ata0]: { owner: payTo, mint: c.token0Mint }, [ata1]: { owner: payTo, mint: c.token1Mint, decimals: 6 } }, token1Mint: c.token1Mint };
}
/** LaunchLab claim_creator_fee out of the creator fee vault, paid to `recipientOwner`'s WSOL account. */
export function bondingClaimIx(provider: MigrationAwareProvider, amount: bigint, recipientOwner = CREATOR) {
  const vault = provider.info().accounts.creatorFeeVault!;
  const ata = addr();
  return { ix: opaque(LAUNCHLAB_PROGRAM_ID, [recipientOwner, addr(), vault, ata], Buffer.from(CLAIM_CREATOR), [splTransfer(vault, ata, "auth", amount)]), tokens: { [ata]: { owner: recipientOwner, mint: WSOL_MINT } } };
}
export async function ingest(db: Models, provider: MigrationAwareProvider, tx: ReturnType<typeof buildTx>, r = runtime()) {
  return ingestRevenue(db, tx, provider.parseTransaction(tx), provider, r, { commitment: "confirmed" });
}
export const launchRef = (p: MigrationAwareProvider) => ({ sourcePool: p.info().poolAddress, quoteMint: p.info().quoteMint, provider: p.info().provider, tokenMint: p.info().tokenMint });
