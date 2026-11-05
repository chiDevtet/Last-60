import type { Models } from "../db/models";
import { randomToken } from "./crypto";

/**
 * Leader lease with a fencing token. Acquisition is a single atomic upsert: it succeeds only if
 * the lease is free, expired, or already ours. Each acquisition gets a fresh token, so a stale
 * leader's conditional writes (which include the token) fail after takeover.
 */
export class Lease {
  private token: string | null = null;
  constructor(
    private readonly db: Models,
    readonly name: string,
    readonly owner: string,
    readonly ttlMs = 20_000,
  ) {}

  get fencingToken(): string | null {
    return this.token;
  }

  async tryAcquire(now = Date.now()): Promise<boolean> {
    const expiresAt = new Date(now + this.ttlMs);
    const nextToken = this.token ?? randomToken(12);
    try {
      const res = await this.db.WorkerLease.findOneAndUpdate(
        { _id: this.name, $or: [{ owner: this.owner }, { expiresAt: { $lt: new Date(now) } }] },
        { $set: { owner: this.owner, token: nextToken, expiresAt }, $setOnInsert: { acquiredAt: new Date(now) } },
        { upsert: true, returnDocument: "after" },
      ).lean();
      this.token = (res as any)?.token ?? null;
      return (res as any)?.owner === this.owner;
    } catch (err: any) {
      if (err?.code === 11000) {
        this.token = null; // someone else holds a live lease (upsert raced on _id)
        return false;
      }
      throw err;
    }
  }

  async release(): Promise<void> {
    await this.db.WorkerLease.deleteOne({ _id: this.name, owner: this.owner });
    this.token = null;
  }

  async isHeldBy(owner: string, now = Date.now()): Promise<boolean> {
    const l: any = await this.db.WorkerLease.findById(this.name).lean();
    return !!l && l.owner === owner && l.expiresAt > new Date(now);
  }
}

export async function heartbeat(db: Models, component: string, patch: { status?: string; detail?: string | null; instance?: string; metrics?: Record<string, unknown>; cursor?: unknown } = {}) {
  const $set: Record<string, unknown> = { heartbeatAt: new Date() };
  if (patch.status) $set.status = patch.status;
  if (patch.detail !== undefined) $set.detail = patch.detail;
  if (patch.instance) $set.instance = patch.instance;
  if (patch.cursor !== undefined) $set.cursor = patch.cursor;
  if (patch.metrics) for (const [k, v] of Object.entries(patch.metrics)) $set[`metrics.${k}`] = v;
  await db.WorkerState.updateOne({ _id: component }, { $set }, { upsert: true });
}
