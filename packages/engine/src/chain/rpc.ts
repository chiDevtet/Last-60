/**
 * Minimal Solana JSON-RPC client with endpoint failover, token-bucket rate limiting, timeouts and
 * classified retries. We read transactions with our own client (rather than web3.js) so we can
 * request `maxSupportedTransactionVersion: 1` and keep raw JSON for audit fixtures.
 */
import { backoffDelay } from "../util/backoff";
import { sleep } from "../util/time";
import { rootLogger, type Logger } from "../util/logger";

export type Commitment = "processed" | "confirmed" | "finalized";

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly httpStatus: number | null,
    readonly data?: unknown,
    readonly transient = false,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** JSON-RPC error codes that indicate a temporary node condition. */
const TRANSIENT_CODES = new Set([-32004, -32005, -32007, -32009, -32014, -32016, -32603]);

export interface RpcClientOptions {
  urls: string[];
  timeoutMs?: number;
  maxRps?: number;
  maxTxVersion?: number;
  retries?: number;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

export interface SignatureInfo {
  signature: string;
  slot: number;
  err: unknown | null;
  blockTime: number | null;
  confirmationStatus?: Commitment | null;
}

export interface SignatureStatus {
  slot: number;
  confirmations: number | null;
  err: unknown | null;
  confirmationStatus: Commitment | null;
}

export interface AccountInfoRaw {
  data: Buffer;
  owner: string;
  lamports: number;
  executable: boolean;
}

export class RpcClient {
  private urls: string[];
  private active = 0;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly log: Logger;
  private readonly fetchImpl: typeof fetch;
  private tokens: number;
  private lastRefill = Date.now();
  private readonly maxRps: number;
  maxTxVersion: number;
  private idSeq = 1;

  constructor(opts: RpcClientOptions) {
    if (!opts.urls.length) throw new Error("RpcClient requires at least one URL");
    this.urls = [...opts.urls];
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.retries = opts.retries ?? 5;
    this.maxRps = opts.maxRps ?? 20;
    this.tokens = this.maxRps;
    this.maxTxVersion = opts.maxTxVersion ?? 1;
    this.log = (opts.logger ?? rootLogger()).child({ component: "rpc" });
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  setUrls(urls: string[]) {
    if (urls.length) {
      this.urls = [...urls];
      this.active = 0;
    }
  }

  get endpoint(): string {
    return this.urls[this.active]!;
  }

  private async takeToken() {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.maxRps, this.tokens + ((now - this.lastRefill) / 1000) * this.maxRps);
      this.lastRefill = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(Math.ceil(((1 - this.tokens) / this.maxRps) * 1000));
    }
  }

  private rotate() {
    if (this.urls.length > 1) this.active = (this.active + 1) % this.urls.length;
  }

