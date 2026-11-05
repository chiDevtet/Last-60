/**
 * Gap-free signature synchronisation for one address.
 *
 * `getSignaturesForAddress(until = cursor)` returns everything newer than the cursor, newest
 * first, paginated. We process oldest → newest and only advance the cursor past a signature
 * after it (and everything older) was ingested — so a crash, RPC failure or restart can cause
 * re-processing (harmless, idempotent) but never a skipped transaction.
 */
import type { ChainRpc, SignatureInfo } from "../chain/rpc";
import type { Models } from "../db/models";
import { ingestRawTransaction, type IngestContext } from "./ingest";

export interface Cursor {
  lastSignature: string | null;
  lastSlot: number;
  backfillComplete: boolean;
  updatedAt?: Date;
}

export function cursorId(provider: string, pool: string, address: string) {
  return `cursor:${provider}:${pool}:${address}`;
}

export async function readCursor(db: Models, id: string): Promise<Cursor | null> {
  const doc: any = await db.WorkerState.findById(id).lean();
  return doc?.cursor ?? null;
}

async function writeCursor(db: Models, id: string, c: Cursor) {
  await db.WorkerState.updateOne({ _id: id }, { $set: { cursor: { ...c, updatedAt: new Date() }, heartbeatAt: new Date() } }, { upsert: true });
}

export interface FetchBounds {
  /** Stop once signatures are at or below this slot (exclusive lower bound). */
  afterSlot?: number | null;
  /** Stop once signatures are older than this unix time (seconds). */
  sinceTime?: number | null;
}

/**
 * Fetch signatures newer than `until`, newest-first paging, returned oldest-first.
 *
 * Completeness rule: when the read is anchored (`until` and/or `bounds`), the `cap` limits how
 * many signatures are RETURNED, never which ones are skipped: paging continues back to the anchor
 * and only the OLDEST `cap` signatures are kept (a sliding window), so a caller that advances a
 * cursor over the result can never jump over a gap; `truncated` tells it more remain. Only an
 * unanchored history backfill (no `until`, no `bounds`) stops at the newest `cap` signatures.
 */
export async function fetchSignaturesSince(
  rpc: ChainRpc,
  address: string,
  until: string | null,
  cap: number,
  bounds: FetchBounds = {},
  opts: { minContextSlot?: number } = {},
): Promise<{ sigs: SignatureInfo[]; truncated: boolean }> {
  const anchored = until !== null || bounds.afterSlot != null || bounds.sinceTime != null;
  let out: SignatureInfo[] = []; // newest → oldest
  let truncated = false;
  let before: string | undefined;
  const inBounds = (s: SignatureInfo) => (bounds.afterSlot == null || s.slot > bounds.afterSlot) && (bounds.sinceTime == null || s.blockTime == null || s.blockTime >= bounds.sinceTime);
  for (;;) {
    const page = await rpc.getSignaturesForAddress(address, { until: until ?? undefined, before, limit: 1000, commitment: "confirmed", ...(opts.minContextSlot !== undefined ? { minContextSlot: opts.minContextSlot } : {}) });
    const kept = page.filter(inBounds);
    out.push(...kept);
    if (out.length > cap) {
      truncated = true;
      if (!anchored) {
        out = out.slice(0, cap); // backfill: the newest `cap`
        break;
      }
      out = out.slice(out.length - cap); // anchored: keep the oldest `cap` (closest to the anchor)
    }
    if (page.length < 1000 || kept.length < page.length) break;
    before = page[page.length - 1]!.signature;
  }
  return { sigs: out.reverse(), truncated }; // oldest first
}

/** Back-compatible wrapper returning only the signatures (oldest first). */
export async function fetchNewSignatures(rpc: ChainRpc, address: string, until: string | null, cap: number, bounds: FetchBounds = {}): Promise<SignatureInfo[]> {
  return (await fetchSignaturesSince(rpc, address, until, cap, bounds)).sigs;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!);
      }
    }),
  );
  return results;
}

export interface SyncStats {
  fetched: number;
  ingested: number;
  newSwaps: number;
  newClaims: number;
  lastSlot: number;
}

