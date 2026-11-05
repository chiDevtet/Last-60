/**
 * Collects REAL mainnet post-graduation evidence for test/fixtures/mainnet/destination-*.json:
 * transactions on a migrated destination pool (DAMM v2 / Raydium CPMM) classified by the
 * instruction they contain (swap, position-fee claim, creator-fee collection, locked-LP fee
 * collection), plus the pool / config / position accounts needed to decode them.
 * Read-only (getSignaturesForAddress, getTransaction, getAccountInfo); public chain data only.
 *
 * Usage: bun scripts/fetch-destination-fixtures.ts <dammv2|cpmm> <destinationPool> <outName> [extraAccounts,...] [rpcUrl]
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { RpcClient } from "../packages/engine/src/chain/rpc";
import { normalizeTransaction } from "../packages/engine/src/chain/tx";
import { instructionDiscriminator } from "../packages/engine/src/chain/anchorEvents";
import { DAMM_V2_PROGRAM_ID, RAYDIUM_CPMM_PROGRAM_ID, RAYDIUM_CP_LOCK_PROGRAM_ID } from "../packages/engine/src/providers/migration";

const [kind, pool, outName, extra, url] = process.argv.slice(2) as ["dammv2" | "cpmm", string, string, string | undefined, string | undefined];
if (!kind || !pool || !outName) throw new Error("usage: fetch-destination-fixtures.ts <dammv2|cpmm> <pool> <outName> [extraAccounts] [rpcUrl]");
const rpc = new RpcClient({ urls: [url ?? process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com"], maxRps: 2, retries: 10 });
const d = (n: string) => instructionDiscriminator(n).toString("hex");
const classes: Record<string, { program: string; discs: string[] }> =
  kind === "dammv2"
    ? { swap: { program: DAMM_V2_PROGRAM_ID, discs: [d("swap"), d("swap2")] }, claimPositionFee: { program: DAMM_V2_PROGRAM_ID, discs: [d("claim_position_fee")] } }
    : {
        swapBaseInput: { program: RAYDIUM_CPMM_PROGRAM_ID, discs: [d("swap_base_input")] },
        swapBaseOutput: { program: RAYDIUM_CPMM_PROGRAM_ID, discs: [d("swap_base_output")] },
        collectCreatorFee: { program: RAYDIUM_CPMM_PROGRAM_ID, discs: [d("collect_creator_fee"), d("collect_creator_fee_permissionless")] },
        collectCpFees: { program: RAYDIUM_CP_LOCK_PROGRAM_ID, discs: [d("collect_cp_fees")] },
      };
const found: Record<string, any> = {};
let before: string | undefined;
for (let page = 0; page < 6 && Object.keys(found).length < Object.keys(classes).length; page++) {
  const sigs = await rpc.getSignaturesForAddress(pool, { before, limit: 200 });
  for (const s of sigs) {
    if (s.err) continue;
    const raw = await rpc.getTransactionRaw(s.signature, "finalized").catch(() => null);
    if (!raw) continue;
    const tx = normalizeTransaction(raw);
    for (const [name, c] of Object.entries(classes)) {
      if (found[name]) continue;
      if (tx.instructions.some((ix) => ix.programId === c.program && c.discs.includes(ix.data.subarray(0, 8).toString("hex")) && ix.accounts.includes(pool))) {
        found[name] = raw;
        console.log("found", name, s.signature, s.slot);
      }
    }
    if (Object.keys(found).length === Object.keys(classes).length) break;
  }
  if (sigs.length < 200) break;
  before = sigs[sigs.length - 1]!.signature;
}
const addresses = [pool, ...(extra ? extra.split(",").filter(Boolean) : [])];
const { slot, value } = await rpc.getMultipleAccounts(addresses, "finalized");
const accounts = Object.fromEntries(addresses.map((a, i) => [a, value[i] ? { owner: value[i]!.owner, data: value[i]!.data.toString("base64") } : null]));
writeFileSync(join(import.meta.dir, "../packages/engine/test/fixtures/mainnet", outName), JSON.stringify({ slot, kind, pool, txs: found, accounts }));
console.log("saved", outName, Object.keys(found), "accounts slot", slot);
