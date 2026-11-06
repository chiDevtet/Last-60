/**
 * Signature-cursor identity and indexing coverage (no I/O beyond the WorkerState row). Kept apart from
 * signatureSync.ts so the revenue module can read coverage without importing the ingestion pipeline.
 */
import type { Models } from "../db/models";

export function cursorId(provider: string, pool: string, address: string) {
  return `cursor:${provider}:${pool}:${address}`;
}

/**
 * Highest slot through which EVERY transaction of the cursor's address is ingested, or null when
 * unknown. A cursor that has processed a signature at slot s has processed everything older (gap-free,
 * oldest-first), i.e. covers s − 1; a complete pass anchored at slot S (`syncedThroughSlot`) covers S.
 */
export async function coveredThroughSlot(db: Models, id: string): Promise<number | null> {
  const doc: any = await db.WorkerState.findById(id, { cursor: 1, syncedThroughSlot: 1 }).lean();
  if (!doc) return null;
  const fromCursor = doc.cursor && typeof doc.cursor.lastSlot === "number" && doc.cursor.lastSignature ? doc.cursor.lastSlot - 1 : null;
  const synced = typeof doc.syncedThroughSlot === "number" ? doc.syncedThroughSlot : null;
  if (fromCursor === null) return synced;
  return synced === null ? fromCursor : Math.max(fromCursor, synced);
}

/** Record that a complete pass anchored at `slot` ingested everything of the address up to it (monotonic). */
export async function recordSyncedThrough(db: Models, id: string, slot: number): Promise<void> {
  await db.WorkerState.updateOne({ _id: id }, { $max: { syncedThroughSlot: slot } }, { upsert: true });
}
