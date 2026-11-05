/**
 * ChainRpc backed by LiteSVM — the real Solana runtime (signature verification, System /
 * ComputeBudget / Memo / SPL Token / ATA programs, fees, rent) running in-process. Used to prove
 * that the payout transactions LAST60 builds actually execute and move exactly the intended
 * funds, without a network or real keys.
 */
import bs58 from "bs58";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";
import { address, getTransactionDecoder, lamports } from "@solana/kit";
import { RpcError, type ChainRpc, type SignatureStatus } from "../chain/rpc";

export class LiteSvmChain implements Pick<ChainRpc, "getSlot" | "getBlockHeight" | "getBalance" | "getLatestBlockhash" | "sendRawTransaction" | "getSignatureStatuses" | "getSignatureStatusesWithContext" | "getEpochInfo"> {
  readonly svm = new LiteSVM().withSysvars().withBuiltins().withDefaultPrograms();
  slot = 1_000;
  finalityLag = 32;
  private statuses = new Map<string, { slot: number; err: unknown | null }>();
  private blockhashSlot = 1_000;
  sends: { signature: string; result: string }[] = [];

  constructor() {
    this.svm.warpToSlot(BigInt(this.slot));
  }

  fund(pubkey: string, amount: bigint) {
    this.svm.airdrop(address(pubkey), lamports(amount));
  }

  balance(pubkey: string): bigint {
    return this.svm.getBalance(address(pubkey)) ?? 0n;
  }

  /** Advance slots; after 150 slots the current blockhash expires, as on mainnet. */
  advance(slots: number) {
    this.slot += slots;
    this.svm.warpToSlot(BigInt(this.slot));
    if (this.slot - this.blockhashSlot > 150) {
      this.svm.expireBlockhash();
      this.blockhashSlot = this.slot;
    }
  }

  async getSlot() {
    return this.slot;
  }
  async getBlockHeight(commitment: "processed" | "confirmed" | "finalized" = "finalized") {
    return commitment === "finalized" ? this.slot - this.finalityLag : this.slot;
  }
  async getBalance(pubkey: string) {
    return this.balance(pubkey);
  }
  async getLatestBlockhash() {
    return { blockhash: this.svm.latestBlockhash(), lastValidBlockHeight: this.blockhashSlot + 150, slot: this.slot };
  }

  async sendRawTransaction(serializedBase64: string): Promise<string> {
    const bytes = Buffer.from(serializedBase64, "base64");
    const signature = bs58.encode(bytes.subarray(1, 65)); // compact-u16 count (1) + first signature
    const tx = getTransactionDecoder().decode(bytes);
    const res = this.svm.sendTransaction(tx as any);
    if (res instanceof FailedTransactionMetadata) {
      const text = String(res.toString());
      this.sends.push({ signature, result: text });
      if (/AlreadyProcessed/i.test(text)) throw new RpcError("Transaction simulation failed: This transaction has already been processed", -32002, 200);
      if (!/InstructionError/i.test(text)) throw new RpcError(`Transaction simulation failed: ${text}`, -32002, 200); // rejected before execution
      this.statuses.set(signature, { slot: this.slot, err: text });
      return signature;
    }
    this.sends.push({ signature, result: "ok" });
    this.statuses.set(signature, { slot: this.slot, err: null });
    return signature;
  }

  async getSignatureStatuses(signatures: string[]): Promise<(SignatureStatus | null)[]> {
    return signatures.map((s) => {
      const st = this.statuses.get(s);
      if (!st) return null;
      const finalized = st.slot <= this.slot - this.finalityLag;
      return { slot: st.slot, confirmations: null, err: st.err, confirmationStatus: finalized ? "finalized" : "confirmed" };
    });
  }

  async getSignatureStatusesWithContext(signatures: string[]) {
    return { contextSlot: this.slot, value: await this.getSignatureStatuses(signatures) };
  }

  async getEpochInfo(commitment: "processed" | "confirmed" | "finalized" = "finalized") {
    const s = commitment === "finalized" ? this.slot - this.finalityLag : this.slot;
    return { absoluteSlot: s, blockHeight: s };
  }

  /** Any SPL/raw transaction (setup helpers in tests). */
  async sendWeb3(tx: { serialize(): Buffer }) {
    return this.sendRawTransaction(tx.serialize().toString("base64"));
  }
}
