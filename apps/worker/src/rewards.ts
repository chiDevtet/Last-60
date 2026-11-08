/**
 * Rewards process (PM2: last60-rewards). The ONLY process that loads signing keys and the
 * schedule encryption key. The dedicated payout signer is loaded once, validated against
 * LAST60_PAYOUT_WALLET_ADDRESS (fail closed: a missing address, malformed key or a key deriving a
 * different address stops the process) and never logged. Only its sanitized status is published.
 */
import { liveSigningBlockReason, loadKeypair, PayoutSigner, RewardsWorker } from "@last60/engine";
import type { Keypair } from "@solana/web3.js";
import { boot } from "./bootstrap";

const { cfg, log, db, settings, signal } = await boot("rewards", "last60-rewards");

const loaded = PayoutSigner.load({ privateKey: cfg.secrets.payoutWalletPrivateKey, keypairPath: cfg.secrets.payoutWalletKeypairPath }, cfg.payout.walletPublicKey);
if (loaded.status.code !== "ok" && loaded.status.code !== "not_configured") {
  // Sanitized message only (never the key or a parser error that could quote it).
  log.fatal({ signer: loaded.status }, "payout signer refused to load; fix LAST60_PAYOUT_WALLET_* and restart");
  process.exit(78);
}
const signer = loaded.signer;
let claimer: Keypair | null = null;
if (cfg.secrets.feeClaimAuthorityPrivateKey || cfg.secrets.feeClaimAuthorityKeypairPath) {
  claimer = loadKeypair({ privateKey: cfg.secrets.feeClaimAuthorityPrivateKey, keypairPath: cfg.secrets.feeClaimAuthorityKeypairPath }, null, "fee claim authority");
}
// The payout signer never signs fee claims: auto_claim requires FEE_CLAIM_AUTHORITY_* (checked at config load).
// Scrub secrets from the environment of this process once loaded.
delete process.env.LAST60_PAYOUT_WALLET_PRIVATE_KEY;
delete process.env.PAYOUT_WALLET_PRIVATE_KEY;
delete process.env.FEE_CLAIM_AUTHORITY_PRIVATE_KEY;

const effective = await settings.get();
const mode = effective.payoutMode;
const blocked = liveSigningBlockReason(cfg, effective);
log.info({ payoutMode: mode, payoutWallet: cfg.payout.walletPublicKey, signer: loaded.status.code, cluster: cfg.solana.cluster, feeCollection: cfg.feeCollection.mode }, "rewards worker starting");
if (mode === "live" && blocked) log.warn({ reason: blocked }, "payout mode is live but this process will NOT sign: live payouts stay queued");
else if (mode === "live" && cfg.solana.cluster === "mainnet-beta") log.warn("LIVE MAINNET PAYOUTS ENABLED — real funds will move");

const worker = new RewardsWorker({ db, cfg, settings, payer: signer, signerStatus: loaded.status, claimer, log });
await worker.publishSignerStatus().catch(() => undefined);
await worker.run(signal);
await db.close();
log.info("rewards worker stopped");
