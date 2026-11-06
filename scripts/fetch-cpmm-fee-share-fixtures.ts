/**
 * Collects REAL mainnet evidence for the Raydium CPMM per-creator creator-fee share override
 * (`CreatorFeeShare`, raydium-cp-swap states/creator_fee_share.rs) into
 * test/fixtures/mainnet/cpmm-creator-fee-share.json:
 *   - every CreatorFeeShare account (getProgramAccounts, dataSize 145 + discriminator), with the PDA
 *     derivation ["creator_fee_share", creator, amm_config] checked for each;
 *   - the raw account of the override on Forgepad's AmmConfig (C7Cx2p…), if any;
 *   - absent-PDA cases: the pool creator of the CPMM fixture pool (2ZJpQEny…) and Forgepad's platform
 *     wallet on Forgepad's AmmConfig (getAccountInfo → null ⇒ the AmmConfig default applies).
 * Read-only (getProgramAccounts, getAccountInfo); public chain data only. No keys, no transactions.
 *
 * Usage: bun scripts/fetch-cpmm-fee-share-fixtures.ts [rpcUrl]
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CREATOR_FEE_SHARE_DISC, CREATOR_FEE_SHARE_SIZE, RAYDIUM_CPMM_PROGRAM_ID, decodeCreatorFeeShare, deriveCreatorFeeSharePda } from "../packages/engine/src/providers/migration";

const url = process.argv[2] ?? process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
async function call(method: string, params: unknown[]) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j: any = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

const FORGEPAD_AMM_CONFIG = "C7Cx2pMLtjybS3mDKSfsBj4zQ3PRZGkKt7RCYTTbCSx2";
const FORGEPAD_PLATFORM_WALLET = "8KXqQwtrgtKxNfTWYsN34XNKXVQQR78JZfgbLorNL2n1";
const FIXTURE_POOL_CREATOR = "CopzCpy4NMZ3cZbpFdNJTFFCkuZjJ61V4QfAiZ5PB864"; // pool_creator of 2ZJpQEny… (destination-cpmm.json)
const FIXTURE_AMM_CONFIG = "FMmwToGqT9iwDgsqvzLg65vcKSzKme4szbWqX1kyCBCJ";

const gpa = await call("getProgramAccounts", [RAYDIUM_CPMM_PROGRAM_ID, { encoding: "base64", commitment: "finalized", withContext: true, filters: [{ dataSize: CREATOR_FEE_SHARE_SIZE }, { memcmp: { offset: 0, bytes: CREATOR_FEE_SHARE_DISC.toString("base64"), encoding: "base64" } }] }]);
const overrides = gpa.value.map((x: any) => {
  const data = Buffer.from(x.account.data[0], "base64");
  const d = decodeCreatorFeeShare(data)!;
  return { address: x.pubkey, owner: x.account.owner, creator: d.creator, ammConfig: d.ammConfig, shareRate: d.shareRate.toString(), bump: d.bump, pdaVerified: deriveCreatorFeeSharePda(d.creator, d.ammConfig) === x.pubkey, data: x.account.data[0] };
});
const absent = async (creator: string, cfg: string) => {
  const pda = deriveCreatorFeeSharePda(creator, cfg);
  const r = await call("getAccountInfo", [pda, { encoding: "base64", commitment: "finalized" }]);
  return { poolCreator: creator, ammConfig: cfg, pda, slot: r.context.slot, account: r.value };
};
const out = {
  source: `Solana mainnet-beta, ${new URL(url).host}, getProgramAccounts / getAccountInfo (base64, finalized); read-only`,
  programSource: "raydium-io/raydium-cp-swap@3d69122 programs/cp-swap/src/states/creator_fee_share.rs (resolve_creator_fee_share_rate, split_creator_fee_shared_amount)",
  program: RAYDIUM_CPMM_PROGRAM_ID,
  slot: gpa.context.slot,
  overrides,
  forgepadAmmConfigOverride: overrides.find((o: any) => o.ammConfig === FORGEPAD_AMM_CONFIG) ?? null,
  absentCases: [await absent(FIXTURE_POOL_CREATOR, FIXTURE_AMM_CONFIG), await absent(FORGEPAD_PLATFORM_WALLET, FORGEPAD_AMM_CONFIG)],
};
const file = join(import.meta.dir, "../packages/engine/test/fixtures/mainnet/cpmm-creator-fee-share.json");
writeFileSync(file, JSON.stringify(out, null, 1));
console.log(`wrote ${file}: ${overrides.length} CreatorFeeShare accounts at slot ${out.slot}; all PDAs verified: ${overrides.every((o: any) => o.pdaVerified)}`);