/**
 * Sync one address. When `cursorKey` is given the cursor is read and advanced; without it the
 * call is read-only with respect to cursors (used by the rewards worker's pre-snapshot catch-up).
 */
export async function syncAddress(
  ctx: IngestContext & { rpc: ChainRpc },
  address: string,
  o: { cursorKey?: string; untilSignature?: string | null; source: "indexer" | "catchup" | "backfill"; cap: number; concurrency: number; maxSlot?: number; bounds?: FetchBounds; maxPerPass?: number; signal?: AbortSignal; minContextSlot?: number },
): Promise<SyncStats & { more: boolean; truncated: boolean }> {
  const cursor = o.cursorKey ? await readCursor(ctx.db, o.cursorKey) : null;
  const until = o.untilSignature !== undefined ? o.untilSignature : (cursor?.lastSignature ?? null);
  const { sigs: all, truncated } = await fetchSignaturesSince(ctx.rpc, address, until, o.cap, o.bounds, { minContextSlot: o.minContextSlot });
  // Bounded pass (oldest first); the cursor makes the next pass continue exactly here. An
  // anchored truncated fetch also means "more": the newest signatures were not returned yet.
  const anchored = until !== null || o.bounds?.afterSlot != null || o.bounds?.sinceTime != null;
  const sigs = o.maxPerPass ? all.slice(0, o.maxPerPass) : all;
  const stats: SyncStats & { more: boolean; truncated: boolean } = { fetched: all.length, ingested: 0, newSwaps: 0, newClaims: 0, lastSlot: cursor?.lastSlot ?? 0, more: sigs.length < all.length || (truncated && anchored), truncated };
  if (!sigs.length) return stats;

  // Fetch transactions concurrently, ingest strictly in chronological order. Signatures that are
  // already stored (e.g. ingested by the websocket fast path) are not downloaded again.
  const CHUNK = Math.max(o.concurrency * 4, 8);
  for (let i = 0; i < sigs.length; i += CHUNK) {
    if (o.signal?.aborted) {
      stats.more = true;
      break;
    }
    const chunk = sigs.slice(i, i + CHUNK);
    const names = chunk.map((s) => s.signature);
    const [swapSigs, claimSigs] = await Promise.all([ctx.db.Swap.distinct("signature", { signature: { $in: names } }), ctx.db.FeeClaim.distinct("signature", { signature: { $in: names }, status: "confirmed" })]);
    const known = new Set<string>([...swapSigs, ...claimSigs]);
    const raws = await mapLimit(chunk, o.concurrency, async (s) => (s.err || known.has(s.signature) ? null : await ctx.rpc.getTransactionRaw(s.signature, "confirmed")));
    for (let j = 0; j < chunk.length; j++) {
      const s = chunk[j]!;
      if (o.maxSlot !== undefined && s.slot > o.maxSlot) continue;
      if (!s.err && !known.has(s.signature)) {
        const raw = raws[j];
        if (!raw) throw new Error(`transaction ${s.signature} not yet available from RPC`); // retried next poll; cursor not advanced
        const commitment = s.confirmationStatus === "finalized" ? "finalized" : "confirmed";
        const r = await ingestRawTransaction(ctx, raw, { source: o.source, commitment });
        stats.newSwaps += r.newSwaps;
        stats.newClaims += r.newClaims;
        stats.ingested++;
      }
      stats.lastSlot = Math.max(stats.lastSlot, s.slot);
      if (o.cursorKey) await writeCursor(ctx.db, o.cursorKey, { lastSignature: s.signature, lastSlot: s.slot, backfillComplete: true });
    }
  }
  return stats;
}

/** Ingest a single signature (websocket fast path). */
export async function ingestSignature(ctx: IngestContext & { rpc: ChainRpc }, signature: string, source: "indexer" | "catchup") {
  const raw = await ctx.rpc.getTransactionRaw(signature, "confirmed");
  if (!raw) return null;
  return ingestRawTransaction(ctx, raw, { source, commitment: "confirmed" });
}
