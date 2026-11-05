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

/** Fetch all signatures newer than `until` (or the full history if until is null, capped). */
export async function fetchNewSignatures(rpc: ChainRpc, address: string, until: string | null, cap: number): Promise<SignatureInfo[]> {
  const out: SignatureInfo[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await rpc.getSignaturesForAddress(address, { until: until ?? undefined, before, limit: 1000, commitment: "confirmed" });
    out.push(...page);
    if (page.length < 1000 || out.length >= cap) break;
    before = page[page.length - 1]!.signature;
  }
  return out.reverse(); // oldest first
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
  o: { cursorKey?: string; untilSignature?: string | null; source: "indexer" | "catchup" | "backfill"; cap: number; concurrency: number; maxSlot?: number },
): Promise<SyncStats> {
  const cursor = o.cursorKey ? await readCursor(ctx.db, o.cursorKey) : null;
  const until = o.untilSignature !== undefined ? o.untilSignature : (cursor?.lastSignature ?? null);
  const sigs = await fetchNewSignatures(ctx.rpc, address, until, o.cap);
  const stats: SyncStats = { fetched: sigs.length, ingested: 0, newSwaps: 0, newClaims: 0, lastSlot: cursor?.lastSlot ?? 0 };
  if (!sigs.length) return stats;

  // Fetch transactions concurrently, ingest strictly in chronological order.
  const CHUNK = Math.max(o.concurrency * 4, 8);
  for (let i = 0; i < sigs.length; i += CHUNK) {
    const chunk = sigs.slice(i, i + CHUNK);
    const raws = await mapLimit(chunk, o.concurrency, async (s) => (s.err ? null : await ctx.rpc.getTransactionRaw(s.signature, "confirmed")));
    for (let j = 0; j < chunk.length; j++) {
      const s = chunk[j]!;
      if (o.maxSlot !== undefined && s.slot > o.maxSlot) continue;
      if (!s.err) {
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