  async call<T>(method: string, params: unknown[] = [], opts: { retries?: number } = {}): Promise<T> {
    const retries = opts.retries ?? this.retries;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      await this.takeToken();
      const url = this.endpoint;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: this.idSeq++, method, params }),
          signal: ctrl.signal,
        });
        if (res.status === 429 || res.status >= 500) {
          throw new RpcError(`HTTP ${res.status} from RPC`, null, res.status, undefined, true);
        }
        if (!res.ok) throw new RpcError(`HTTP ${res.status} from RPC`, null, res.status, await res.text().catch(() => ""), false);
        const body: any = await res.json();
        if (body.error) {
          const code = typeof body.error.code === "number" ? body.error.code : null;
          throw new RpcError(String(body.error.message ?? "RPC error"), code, res.status, body.error.data, code !== null && TRANSIENT_CODES.has(code));
        }
        return body.result as T;
      } catch (err: any) {
        lastErr = err;
        const transient = err instanceof RpcError ? err.transient : true; // network errors / aborts are transient
        if (!transient || attempt === retries) break;
        this.rotate();
        const delay = backoffDelay(attempt, { baseMs: 300, maxMs: 8000 });
        this.log.debug({ method, attempt, delay, err: String(err?.message ?? err) }, "RPC call failed, retrying");
        await sleep(delay);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  // ── typed helpers ──────────────────────────────────────────────────────────────

  getSlot(commitment: Commitment = "confirmed") {
    return this.call<number>("getSlot", [{ commitment }]);
  }

  getBlockHeight(commitment: Commitment = "finalized") {
    return this.call<number>("getBlockHeight", [{ commitment }]);
  }

  /**
   * `minContextSlot` makes the node refuse (error -32016, retried as transient) instead of
   * answering from a state older than that slot — e.g. a load-balanced backend that has not yet
   * indexed the snapshot slot.
   */
  getSignaturesForAddress(address: string, o: { before?: string; until?: string; limit?: number; commitment?: Commitment; minContextSlot?: number } = {}) {
    const cfg: Record<string, unknown> = { limit: o.limit ?? 1000, commitment: o.commitment ?? "confirmed" };
    if (o.before) cfg.before = o.before;
    if (o.until) cfg.until = o.until;
    if (o.minContextSlot !== undefined) cfg.minContextSlot = o.minContextSlot;
    return this.call<SignatureInfo[]>("getSignaturesForAddress", [address, cfg]);
  }

  /** Returns the raw `json`-encoded transaction, or null if the node does not have it yet. */
  async getTransactionRaw(signature: string, commitment: Exclude<Commitment, "processed"> = "confirmed"): Promise<any | null> {
    for (let i = 0; i < 3; i++) {
      try {
        return await this.call<any | null>("getTransaction", [signature, { encoding: "json", commitment, maxSupportedTransactionVersion: this.maxTxVersion }]);
      } catch (err) {
        // -32015: "Transaction version (N) is not supported by the requesting client" → upgrade and retry.
        if (err instanceof RpcError && err.code === -32015) {
          const m = /version \((\d+)\)/.exec(err.message);
          const v = m ? Number(m[1]) : this.maxTxVersion + 1;
          if (v > this.maxTxVersion && v <= 255) {
            this.log.warn({ from: this.maxTxVersion, to: v }, "RPC reported a newer transaction version; upgrading maxSupportedTransactionVersion");
            this.maxTxVersion = v;
            continue;
          }
        }
        throw err;
      }
    }
    return null;
  }

  async getAccountInfo(address: string, commitment: Commitment = "confirmed", opts: { minContextSlot?: number } = {}): Promise<{ slot: number; value: AccountInfoRaw | null }> {
    const r = await this.call<any>("getAccountInfo", [address, { encoding: "base64", commitment, ...(opts.minContextSlot !== undefined ? { minContextSlot: opts.minContextSlot } : {}) }]);
    return { slot: r.context.slot, value: r.value ? decodeAccount(r.value) : null };
  }

  async getMultipleAccounts(addresses: string[], commitment: Commitment = "confirmed", opts: { minContextSlot?: number } = {}): Promise<{ slot: number; value: (AccountInfoRaw | null)[] }> {
    const r = await this.call<any>("getMultipleAccounts", [addresses, { encoding: "base64", commitment, ...(opts.minContextSlot !== undefined ? { minContextSlot: opts.minContextSlot } : {}) }]);
    return { slot: r.context.slot, value: r.value.map((v: any) => (v ? decodeAccount(v) : null)) };
  }

  /** Program accounts matching filters (addresses only when `dataSlice` length is 0). Used for pool discovery. */
  async getProgramAccounts(programId: string, o: { filters: unknown[]; dataSlice?: { offset: number; length: number }; commitment?: Commitment }): Promise<{ pubkey: string; account: AccountInfoRaw }[]> {
    const r = await this.call<any>("getProgramAccounts", [programId, { encoding: "base64", commitment: o.commitment ?? "confirmed", filters: o.filters, ...(o.dataSlice ? { dataSlice: o.dataSlice } : {}) }]);
    return (Array.isArray(r) ? r : (r?.value ?? [])).map((x: any) => ({ pubkey: x.pubkey, account: decodeAccount(x.account) }));
  }

  /** Largest token accounts of a mint (used to locate the current holder of an NFT). */
  async getTokenLargestAccounts(mint: string, commitment: Commitment = "confirmed"): Promise<{ slot: number; value: { address: string; amount: bigint }[] }> {
    const r = await this.call<any>("getTokenLargestAccounts", [mint, { commitment }]);
    return { slot: r.context.slot, value: (r.value ?? []).map((v: any) => ({ address: v.address, amount: BigInt(v.amount) })) };
  }

  async getBalance(address: string, commitment: Commitment = "confirmed"): Promise<bigint> {
    const r = await this.call<any>("getBalance", [address, { commitment }]);
    return BigInt(r.value);
  }

  async getTokenAccountBalance(address: string, commitment: Commitment = "confirmed"): Promise<{ slot: number; amount: bigint } | null> {
    try {
      const r = await this.call<any>("getTokenAccountBalance", [address, { commitment }]);
      return { slot: r.context.slot, amount: BigInt(r.value.amount) };
    } catch (err) {
      if (err instanceof RpcError && (err.code === -32602 || /could not find account|not a Token account/i.test(err.message))) return null;
      throw err;
    }
  }

  async getLatestBlockhash(commitment: Commitment = "confirmed"): Promise<{ blockhash: string; lastValidBlockHeight: number; slot: number }> {
    const r = await this.call<any>("getLatestBlockhash", [{ commitment }]);
    return { blockhash: r.value.blockhash, lastValidBlockHeight: r.value.lastValidBlockHeight, slot: r.context.slot };
  }

  getMinimumBalanceForRentExemption(size: number) {
    return this.call<number>("getMinimumBalanceForRentExemption", [size]);
  }

  /** Broadcast; never retried at this layer (the payout executor owns rebroadcast policy). */
  sendRawTransaction(serializedBase64: string, o: { skipPreflight?: boolean; preflightCommitment?: Commitment } = {}) {
    return this.call<string>(
      "sendTransaction",
      [serializedBase64, { encoding: "base64", skipPreflight: o.skipPreflight ?? false, preflightCommitment: o.preflightCommitment ?? "confirmed", maxRetries: 0 }],
      { retries: 0 },
    );
  }

  async getSignatureStatuses(signatures: string[], searchTransactionHistory = true): Promise<(SignatureStatus | null)[]> {
    const r = await this.call<any>("getSignatureStatuses", [signatures, { searchTransactionHistory }]);
    return r.value;
  }

  /**
   * Statuses plus the slot the answering node evaluated them at. A `null` status only means
   * "unknown to a node at `contextSlot`" — callers deciding that a transaction can never land must
   * check that this slot is recent enough (see PayoutExecutor.checkSubmitted).
   */
  async getSignatureStatusesWithContext(signatures: string[], searchTransactionHistory = true): Promise<{ contextSlot: number; value: (SignatureStatus | null)[] }> {
    const r = await this.call<any>("getSignatureStatuses", [signatures, { searchTransactionHistory }]);
    return { contextSlot: Number(r.context?.slot ?? 0), value: r.value };
  }

  /** Slot and block height at `commitment`, from ONE node in ONE call (so they are mutually consistent). */
  async getEpochInfo(commitment: Commitment = "finalized"): Promise<{ absoluteSlot: number; blockHeight: number }> {
    const r = await this.call<any>("getEpochInfo", [{ commitment }]);
    return { absoluteSlot: Number(r.absoluteSlot), blockHeight: Number(r.blockHeight) };
  }

  /** Ordered signatures of a block (used to break intra-slot ordering ties exactly). */
  async getBlockSignatures(slot: number): Promise<string[] | null> {
    try {
      const r = await this.call<any>("getBlock", [slot, { encoding: "json", transactionDetails: "signatures", rewards: false, commitment: "confirmed", maxSupportedTransactionVersion: this.maxTxVersion }]);
      return r?.signatures ?? null;
    } catch (err) {
      if (err instanceof RpcError && (err.code === -32007 || err.code === -32009 || err.code === -32004)) return null;
      throw err;
    }
  }
}

/** The subset of RPC the engine depends on (implemented by RpcClient and by the test FakeChain). */
export type ChainRpc = Pick<
  RpcClient,
  | "getSlot"
  | "getBlockHeight"
  | "getSignaturesForAddress"
  | "getTransactionRaw"
  | "getAccountInfo"
  | "getMultipleAccounts"
  | "getBalance"
  | "getTokenAccountBalance"
  | "getLatestBlockhash"
  | "getMinimumBalanceForRentExemption"
  | "sendRawTransaction"
  | "getSignatureStatuses"
  | "getSignatureStatusesWithContext"
  | "getEpochInfo"
  | "getBlockSignatures"
  | "getTokenLargestAccounts"
  | "getProgramAccounts"
>;

function decodeAccount(v: any): AccountInfoRaw {
  return { data: Buffer.from(v.data[0], "base64"), owner: v.owner, lamports: v.lamports, executable: v.executable };
}
