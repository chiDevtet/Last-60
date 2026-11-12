/**
 * pump.fun launch detection from a dedicated creator wallet.
 *
 * A pump.fun coin's mint address is only known once the coin is created. With a fresh creator wallet used
 * for exactly one launch, the coin can be found from the wallet itself: the indexer scans the wallet's own
 * transaction history for a pump.fun `create` / `create_v2` that the wallet SIGNED, whose `CreateEvent`
 * names the wallet as both `user` and `creator`, and whose bonding curve is the canonical PDA of the mint.
 *
 * Why signed-by-the-wallet: `create` takes the creator as an ARGUMENT, so anyone can create a coin naming
 * any wallet as its creator. Such a transaction never appears in the wallet's own signature history unless
 * the wallet signed it, so a third party cannot plant a coin here.
 *
 * Exactly one coin → `found`. More than one → `ambiguous` (the wallet is not dedicated: the mint must be
 * set by hand). A history longer than the scan cap → `too_much_history` (not a fresh wallet).
 */
import type { Idl } from "@coral-xyz/anchor";
import idlJson from "./idl/pump.json";
import { AnchorEventDecoder, instructionDiscriminator, toAddr } from "../../chain/anchorEvents";
import { normalizeTransaction, type NormalizedTx } from "../../chain/tx";
import type { ChainRpc } from "../../chain/rpc";
import { derivePumpBondingCurve, PUMP_PROGRAM_ID } from "./pda";

/** create / create_v2 discriminator → index of the `user` account (#0 mint and #2 bonding_curve in both). */
const CREATE_IX = new Map([
  [instructionDiscriminator("create").toString("hex"), 7],
  [instructionDiscriminator("create_v2").toString("hex"), 5],
]);

export interface PumpLaunch {
  mint: string;
  bondingCurve: string;
  signature: string;
  slot: number;
  blockTime: number | null;
  name: string | null;
  symbol: string | null;
}

export type PumpLaunchDetection =
  | { status: "found"; launch: PumpLaunch; scanned: number }
  | { status: "not_found"; scanned: number }
  | { status: "ambiguous"; launches: PumpLaunch[]; scanned: number }
  | { status: "too_much_history"; scanned: number };

/** The pump.fun coins `creator` itself created in this transaction (pure; verified as described above). */
export function pumpLaunchesIn(tx: NormalizedTx, creator: string, decoder = defaultDecoder()): PumpLaunch[] {
  if (tx.err || !tx.signers.has(creator)) return [];
  const out: PumpLaunch[] = [];
  for (const ev of decoder.decodeAll(tx)) {
    if (ev.name !== "CreateEvent") continue;
    const d: any = ev.data;
    const p = ev.parent;
    const userIndex = p && p.programId === PUMP_PROGRAM_ID ? CREATE_IX.get(p.data.subarray(0, 8).toString("hex")) : undefined;
    if (!p || userIndex === undefined) continue;
    const mint = toAddr(d.mint);
    if (toAddr(d.creator) !== creator || toAddr(d.user) !== creator) continue;
    if (p.accounts[0] !== mint || p.accounts[userIndex] !== creator) continue;
    let curve: string;
    try {
      curve = derivePumpBondingCurve(mint);
    } catch {
      continue;
    }
    if (toAddr(d.bonding_curve) !== curve || p.accounts[2] !== curve) continue;
    out.push({ mint, bondingCurve: curve, signature: tx.signature, slot: tx.slot, blockTime: tx.blockTime, name: typeof d.name === "string" ? d.name : null, symbol: typeof d.symbol === "string" ? d.symbol : null });
  }
  return out;
}

let shared: AnchorEventDecoder | null = null;
function defaultDecoder() {
  return (shared ??= new AnchorEventDecoder(PUMP_PROGRAM_ID, idlJson as unknown as Idl));
}

/**
 * Incremental scanner for one creator wallet (kept by the indexer between polls): the first scan reads the
 * wallet's history (up to `maxSignatures`), later scans only the signatures newer than the last one seen.
 */
export class PumpLaunchDetector {
  private newest: string | null = null;
  private scanned = 0;
  private readonly launches = new Map<string, PumpLaunch>();
  private tooMuch = false;

  constructor(
    private readonly rpc: Pick<ChainRpc, "getSignaturesForAddress" | "getTransactionRaw">,
    readonly creator: string,
    private readonly o: { maxSignatures?: number; pageSize?: number; extract?: (tx: NormalizedTx, creator: string) => PumpLaunch[] } = {},
  ) {}

  async scan(): Promise<PumpLaunchDetection> {
    if (this.tooMuch) return { status: "too_much_history", scanned: this.scanned };
    const max = this.o.maxSignatures ?? 2_000;
    const page = this.o.pageSize ?? 1_000;
    const fresh: { signature: string; err: unknown }[] = [];
    let before: string | undefined;
    for (;;) {
      const sigs = await this.rpc.getSignaturesForAddress(this.creator, { limit: page, before, until: this.newest ?? undefined });
      fresh.push(...sigs.map((s) => ({ signature: s.signature, err: s.err })));
      if (this.scanned + fresh.length > max) {
        this.tooMuch = true;
        return { status: "too_much_history", scanned: this.scanned + fresh.length };
      }
      if (sigs.length < page) break;
      before = sigs[sigs.length - 1]!.signature;
    }
    // Oldest first, so `newest` only advances past signatures that were fully read.
    for (const s of fresh.reverse()) {
      if (!s.err) {
        const raw = await this.rpc.getTransactionRaw(s.signature, "confirmed");
        if (!raw) break; // not served yet: retried from here on the next scan
        for (const l of (this.o.extract ?? pumpLaunchesIn)(normalizeTransaction(raw), this.creator)) if (!this.launches.has(l.mint)) this.launches.set(l.mint, l);
      }
      this.newest = s.signature;
      this.scanned++;
    }
    const all = [...this.launches.values()].sort((a, b) => a.slot - b.slot);
    if (all.length === 1) return { status: "found", launch: all[0]!, scanned: this.scanned };
    if (all.length > 1) return { status: "ambiguous", launches: all, scanned: this.scanned };
    return { status: "not_found", scanned: this.scanned };
  }
}
