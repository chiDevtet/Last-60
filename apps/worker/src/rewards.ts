/**
 * Rewards process (PM2: last60-rewards). The ONLY process that loads signing keys and the
 * schedule encryption key. Keys are loaded once, verified against the configured public keys,
 * and never logged.
 */
import { loadKeypair, RewardsWorker } from "@last60/engine";
import type { Keypair } from "@solana/web3.js";
import { boot } from "./bootstrap";

const { cfg, log, db, settings, signal } = await boot("rewards", "last60-rewards");

let payer: Keypair | null = null;
if (cfg.secrets.payoutWalletPrivateKey || cfg.secrets.payoutWalletKeypairPath) {
  payer = loadKeypair({ privateKey: cfg.secrets.payoutWalletPrivateKey, keypairPath: cfg.secrets.payoutWalletKeypairPath }, cfg.payout.walletPublicKey, "payout wallet");
}
let claimer: Keypair | null = null;
if (cfg.secrets.feeClaimAuthorityPrivateKey || cfg.secrets.feeClaimAuthorityKeypairPath) {
  claimer = loadKeypair({ privateKey: cfg.secrets.feeClaimAuthorityPrivateKey, keypairPath: cfg.secrets.feeClaimAuthorityKeypairPath }, null, "fee claim authority");
} else if (cfg.feeCollection.mode === "auto_claim") {
  claimer = payer; // the payout wallet is also the fee beneficiary
}
// Scrub secrets from the environment of this process once loaded.
delete process.env.PAYOUT_WALLET_PRIVATE_KEY;
delete process.env.FEE_CLAIM_AUTHORITY_PRIVATE_KEY;

const mode = (await settings.get()).payoutMode;
log.info({ payoutMode: mode, payer: payer?.publicKey.toBase58() ?? null, cluster: cfg.solana.cluster, feeCollection: cfg.feeCollection.mode }, "rewards worker starting");
if (mode === "live" && cfg.solana.cluster === "mainnet-beta") log.warn("LIVE MAINNET PAYOUTS ENABLED — real funds will move");

const worker = new RewardsWorker({ db, cfg, settings, payer, claimer, log });
await worker.run(signal);
await db.close();
log.info("rewards worker stopped");
