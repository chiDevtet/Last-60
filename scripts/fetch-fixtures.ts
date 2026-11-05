/**
 * Collects categorised REAL mainnet transactions and account snapshots for provider tests.
 * Usage: bun scripts/fetch-fixtures.ts [rpcUrl]
 * Output: packages/engine/test/fixtures/mainnet/*.json (public chain data only).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RpcClient } from "../packages/engine/src/chain/rpc";
import { normalizeTransaction } from "../packages/engine/src/chain/tx";
import { AnchorEventDecoder, instructionDiscriminator, toAddr, toBig, enumVariant } from "../packages/engine/src/chain/anchorEvents";
import { DBC_PROGRAM_ID } from "../packages/engine/src/providers/meteora/MeteoraDBCProvider";
import { LAUNCHLAB_PROGRAM_ID } from "../packages/engine/src/providers/raydium/RaydiumLaunchLabProvider";
import dbcIdl from "../packages/engine/src/providers/meteora/idl/dynamic_bonding_curve.json";
import llIdl from "../packages/engine/src/providers/raydium/idl/raydium_launchpad.json";

const OUT = join(import.meta.dir, "../packages/engine/test/fixtures/mainnet");
mkdirSync(OUT, { recursive: true });
const rpc = new RpcClient({ urls: [process.argv[2] ?? process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com"], maxRps: 4, retries: 8 });
const WSOL = "So11111111111111111111111111111111111111112";

function save(name: string, data: unknown) {
  writeFileSync(join(OUT, name), JSON.stringify(data, null, 0));
  console.log("saved", name);
}

async function collect(programId: string, idl: any, wanted: Record<string, (ctx: any) => boolean>, budget: number) {
  const dec = new AnchorEventDecoder(programId, idl);
  const found: Record<string, any> = {};
  let before: string | undefined;
  let fetched = 0;
  while (fetched < budget && Object.keys(found).length < Object.keys(wanted).length) {
    const sigs = await rpc.getSignaturesForAddress(programId, { limit: 100, before });
    if (!sigs.length) break;
    before = sigs[sigs.length - 1]!.signature;
    for (const s of sigs) {
      if (s.err || fetched >= budget) continue;
      fetched++;
      const raw = await rpc.getTransactionRaw(s.signature);
      if (!raw) continue;
      const tx = normalizeTransaction(raw);
      const events = dec.decodeAll(tx);
      for (const [name, pred] of Object.entries(wanted)) {
        if (found[name]) continue;
        if (pred({ raw, tx, events })) {
          found[name] = raw;
          save(`${name}.json`, raw);
        }
      }
      if (Object.keys(found).length === Object.keys(wanted).length) break;
    }
  }
  console.log(programId.slice(0, 6), "fetched", fetched, "found", Object.keys(found));
  return found;
}


// ── Meteora DBC ─────────────────────────────────────────────────────────────────
const SWAP_IX = new Set(["swap", "swap2"].map((n) => instructionDiscriminator(n).toString("hex")));
const dbcSwap3 = (events: any[], dir: number, cpi: boolean | null) =>
  events.find((e) => e.name === "EvtSwap3" && Number(e.data.trade_direction) === dir && e.parent && SWAP_IX.has(e.parent.data.subarray(0, 8).toString("hex")) && (cpi === null || (e.instruction.stackHeight > 2) === cpi));
const dbc = await collect(
  DBC_PROGRAM_ID,
  dbcIdl,
  {
    "dbc-buy-direct": ({ events }) => !!dbcSwap3(events, 1, false),
    "dbc-buy-cpi": ({ events }) => !!dbcSwap3(events, 1, true),
    "dbc-sell": ({ events }) => !!dbcSwap3(events, 0, null),
    "dbc-v1": ({ raw, events }) => raw.version === 1 && events.some((e: any) => e.name === "EvtSwap3"),
    "dbc-claim-creator": ({ events }) => events.some((e: any) => e.name === "EvtClaimCreatorTradingFee" && toBig(e.data.token_quote_amount) > 0n),
  },
  Number(process.env.DBC_BUDGET ?? 160),
);

// Pool + config + mints for the direct-buy pool, for adapter load() tests.
{
  const tx = normalizeTransaction(dbc["dbc-buy-direct"]);
  const dec = new AnchorEventDecoder(DBC_PROGRAM_ID, dbcIdl as any);
  const ev = dec.decodeAll(tx).find((e) => e.name === "EvtSwap3")!;
  const pool = toAddr(ev.data.pool);
  const config = toAddr(ev.data.config);
  const accts = await rpc.getMultipleAccounts([pool, config]);
  const poolData = accts.value[0]!;
  const baseMint = tx.instructions.find((i) => i.ordinal === ev.parent!.ordinal)!.accounts[7]!;
  const quoteMint = tx.instructions.find((i) => i.ordinal === ev.parent!.ordinal)!.accounts[8]!;
  const mints = await rpc.getMultipleAccounts([baseMint, quoteMint]);
  save("dbc-accounts.json", {
    slot: accts.slot,
    pool,
    config,
    baseMint,
    quoteMint,
    accounts: {
      [pool]: { owner: poolData.owner, data: poolData.data.toString("base64") },
      [config]: { owner: accts.value[1]!.owner, data: accts.value[1]!.data.toString("base64") },
      [baseMint]: { owner: mints.value[0]!.owner, data: mints.value[0]!.data.toString("base64") },
      [quoteMint]: { owner: mints.value[1]!.owner, data: mints.value[1]!.data.toString("base64") },
    },
  });
}

// ── Raydium LaunchLab ───────────────────────────────────────────────────────────
const ll = await collect(
  LAUNCHLAB_PROGRAM_ID,
  llIdl,
  {
    "launchlab-buy-creatorfee": ({ events }) => events.some((e: any) => e.name === "TradeEvent" && enumVariant(e.data.trade_direction) === "buy" && toBig(e.data.creator_fee) > 0n),
    "launchlab-sell": ({ events }) => events.some((e: any) => e.name === "TradeEvent" && enumVariant(e.data.trade_direction) === "sell"),
    "launchlab-claim-creator": ({ tx }) => tx.instructions.some((i: any) => i.programId === LAUNCHLAB_PROGRAM_ID && i.data.subarray(0, 8).equals(instructionDiscriminator("claim_creator_fee"))),
  },
  Number(process.env.LL_BUDGET ?? 140),
);
{
  const tx = normalizeTransaction(ll["launchlab-buy-creatorfee"]);
  const dec = new AnchorEventDecoder(LAUNCHLAB_PROGRAM_ID, llIdl as any);
  const ev = dec.decodeAll(tx).find((e) => e.name === "TradeEvent")!;
  const pool = toAddr(ev.data.pool_state);
  const parent = ev.parent!;
  const platformConfig = parent.accounts[3]!;
  const baseMint = parent.accounts[9]!;
  const quoteMint = parent.accounts[10]!;
  const accts = await rpc.getMultipleAccounts([pool, platformConfig, baseMint, quoteMint]);
  save("launchlab-accounts.json", {
    slot: accts.slot,
    pool,
    platformConfig,
    baseMint,
    quoteMint,
    wsolQuote: quoteMint === WSOL,
    accounts: Object.fromEntries([pool, platformConfig, baseMint, quoteMint].map((a, i) => [a, { owner: accts.value[i]!.owner, data: accts.value[i]!.data.toString("base64") }])),
  });
}
console.log("done");
