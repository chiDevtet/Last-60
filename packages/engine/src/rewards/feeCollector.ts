/**
 * Optional automatic fee collection (FEE_COLLECTION_MODE=auto_claim, live mode only).
 * Claims the beneficiary's accrued fees through the provider's official claim instruction and
 * unwraps WSOL straight into the payout wallet in the same transaction. Claiming is naturally
 * idempotent (a second claim simply claims the remainder), and the claimed amount is recorded
 * from the program's own event / vault delta when the transaction is ingested.
 */
import { ComputeBudgetProgram, Transaction, type Keypair, type PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import type { AppConfig } from "../config/env";
import { liveSigningBlockReason, type SettingsStore } from "../config/runtime";
import type { ChainRpc } from "../chain/rpc";
import type { Models } from "../db/models";
import { big, dec } from "../db/decimal";
import type { LaunchProvider } from "../providers/LaunchProvider";
import type { TerminalWriter } from "../terminal/terminal";
import { ingestRawTransaction } from "../indexer/ingest";
import type { Clock } from "../util/time";
import { rootLogger, type Logger } from "../util/logger";

export interface FeeCollectorDeps {
  db: Models;
  cfg: AppConfig;
  settings: SettingsStore;
  rpc: ChainRpc;
  provider: () => LaunchProvider;
  claimer: Keypair | null;
  payoutWallet: PublicKey | null;
  terminal: TerminalWriter;
  clock: Clock;
  log?: Logger;
}

export class FeeCollector {
  private readonly log: Logger;
  private warned = false;
  constructor(private readonly d: FeeCollectorDeps) {
    this.log = (d.log ?? rootLogger()).child({ component: "fee-collector" });
  }

  async maybeClaim(): Promise<string | null> {
    const s = await this.d.settings.get();
    // Claims are mainnet transactions too: the same signer-side live/mainnet gate applies.
    if (s.feeCollectionMode !== "auto_claim" || s.pausePayouts || liveSigningBlockReason(this.d.cfg, s)) return null;
    if (!this.d.claimer || !this.d.payoutWallet) {
      if (!this.warned) this.log.warn("auto_claim enabled but no claim signer / payout wallet loaded");
      this.warned = true;
      return null;
    }
    const recent = await this.d.db.FeeClaim.findOne({ source: "auto_claim", status: "submitted", createdAt: { $gt: new Date(this.d.clock.now() - 120_000) } }).lean();
    if (recent) return null; // a claim is already in flight
    const provider = this.d.provider();
    const state = await provider.getFeeSourceState();
    if (state.unclaimedQuote < this.d.cfg.feeCollection.minClaimLamports) return null;

    const plan = await provider.buildClaimInstructions(this.d.claimer.publicKey, this.d.payoutWallet);
    const { blockhash, lastValidBlockHeight } = await this.d.rpc.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: this.d.claimer.publicKey, recentBlockhash: blockhash }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.d.cfg.payout.priorityFeeMicroLamports }),
      ...plan.instructions,
    );
    tx.sign(this.d.claimer);
    const signature = bs58.encode(tx.signature!);
    const info = provider.info();
    await this.d.db.FeeClaim.create({ signature, provider: info.provider, pool: info.poolAddress, role: info.feeBeneficiaryRole, claimer: this.d.claimer.publicKey.toBase58(), quoteMint: info.quoteMint, quoteAmount: dec(0n), baseAmount: dec(0n), source: "auto_claim", status: "submitted" });
    try {
      await this.d.rpc.sendRawTransaction(tx.serialize().toString("base64"), { skipPreflight: false });
    } catch (err: any) {
      await this.d.db.FeeClaim.updateOne({ signature }, { $set: { status: "failed", error: String(err?.message ?? err).slice(0, 300) } });
      this.log.warn({ err: String(err?.message ?? err) }, "fee claim rejected");
      return null;
    }
    // Wait for confirmation (bounded), then ingest the claim through the normal path.
    for (let i = 0; i < 60; i++) {
      const [st] = await this.d.rpc.getSignatureStatuses([signature], true);
      if (st?.err) {
        await this.d.db.FeeClaim.updateOne({ signature }, { $set: { status: "failed", error: JSON.stringify(st.err) } });
        return null;
      }
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
        const raw = await this.d.rpc.getTransactionRaw(signature, "confirmed");
        if (raw) await ingestRawTransaction({ db: this.d.db, provider, terminal: this.d.terminal, minBuyQuote: s.minBuyQuote, log: this.log }, raw, { source: "catchup", commitment: "confirmed" });
        const claim: any = await this.d.db.FeeClaim.findOne({ signature }).lean();
        if (claim) await this.d.terminal.feeClaimed(big(claim.quoteAmount), signature);
        return signature;
      }
      if ((await this.d.rpc.getBlockHeight("confirmed")) > lastValidBlockHeight) break;
      await this.d.clock.sleep(1000);
    }
    await this.d.db.FeeClaim.updateOne({ signature, status: "submitted" }, { $set: { status: "failed", error: "not confirmed before blockhash expiry" } });
    return null;
  }
}
