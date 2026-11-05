# Launch providers

`LAUNCH_PROVIDER` selects the adapter; nothing else in the system changes. Both adapters were
built from the programs' official IDLs (vendored in `packages/engine/src/providers/*/idl/`) and
validated against real mainnet transactions and account data (`test/fixtures/mainnet/`).

```
LAUNCH_PROVIDER=meteora_dbc        FEE_BENEFICIARY_ROLE=creator|partner
LAUNCH_PROVIDER=raydium_launchlab  FEE_BENEFICIARY_ROLE=creator|platform
```

Switching was exercised live: the running system was moved from a Meteora DBC pool to a Raydium
LaunchLab pool through the admin API (audited settings change), and both workers re-initialised
within seconds without a restart.

## Interface (`providers/LaunchProvider.ts`)

| Method | Responsibility |
|---|---|
| `load()` | Read pool + config from chain, validate program ownership, `pool.base_mint == TOKEN_MINT`, payout asset == quote mint; derive creator, beneficiary, fee params, vaults, migration status. |
| `parseTransaction(tx)` | **Pure.** Decode the program's event CPIs, link each to its emitting instruction, return `NormalizedSwap[]`, `NormalizedFeeClaim[]` and anomalies. |
| `getFeeSourceState()` | Unclaimed eligible fees on-chain at a slot (for reconciliation). |
| `buildClaimInstructions()` | Official claim instruction + WSOL unwrap into the payout wallet. |
| `supportedQuoteAssets()` | Assets usable for SOL-denominated accounting (WSOL). |
| `info().watchAddresses` | Addresses the indexer must follow to see every swap and claim. |

## Meteora Dynamic Bonding Curve — `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`

* **Events.** Every swap emits `EvtSwap`, `EvtSwap2`, `EvtSwap3` (self-CPI). The adapter groups
  events by emitting instruction and uses one per swap (EvtSwap3, else EvtSwap2), so a swap is
  never counted three times (tested on real transactions).
* **Direction.** `trade_direction` 1 = QuoteToBase = buy; 0 = sell.
* **Amounts.** Buy: `included_transfer_fee_amount_in` (quote spent, gross); sell:
  `excluded_transfer_fee_amount_out` (quote received). Cross-checked against quote-vault deltas.
* **Trader.** Swap account #9 `payer` if it signed; otherwise (router PDAs) the signer whose
  base-token balance moved; else the fee payer. Observed on a real router CPI fixture.
* **Fees.** See `FEE_ACCOUNTING.md`. Real pools use both `QuoteToken` and `OutputToken`
  collect modes; with `OutputToken`, buy fees are in the token (recorded, not distributed).
* **Claims.** `EvtClaimCreatorTradingFee` / `EvtClaimTradingFee` on the configured pool.
* **Status.** `is_migrated` / `migration_progress` → `bonding | migrating | migrated`.
* **Verified.** Full-history reconciliation of two real pools matched on-chain counters exactly.

## Raydium LaunchLab — `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj`

* **Events.** `TradeEvent` (self-CPI) from `buy_exact_in|out`, `sell_exact_in|out`. The event has
  no trader field; the trader is the emitting instruction's account #0 `payer` (same signer rule).
* **Amounts.** Buy: `amount_in` gross quote (reserve delta = amount_in − all fees, verified);
  sell: `amount_out` net quote.
* **Fees.** Explicit `protocol_fee`, `platform_fee`, `creator_fee`, `share_fee`, always quote.
  Since the fee-vault upgrade, creator and platform fees move per trade into their vault PDAs —
  verified: vault token deltas equal the event amounts in real transactions.
* **Claims.** `claim_creator_fee` / `claim_platform_fee_from_vault` emit no event; the claimed
  amount is the vault's negative token delta. The indexer therefore also watches the vault.
* **Account decoding.** Byte offsets of `PoolState` and `PlatformConfig` follow the Raydium SDK
  layouts and are cross-checked against `LaunchpadPool.decode` / `PlatformConfig.decode` on real
  account data. (The published IDL lags the deployed `PlatformConfig` layout.)
* **Claim instruction.** Byte-identical to the Raydium SDK's `claimCreatorFee` builder (tested).
* **Shared vaults.** The creator vault aggregates all pools of a creator; the platform vault all
  pools of a platform. Per-event attribution is authoritative; reconciliation checks vault ≥
  expected.

## Transaction versions

Mainnet now carries **version 1** transactions. The indexer requests
`maxSupportedTransactionVersion=1` (configurable) and upgrades automatically when an RPC returns
`-32015`. The normaliser handles legacy, v0 (lookup tables) and v1 (fixture-tested).

## Verification tools

```bash
# Prove attribution == chain accounting over a pool's whole history
bun scripts/verify-fee-attribution.ts meteora_dbc <pool> <mint> creator
bun scripts/verify-fee-attribution.ts find-dbc                       # pick one automatically
# Re-derive a settled round's recipients (and fees) from the chain, using public data only
POOL_ADDRESS=… TOKEN_MINT=… LAUNCH_PROVIDER=… FEE_BENEFICIARY_ROLE=… bun scripts/verify-round.ts <n> --fees
# Refresh real-transaction fixtures
bun scripts/fetch-fixtures.ts
```

## Post-migration (graduation) — REQUIRED before the token graduates

Bonding-curve pools graduate when the curve fills (two of the pools sampled while building this
graduated within minutes). After graduation trading moves to:

* **DBC →** Meteora DAMM v2 (`cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`) or DAMM v1, depending on
  `config.migration_option`.
* **LaunchLab →** Raydium AMM v4 or CPMM (`pool.migrate_type`).

The adapters detect this (`status = migrating|migrated`), publish a `WARN`, surface a degraded pool
status in the UI and stop attributing new fees, so the engine **under**-distributes rather than
guessing. A post-migration adapter must be added before graduation. Its specification:

1. Discover the migrated pool from the migration transaction / metadata accounts
   (DBC: `MeteoraDammMigrationMetadata` or the DAMM v2 pool derived from both mints and config).
2. Decode that program's swap events (DAMM v2 `EvtSwap`; CPMM `SwapEvent`), map buys/sells and the
   trader with the same signer rule.
3. Eligible fees: the project's share of LP fees **of the position(s) it owns** (DAMM v2 position
   NFT / locked LP), which requires tracking position liquidity over time (`fee_a_per_token`,
   `fee_b_per_token` checkpoints), and the creator fee where the AMM supports it (CPMM creator fee).
   Reconcile against `claim_position_fee` / creator-fee claims.
4. Implement `LaunchProvider` for it and register it in `providers/index.ts`; the engine, schema,
   API and UI need no change.

This was intentionally not shipped as a guess: position-based fee entitlement cannot be derived
reliably from swap events alone, and the brief requires documenting such gaps rather than
pretending they work.
