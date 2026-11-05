/**
 * Payouts executed by the REAL Solana runtime (LiteSVM): rounds are planned by the production
 * scheduler, then the production PayoutExecutor signs and sends transactions that LiteSVM
 * verifies and executes. Balances are read back from the runtime.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { address } from "@solana/kit";
import { big } from "../src/db/decimal";
import { PayoutExecutor } from "../src/rewards/payouts";
import { buildPayoutTransaction } from "../src/chain/payoutTx";
import { TerminalWriter } from "../src/terminal/terminal";
import { LiteSvmChain } from "../src/testing/liteSvmChain";
import { rig, SOL, startDb, stopDb, T0, wallet, type Rig } from "./harness";

beforeAll(startDb, 120_000);
afterAll(stopDb);

async function plannedRound(r: Rig, buyers: string[]) {
  await r.worker.scheduler.tick(r.clock.now());
  for (const b of buyers) r.trade({ trader: b, quote: 10n * SOL });
  r.clock.set(T0 + 240_000);
  await r.worker.scheduler.tick(r.clock.now());
  r.clock.set(T0 + 270_000);
  await r.worker.scheduler.tick(r.clock.now());
}

function executor(r: Rig, chain: LiteSvmChain) {
  return new PayoutExecutor({ db: r.db, cfg: r.cfg, settings: r.settings, rpc: chain as any, payer: r.payer, terminal: new TerminalWriter(r.db), clock: r.clock });
}

describe("payouts on the real Solana runtime (LiteSVM)", () => {
  test("individual SOL transfers execute with compute budget + memo; recipients receive exactly their allocation", async () => {
    const r = await rig();
    const buyers = Array.from({ length: 5 }, wallet);
    await plannedRound(r, buyers);
    const chain = new LiteSvmChain();
    chain.fund(r.payer.publicKey.toBase58(), 50n * SOL);
    const before = chain.balance(r.payer.publicKey.toBase58());
    const ex = executor(r, chain);
    await ex.processDue();
    expect(chain.sends.filter((s) => s.result === "ok").length).toBe(5);
    chain.advance(40);
    r.clock.set(r.clock.now() + 2000);
    await ex.processDue();
    const payouts: any[] = await r.db.Payout.find({}).lean();
    expect(payouts.every((p) => p.state === "confirmed")).toBe(true);
    let total = 0n;
    for (const p of payouts) {
      expect(chain.balance(p.recipient)).toBe(big(p.amount)); // fresh wallets: balance == payout
      total += big(p.amount);
    }
    const spent = before - chain.balance(r.payer.publicKey.toBase58());
    const fees = spent - total;
    expect(fees).toBeGreaterThan(0n);
    expect(fees).toBeLessThan(5n * 20_000n); // base fee + priority fee per tx
    const round: any = await r.db.Round.findOne({ roundNumber: 1 }).lean();
    expect(round.state).toBe("completed");
  });

  test("the runtime itself rejects a duplicate broadcast; the recipient is paid once", async () => {
    const r = await rig();
    const [b] = [wallet()];
    await plannedRound(r, [b!]);
    const chain = new LiteSvmChain();
    chain.fund(r.payer.publicKey.toBase58(), 50n * SOL);
    const ex = executor(r, chain);
    await ex.processDue();
    const p: any = await r.db.Payout.findOne({}).select("+current.serializedTx").lean();
    // An attacker / bug re-sends the exact bytes: the runtime refuses (AlreadyProcessed).
    await expect(chain.sendRawTransaction(p.current.serializedTx)).rejects.toThrow(/already been processed/);
    chain.advance(40);
    r.clock.set(r.clock.now() + 2000);
    await ex.processDue();
    expect(chain.balance(b!)).toBe(big(p.amount));
  });

  test("expired blockhash: the runtime rejects the stale transaction and the executor re-signs once", async () => {
    const r = await rig();
    const b = wallet();
    await plannedRound(r, [b]);
    const chain = new LiteSvmChain();
    chain.fund(r.payer.publicKey.toBase58(), 50n * SOL);
    const ex = executor(r, chain);
    // Sign against the current blockhash, then let it expire before the first broadcast lands.
    const orig = chain.sendRawTransaction.bind(chain);
    let first = true;
    chain.sendRawTransaction = async (tx: string) => {
      if (first) {
        first = false;
        chain.advance(200); // blockhash expires
      }
      return orig(tx);
    };
    await ex.processDue(); // preflight-equivalent rejection → attempt retired immediately
    let p: any = await r.db.Payout.findOne({}).lean();
    expect(p.state).toBe("pending");
    expect(p.attempts[0].outcome).toBe("failed");
    r.clock.set(r.clock.now() + 10_000);
    await ex.processDue();
    chain.advance(40);
    r.clock.set(r.clock.now() + 2000);
    await ex.processDue();
    p = await r.db.Payout.findOne({}).lean();
    expect(p.state).toBe("confirmed");
    expect(chain.balance(b)).toBe(big(p.amount));
  });

  test("insufficient funds are caught before signing; nothing is sent", async () => {
    const r = await rig();
    await plannedRound(r, [wallet()]);
    const chain = new LiteSvmChain();
    chain.fund(r.payer.publicKey.toBase58(), 1_000_000n);
    await executor(r, chain).processDue();
    expect(chain.sends.length).toBe(0);
    expect(((await r.db.Round.findOne({ roundNumber: 1 }).lean()) as any).state).toBe("awaiting_funds");
  });

  test("SPL payout path: ATA is created idempotently and transferChecked moves exact token units", async () => {
    const chain = new LiteSvmChain();
    const payer = Keypair.generate();
    const mint = Keypair.generate();
    chain.fund(payer.publicKey.toBase58(), 10n * SOL);
    const bh = async () => (await chain.getLatestBlockhash()).blockhash;
    const rent = Number(chain.svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE)));
    const payerAta = getAssociatedTokenAddressSync(mint.publicKey, payer.publicKey);
    const setup = new Transaction({ feePayer: payer.publicKey, recentBlockhash: await bh() }).add(
      SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, lamports: rent, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
      createInitializeMint2Instruction(mint.publicKey, 6, payer.publicKey, null),
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, payerAta, payer.publicKey, mint.publicKey),
      createMintToInstruction(mint.publicKey, payerAta, payer.publicKey, 1_000_000_000n),
    );
    setup.sign(payer, mint);
    await chain.sendWeb3(setup);
    const recipient = Keypair.generate().publicKey.toBase58();
    const built = buildPayoutTransaction({ payer, recipient, amount: 123_456_789n, mint: mint.publicKey.toBase58(), blockhash: await bh(), priorityFeeMicroLamports: 1000, computeUnitLimit: 60_000, memo: "last60:r1:test", token: { program: TOKEN_PROGRAM_ID.toBase58(), decimals: 6 } });
    const sig = await chain.sendRawTransaction(built.serialized);
    expect(sig).toBe(built.signature);
    expect(chain.sends.at(-1)!.result).toBe("ok");
    const recipientAta = getAssociatedTokenAddressSync(mint.publicKey, new (await import("@solana/web3.js")).PublicKey(recipient));
    const acct = chain.svm.getAccount(address(recipientAta.toBase58()));
    if (!acct || !("data" in acct)) throw new Error("recipient ATA was not created");
    const amount = Buffer.from(acct.data).readBigUInt64LE(64); // SPL token account: amount at offset 64
    expect(amount).toBe(123_456_789n);
  });
});
