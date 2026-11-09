/**
 * Deterministic in-memory Solana stand-in for tests. Implements ChainRpc with realistic semantics
 * that matter for payout safety:
 *   - signatures are deduplicated (re-broadcasting identical bytes never double-executes)
 *   - blockhashes expire after `blockhashValidity` blocks; expired transactions are rejected
 *   - statuses progress processed → confirmed → finalized as slots advance
 *   - fault injection: drop (accepted but never lands), fail (lands with error), rpc errors
 * Payout transactions are real web3.js transactions; their signatures are verified.
 */
import bs58 from "bs58";
import { randomBytes } from "node:crypto";
import { PublicKey, SystemInstruction, SystemProgram, Transaction } from "@solana/web3.js";
import { RpcError, type AccountInfoRaw, type ChainRpc, type SignatureInfo, type SignatureStatus } from "../chain/rpc";
import { MOCK_PROGRAM_ID, encodeMockTrade } from "../providers/mock/MockProvider";

interface LandedTx {
  signature: string;
  slot: number;
  blockTime: number;
  err: unknown | null;
  raw: any;
  addresses: string[];
}

type SendFault = "drop" | "fail" | "rpc_error" | "timeout_after_accept";

export class FakeChain implements ChainRpc {
  slot = 1_000;
  finalityLag = 32;
  blockhashValidity = 150;
  now: () => number = () => Date.now();
  balances = new Map<string, bigint>();
  accounts = new Map<string, AccountInfoRaw>();
  tokenBalances = new Map<string, bigint>();
  private txs = new Map<string, LandedTx>();
  private byAddress = new Map<string, string[]>(); // oldest → newest
  private bySlot = new Map<number, string[]>();
  private blockhashes = new Map<string, number>(); // blockhash → lastValidBlockHeight
  private pendingDrops = new Set<string>();
  sendFaults: SendFault[] = [];
  rpcFailures = 0; // next N calls of any method throw a transient error
  /** Simulates a lagging RPC backend: status answers come from a node this many slots behind. */
  statusContextLag = 0;
  sent: { signature: string; at: number }[] = [];
  transfers: { signature: string; from: string; to: string; lamports: bigint; slot: number }[] = [];

  // ── control ─────────────────────────────────────────────────────────────────
  advance(slots = 1) {
    this.slot += slots;
  }
  get finalizedSlot() {
    return this.slot - this.finalityLag;
  }
  setBalance(addr: string, lamports: bigint) {
    this.balances.set(addr, lamports);
  }
  private maybeFail(method: string) {
    if (this.rpcFailures > 0) {
      this.rpcFailures--;
      throw new RpcError(`injected transient failure in ${method}`, -32005, 200, undefined, true);
    }
  }

