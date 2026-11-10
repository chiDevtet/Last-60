/**
 * Regression (mainnet, 2026-11-09): the rewards worker's own creator-fee claim creates the creator's
 * WSOL ATA, receives the fees into it and closes it (unwrap) in ONE transaction. Such an account has
 * no token-balance record, so the recipient used to decode as unknown ("recipient ? is not the pool
 * creator") and the claim was never verified or settled. The owner is now proven from the ATA address.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeTransaction, SPL_TOKEN_PROGRAM_ID, SPL_TOKEN_2022_PROGRAM_ID } from "../src/chain/tx";
import { ataOwnerOf, extractRevenue, type RevenueLaunchFacts } from "../src/revenue/decode";
import { WSOL_MINT } from "../src/accounting/revenueStreams";

const raw = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/mainnet/launchlab-claim-wsol-ata-closed.json"), "utf8"));
const CREATOR = "BrmnKerNk5uWwrnnxXafSqrwoysBtT1vu9VFewx8NM8K";
const ATA = "HJCpFpRtUrMQMBkuquTF6eBR7LRvoVxVBhn2J1NDVNZA"; // CREATOR's WSOL ATA (SPL Token)
const VAULT = "Aqd9vQ45AQn2yr2yyZ6cyEbu2XEB1grRrRkhiTVG1S8Z";
const POOL = "DZGNmqVt8Z9CJrCKTVDerBkgXdEGY2Af2pchacFZrSd5";
const OTHER = "26jDDvzHeL29NrkxksZB8vqinN2d3mGPkjohPZhTEmFH";

const facts = (o: Partial<RevenueLaunchFacts> = {}): RevenueLaunchFacts => ({ provider: "raydium_launchlab", tokenMint: "ntqp7mKG8eHhdmiZcxqoUqKQyxNQhHBmSQ3B7SYLS6o", quoteMint: WSOL_MINT, sourcePool: POOL, creator: CREATOR, role: "creator", creatorClaimVaults: [VAULT], destination: null, fundingDestinations: [], forgePlatformLpBeneficiary: null, ...o });
const parsed = (claimer: string) => ({ swaps: [], anomalies: [], attributions: [], claims: [{ pool: POOL, claimer, evidence: { instruction: 7 } }] }) as any;

describe("bonding claim into an ATA created and closed in the same transaction", () => {
  const tx = normalizeTransaction(raw);

  test("the fixture really has no token-balance record for the destination ATA", () => {
    expect([...tx.preTokenBalances, ...tx.postTokenBalances].some((b) => b.account === ATA)).toBe(false);
  });

  test("the recipient is proven from the ATA address and decimals come from TransferChecked", () => {
    const out = extractRevenue(tx, parsed(CREATOR), facts());
    expect(out).toHaveLength(1);
    expect(out[0]!.stream).toBe("bonding_curve_creator_fee");
    expect(out[0]!.destinationAccount).toBe(ATA);
    expect(out[0]!.beneficiary).toBe(CREATOR);
    expect(out[0]!.destinationOwner).toBe(CREATOR);
    expect(out[0]!.decimals).toBe(9);
    expect(out[0]!.grossAmount).toBe(22_906_750n);
  });

  test("an ATA that belongs to neither the creator nor the claimer stays unresolved", () => {
    const out = extractRevenue(tx, parsed(OTHER), facts({ creator: OTHER }));
    expect(out).toHaveLength(1);
    expect(out[0]!.beneficiary).toBeNull();
  });
});

describe("ataOwnerOf", () => {
  test("matches only an explicit candidate under the right token program", () => {
    expect(ataOwnerOf(ATA, WSOL_MINT, SPL_TOKEN_PROGRAM_ID, [OTHER, CREATOR])).toBe(CREATOR);
    expect(ataOwnerOf(ATA, WSOL_MINT, SPL_TOKEN_2022_PROGRAM_ID, [CREATOR])).toBeNull();
    expect(ataOwnerOf(ATA, WSOL_MINT, SPL_TOKEN_PROGRAM_ID, [OTHER, null, undefined, "not-a-key"])).toBeNull();
    expect(ataOwnerOf(ATA, WSOL_MINT, "11111111111111111111111111111111", [CREATOR])).toBeNull();
  });
});
