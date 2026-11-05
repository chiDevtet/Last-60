/**
 * Anchor `emit_cpi!` events: the program invokes itself with
 *   data = EVENT_IX_TAG (8) ‖ sha256("event:<Name>")[0..8] ‖ borsh(event)
 * We decode them with the program's official IDL and link each event to the instruction that
 * emitted it (the parent frame), because the parent's accounts carry the trader and pool.
 */
import { BorshCoder, type Idl } from "@coral-xyz/anchor";
import { sha256 } from "@noble/hashes/sha2.js";
import type { FlatInstruction, NormalizedTx } from "./tx";

export const EVENT_IX_TAG = Buffer.from("e445a52e51cb9a1d", "hex");

export function eventDiscriminator(name: string): Buffer {
  return Buffer.from(sha256(new TextEncoder().encode(`event:${name}`))).subarray(0, 8);
}

export function instructionDiscriminator(snakeName: string): Buffer {
  return Buffer.from(sha256(new TextEncoder().encode(`global:${snakeName}`))).subarray(0, 8);
}

export interface DecodedEvent<T = Record<string, unknown>> {
  name: string;
  data: T;
  /** Ordinal of the event CPI inside the transaction (stable event index). */
  ordinal: number;
  instruction: FlatInstruction;
  /** The program instruction that emitted the event, if it could be resolved. */
  parent: FlatInstruction | null;
}

export class AnchorEventDecoder {
  private readonly coder: BorshCoder;
  private readonly known: Map<string, string>;

  constructor(
    readonly programId: string,
    idl: Idl,
  ) {
    this.coder = new BorshCoder(idl);
    this.known = new Map((idl.events ?? []).map((e) => [Buffer.from(e.discriminator).toString("hex"), e.name]));
  }

  isEventIx(ix: FlatInstruction): boolean {
    return ix.programId === this.programId && ix.data.length >= 16 && ix.data.subarray(0, 8).equals(EVENT_IX_TAG);
  }

  decodeAll(tx: NormalizedTx): DecodedEvent[] {
    const out: DecodedEvent[] = [];
    const ixs = tx.instructions;
    for (let i = 0; i < ixs.length; i++) {
      const ix = ixs[i]!;
      if (!this.isEventIx(ix)) continue;
      const disc = ix.data.subarray(8, 16).toString("hex");
      const name = this.known.get(disc);
      if (!name) {
        out.push({ name: `unknown:${disc}`, data: {}, ordinal: ix.ordinal, instruction: ix, parent: this.findParent(ixs, i) });
        continue;
      }
      const ev = this.coder.events.decode(ix.data.subarray(8).toString("base64"));
      if (!ev) continue;
      out.push({ name: ev.name, data: ev.data as Record<string, unknown>, ordinal: ix.ordinal, instruction: ix, parent: this.findParent(ixs, i) });
    }
    return out;
  }

  /**
   * The emitting instruction is the closest preceding non-event instruction of the same program
   * one frame up the stack (stackHeight − 1), within the same top-level instruction.
   */
  private findParent(ixs: FlatInstruction[], eventPos: number): FlatInstruction | null {
    const ev = ixs[eventPos]!;
    for (let j = eventPos - 1; j >= 0; j--) {
      const c = ixs[j]!;
      if (c.topIndex !== ev.topIndex) break;
      if (c.programId !== this.programId || this.isEventIx(c)) continue;
      if (!ev.stackHeightKnown || !c.stackHeightKnown || c.stackHeight === ev.stackHeight - 1) return c;
    }
    return null;
  }
}

/** Anchor-decoded integers come back as BN; normalise to bigint. */
export function toBig(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (v && typeof (v as any).toString === "function") return BigInt((v as any).toString());
  throw new Error(`cannot convert ${String(v)} to bigint`);
}

export function toAddr(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof (v as any).toBase58 === "function") return (v as any).toBase58();
  throw new Error("expected public key");
}

/** Anchor decodes unit enums as `{ variantName: {} }`. */
export function enumVariant(v: unknown): string {
  if (v && typeof v === "object") {
    const k = Object.keys(v as object)[0];
    if (k) return k.toLowerCase();
  }
  return String(v).toLowerCase();
}
