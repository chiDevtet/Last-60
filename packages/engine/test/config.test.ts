import { describe, expect, test } from "bun:test";
import { ConfigError, loadConfig, percentToBps, redactConfig } from "../src/config/env";
import { resolveSettings, RuntimeOverridesSchema, validateEffective } from "../src/config/runtime";
import { parseSecretKey } from "../src/chain/keys";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { seal, unseal } from "../src/util/crypto";
import { big, dec } from "../src/db/decimal";
import { formatSol, parseUnits } from "@last60/shared";

const base = {
  SOLANA_CLUSTER: "devnet",
  SOLANA_RPC_URL: "https://api.devnet.solana.com",
  MONGODB_URI: "mongodb://localhost/x",
  TOKEN_MINT: "So11111111111111111111111111111111111111112",
  POOL_ADDRESS: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  // A devnet setup has no Forge platform wallet: it selects the legacy policy (the default is forge_phase_aware_v2).
  REWARD_FUNDING_POLICY: "legacy_creator_fee_v1",
};

describe("environment validation", () => {
  test("defaults match the product spec", () => {
    const c = loadConfig("api", base);
    expect(c.rewards.buyerCount).toBe(5);
    expect(c.rewards.minBuyQuote).toBe(50_000_000n);
    expect(c.rewards.rewardBps).toBe(7500);
    expect(c.schedule.roundDurationMs).toBe(300_000);
    expect(c.schedule.windowStartMs).toBe(240_000);
    expect(c.schedule.windowDurationMs).toBe(60_000);
    expect(c.provider.id).toBe("meteora_dbc");
    expect(c.payout.mode).toBe("dry_run"); // safe by default
    expect(c.solana.wsUrl).toBe("wss://api.devnet.solana.com/");
  });

  test("reports every problem at once with clear messages", () => {
    try {
      loadConfig("rewards", { ...base, BUYER_COUNT: "0", REWARD_PERCENTAGE: "120", RANDOM_WINDOW_START_SECONDS: "280", PAYOUT_MODE: "live", SOLANA_CLUSTER: "mainnet-beta" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as Error).message;
      expect(msg).toContain("BUYER_COUNT");
    }
    try {
      loadConfig("rewards", { ...base, REWARD_PERCENTAGE: "120", RANDOM_WINDOW_START_SECONDS: "280", PAYOUT_MODE: "live", SOLANA_CLUSTER: "mainnet-beta" });
      throw new Error("should have thrown");
    } catch (e) {
      const p = (e as ConfigError).problems.join("\n");
      expect(p).toContain("REWARD_PERCENTAGE");
      expect(p).toContain("RANDOM_WINDOW_START_SECONDS");
      expect(p).toContain("SCHEDULE_ENCRYPTION_KEY");
      expect(p).toContain("ALLOW_MAINNET_PAYOUTS");
      expect(p).toContain("PAYOUT_WALLET_PRIVATE_KEY");
    }
  });

  test("secrets can never use the NEXT_PUBLIC_ prefix", () => {
    expect(() => loadConfig("api", { ...base, NEXT_PUBLIC_PAYOUT_WALLET_PRIVATE_KEY: "abc" })).toThrow(/NEXT_PUBLIC_/);
    expect(() => loadConfig("api", { ...base, ADMIN_SESSION_SECRET: "s".repeat(40), NEXT_PUBLIC_X: "prefix-" + "s".repeat(40) })).toThrow(/server secret/);
  });

  test("provider/role combinations are validated", () => {
    expect(() => loadConfig("indexer", { ...base, FEE_BENEFICIARY_ROLE: "platform" })).toThrow(/platform/);
    expect(() => loadConfig("indexer", { ...base, LAUNCH_PROVIDER: "raydium_launchlab", FEE_BENEFICIARY_ROLE: "partner" })).toThrow(/partner/);
    // No token yet is not an error (set it in the admin console; workers wait). A DBC pool cannot be derived.
    expect(loadConfig("indexer", { ...base, TOKEN_MINT: "", POOL_ADDRESS: "" }).provider.tokenMint).toBeNull();
    expect(() => loadConfig("indexer", { ...base, POOL_ADDRESS: "" })).toThrow(/POOL_ADDRESS: is required for meteora_dbc/);
    expect(loadConfig("indexer", { ...base, LAUNCH_PROVIDER: "raydium_launchlab" }).provider.id).toBe("raydium_launchlab");
  });

  test("minimum payout must cover rent exemption", () => {
    expect(() => loadConfig("api", { ...base, MIN_PAYOUT_LAMPORTS: "5000" })).toThrow(/rent-exempt/);
  });

  test("percentages parse exactly to basis points", () => {
    expect(percentToBps("75")).toBe(7500);
    expect(percentToBps("75.5")).toBe(7550);
    expect(percentToBps("0.01")).toBe(1);
    expect(() => percentToBps("0")).toThrow();
    expect(() => percentToBps("100.01")).toThrow();
    expect(() => percentToBps("7.555")).toThrow();
  });

  test("redaction hides keys embedded in RPC URLs", () => {
    const c = loadConfig("api", { ...base, SOLANA_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=SECRET123" });
    expect(JSON.stringify(redactConfig(c))).not.toContain("SECRET123");
  });
});

describe("runtime settings", () => {
  const cfg = loadConfig("api", base);
  test("overrides are strictly validated", () => {
    expect(RuntimeOverridesSchema.safeParse({ buyerCount: 0 }).success).toBe(false);
    expect(RuntimeOverridesSchema.safeParse({ privateKey: "x" }).success).toBe(false); // secrets are not settable
    expect(RuntimeOverridesSchema.safeParse({ rewardBps: 8000, buyerCount: 3 }).success).toBe(true);
  });
  test("live mainnet payouts cannot be enabled from the admin UI without the env switch", () => {
    const main = loadConfig("api", { ...base, SOLANA_CLUSTER: "mainnet-beta" });
    const s = resolveSettings(main, { payoutMode: "live" }, 1);
    expect(validateEffective(main, s).join()).toMatch(/ALLOW_MAINNET_PAYOUTS/);
  });
  test("env values are the defaults", () => {
    const s = resolveSettings(cfg, {}, 0);
    expect(s.buyerCount).toBe(5);
    expect(s.rewardBps).toBe(7500);
    expect(resolveSettings(cfg, { minBuyQuote: "100" }, 1).minBuyQuote).toBe(100n);
  });
});

describe("keys, crypto and exact amounts", () => {
  test("secret keys parse from base58 and JSON; bad keys are rejected", () => {
    const kp = Keypair.generate();
    expect(parseSecretKey(bs58.encode(kp.secretKey)).publicKey.equals(kp.publicKey)).toBe(true);
    expect(parseSecretKey(JSON.stringify([...kp.secretKey])).publicKey.equals(kp.publicKey)).toBe(true);
    expect(() => parseSecretKey("abc")).toThrow();
  });
  test("sealed schedule values are bound to their round and tamper-evident", () => {
    const key = Buffer.alloc(32, 9);
    const c = seal(key, "1793900000000", "round:1");
    expect(unseal(key, c, "round:1")).toBe("1793900000000");
    expect(() => unseal(key, c, "round:2")).toThrow();
    expect(() => unseal(Buffer.alloc(32, 8), c, "round:1")).toThrow();
  });
  test("Decimal128 round-trips u64 exactly, including exponent forms from aggregation", () => {
    const max = 18_446_744_073_709_551_615n;
    expect(big(dec(max))).toBe(max);
    expect(big("1.5E+3")).toBe(1500n);
    expect(big("1500E-1")).toBe(150n);
    expect(() => big("1.5")).toThrow();
  });
  test("decimal parsing never uses floating point", () => {
    expect(parseUnits("0.05", 9)).toBe(50_000_000n);
    expect(parseUnits("0.3", 9)).toBe(300_000_000n);
    expect(parseUnits("1.000000001", 9)).toBe(1_000_000_001n);
    expect(() => parseUnits("0.0000000001", 9)).toThrow();
    expect(formatSol(1_500_000_000n)).toBe("1.50");
    expect(formatSol(63_000_000n, 3)).toBe("0.063");
  });
});