  /** Add a synthetic trade for the MockProvider at the current slot. Returns its signature. */
  addMockTrade(o: { trader: string; pool: string; kind: "buy" | "sell" | "claim"; quote: bigint; base?: bigint; totalFee?: bigint; eligibleFee?: bigint; failed?: boolean; slot?: number; blockTime?: number }): string {
    const signature = bs58.encode(randomBytes(64));
    const slot = o.slot ?? this.slot;
    const data = encodeMockTrade(o.kind, o.quote, o.base ?? 0n, o.totalFee ?? 0n, o.eligibleFee ?? 0n);
    const raw = {
      slot,
      blockTime: o.blockTime ?? Math.floor(this.now() / 1000),
      version: 0,
      meta: { err: o.failed ? { InstructionError: [0, "Custom"] } : null, fee: 5000, innerInstructions: [], loadedAddresses: { writable: [], readonly: [] }, logMessages: [], preTokenBalances: [], postTokenBalances: [], preBalances: [0, 0, 0], postBalances: [0, 0, 0] },
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: [o.trader, o.pool, MOCK_PROGRAM_ID],
          header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
          instructions: [{ programIdIndex: 2, accounts: [0, 1], data: bs58.encode(data) }],
          recentBlockhash: bs58.encode(randomBytes(32)),
        },
      },
    };
    this.land({ signature, slot, blockTime: raw.blockTime, err: raw.meta.err, raw, addresses: [o.trader, o.pool, MOCK_PROGRAM_ID] });
    return signature;
  }

  /** Remove a landed transaction (simulates a fork dropping it). */
  forkOut(signature: string) {
    const t = this.txs.get(signature);
    if (!t) return;
    this.txs.delete(signature);
    for (const a of t.addresses) this.byAddress.set(a, (this.byAddress.get(a) ?? []).filter((s) => s !== signature));
    this.bySlot.set(t.slot, (this.bySlot.get(t.slot) ?? []).filter((s) => s !== signature));
  }

  private land(t: LandedTx) {
    this.txs.set(t.signature, t);
    for (const a of new Set(t.addresses)) {
      const list = this.byAddress.get(a) ?? [];
      list.push(t.signature);
      list.sort((x, y) => this.txs.get(x)!.slot - this.txs.get(y)!.slot);
      this.byAddress.set(a, list);
    }
    const s = this.bySlot.get(t.slot) ?? [];
    s.push(t.signature);
    this.bySlot.set(t.slot, s);
  }

  // ── ChainRpc ────────────────────────────────────────────────────────────────
  async getSlot(commitment: "processed" | "confirmed" | "finalized" = "confirmed") {
    this.maybeFail("getSlot");
    return commitment === "finalized" ? this.finalizedSlot : this.slot;
  }
  async getBlockHeight(commitment: "processed" | "confirmed" | "finalized" = "finalized") {
    this.maybeFail("getBlockHeight");
    return commitment === "finalized" ? this.finalizedSlot : this.slot;
  }
  async getSignaturesForAddress(address: string, o: { before?: string; until?: string; limit?: number; minContextSlot?: number } = {}): Promise<SignatureInfo[]> {
    this.maybeFail("getSignaturesForAddress");
    if (o.minContextSlot !== undefined && o.minContextSlot > this.slot) throw new RpcError("Minimum context slot has not been reached", -32016, 200, undefined, true);
    const list = [...(this.byAddress.get(address) ?? [])].reverse(); // newest first
    let start = 0;
    if (o.before) {
      const i = list.indexOf(o.before);
      start = i < 0 ? list.length : i + 1;
    }
    const out: SignatureInfo[] = [];
    for (let i = start; i < list.length && out.length < (o.limit ?? 1000); i++) {
      const sig = list[i]!;
      if (o.until && sig === o.until) break;
      const t = this.txs.get(sig)!;
      out.push({ signature: sig, slot: t.slot, err: t.err, blockTime: t.blockTime, confirmationStatus: t.slot <= this.finalizedSlot ? "finalized" : "confirmed" });
    }
    return out;
  }
  async getTransactionRaw(signature: string) {
    this.maybeFail("getTransaction");
    const t = this.txs.get(signature);
    return t ? structuredClone(t.raw) : null;
  }
  async getAccountInfo(address: string) {
    this.maybeFail("getAccountInfo");
    return { slot: this.slot, value: this.accounts.get(address) ?? null };
  }
  async getMultipleAccounts(addresses: string[]) {
    return { slot: this.slot, value: addresses.map((a) => this.accounts.get(a) ?? null) };
  }
  async getBalance(address: string) {
    this.maybeFail("getBalance");
    return this.balances.get(address) ?? 0n;
  }
  async getTokenLargestAccounts(mint: string) {
    const value: { address: string; amount: bigint }[] = [];
    for (const [address, acc] of this.accounts) {
      if (acc.data.length >= 72 && new PublicKey(acc.data.subarray(0, 32)).toBase58() === mint) value.push({ address, amount: acc.data.readBigUInt64LE(64) });
    }
    return { slot: this.slot, value: value.sort((a, b) => (b.amount > a.amount ? 1 : -1)) };
  }
  async getTokenAccountBalance(address: string) {
    const v = this.tokenBalances.get(address);
    return v === undefined ? null : { slot: this.slot, amount: v };
  }
  async getLatestBlockhash() {
    this.maybeFail("getLatestBlockhash");
    const blockhash = bs58.encode(randomBytes(32));
    const lastValidBlockHeight = this.slot + this.blockhashValidity;
    this.blockhashes.set(blockhash, lastValidBlockHeight);
    return { blockhash, lastValidBlockHeight, slot: this.slot };
  }
  async getMinimumBalanceForRentExemption(size: number) {
    return 890_880 + size * 6960;
  }
  async getBlockSignatures(slot: number) {
    return this.bySlot.get(slot) ?? null;
  }

  async sendRawTransaction(serializedBase64: string): Promise<string> {
    this.maybeFail("sendTransaction");
    const tx = Transaction.from(Buffer.from(serializedBase64, "base64"));
    if (!tx.verifySignatures()) throw new RpcError("signature verification failed", -32003, 200);
    const signature = bs58.encode(tx.signature!);
    this.sent.push({ signature, at: this.slot });
    if (this.txs.has(signature) || this.pendingDrops.has(signature)) return signature; // dedupe
    const lvh = this.blockhashes.get(tx.recentBlockhash!);
    if (lvh === undefined || lvh < this.slot) throw new RpcError("Transaction simulation failed: Blockhash not found", -32002, 200);
    const fault = this.sendFaults.shift();
    if (fault === "rpc_error") throw new RpcError("injected send failure", -32005, 200, undefined, true);
    if (fault === "drop") {
      this.pendingDrops.add(signature);
      return signature;
    }
    let err: unknown = fault === "fail" ? { InstructionError: [0, "Custom"] } : null;
    const transfers: { from: string; to: string; lamports: bigint }[] = [];
    for (const ix of tx.instructions) {
      if (!ix.programId.equals(SystemProgram.programId)) continue;
      if (SystemInstruction.decodeInstructionType(ix) !== "Transfer") continue;
      const d = SystemInstruction.decodeTransfer(ix);
      transfers.push({ from: d.fromPubkey.toBase58(), to: d.toPubkey.toBase58(), lamports: d.lamports });
    }
    const feePayer = tx.feePayer!.toBase58();
    const fee = 5000n;
    const need = transfers.reduce((a, t) => a + t.lamports, 0n) + fee;
    if (!err && (this.balances.get(feePayer) ?? 0n) < need) err = { InsufficientFundsForRent: { account_index: 0 } };
    this.balances.set(feePayer, (this.balances.get(feePayer) ?? 0n) - fee);
    if (!err) {
      for (const t of transfers) {
        this.balances.set(t.from, (this.balances.get(t.from) ?? 0n) - t.lamports);
        this.balances.set(t.to, (this.balances.get(t.to) ?? 0n) + t.lamports);
        this.transfers.push({ signature, ...t, slot: this.slot });
      }
    }
    const msg = tx.compileMessage();
    const addresses = msg.accountKeys.map((k: PublicKey) => k.toBase58());
    const blockTime = Math.floor(this.now() / 1000);
    // getTransaction(json) shape, so landed transactions can be fetched and verified like real ones.
    const raw = {
      slot: this.slot,
      blockTime,
      meta: { err, fee: Number(fee), innerInstructions: [], loadedAddresses: { writable: [], readonly: [] }, logMessages: [], preTokenBalances: [], postTokenBalances: [], preBalances: addresses.map(() => 0), postBalances: addresses.map(() => 0) },
      transaction: { signatures: [signature], message: { accountKeys: addresses, header: msg.header, instructions: msg.instructions.map((ix) => ({ programIdIndex: ix.programIdIndex, accounts: ix.accounts, data: ix.data })), recentBlockhash: msg.recentBlockhash } },
    };
    this.land({ signature, slot: this.slot, blockTime, err, raw, addresses });
    if (fault === "timeout_after_accept") throw new RpcError("injected timeout after accept", null, null, undefined, true);
    return signature;
  }

  async getSignatureStatuses(signatures: string[]): Promise<(SignatureStatus | null)[]> {
    this.maybeFail("getSignatureStatuses");
    return signatures.map((s) => {
      const t = this.txs.get(s);
      if (!t) return null;
      const finalized = t.slot <= this.finalizedSlot;
      return { slot: t.slot, confirmations: finalized ? null : this.slot - t.slot, err: t.err, confirmationStatus: finalized ? "finalized" : "confirmed" };
    });
  }

  async getSignatureStatusesWithContext(signatures: string[]): Promise<{ contextSlot: number; value: (SignatureStatus | null)[] }> {
    if (this.statusContextLag > 0) {
      // A lagging node has not processed recent slots: transactions above its context are unknown.
      const ctx = this.slot - this.statusContextLag;
      const v = await this.getSignatureStatuses(signatures);
      return { contextSlot: ctx, value: v.map((x) => (x && x.slot > ctx ? null : x)) };
    }
    return { contextSlot: this.slot, value: await this.getSignatureStatuses(signatures) };
  }

  async getEpochInfo(commitment: "processed" | "confirmed" | "finalized" = "finalized") {
    this.maybeFail("getEpochInfo");
    const s = commitment === "finalized" ? this.finalizedSlot : this.slot;
    return { absoluteSlot: s, blockHeight: s }; // FakeChain: one block per slot
  }

  transfersTo(address: string) {
    return this.transfers.filter((t) => t.to === address);
  }
}
