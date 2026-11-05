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

Bonding-curve pools graduate when the curve fills. **Bonding-curve fee logic is not valid after
graduation** — entitlement moves to a different program with a different mechanism, and can even
move to a different party. Verified on mainnet (fixtures `test/fixtures/mainnet/migration-*.json`,
tests `test/migration.test.ts`):

| | Meteora DBC | Raydium LaunchLab |
|---|---|---|
| Destination | **DAMM v2** `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` (`migration_option = 1`); DAMM v1 only for legacy configs | **CPMM** `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` (`migrate_type = 1`) or **AMM v4** (`migrate_type = 0`) |
| Migrated status | `is_migrated = 1`, `migration_progress = 3` (CreatedPool) | `status = 2` (Trade) |
| How the destination is found | the `migration_damm_v2` instruction's account #4 (pool), #5-#10 (two LP positions + NFTs), remaining[0] (DAMM config) | `migrate_to_cpswap` #5 (CPMM pool), #10 (CPMM config); `migrate_to_amm` #13 |
| How it is proven | owner = DAMM v2, both mints, `PDA("pool", config, max(mint), min(mint))`, `pool.creator` = DBC pool authority | owner = CPMM, both mints, `amm_config`, `PDA("pool", config, token0, token1)` |
| Who earns fees afterwards | the holders of the **LP position NFTs**, pro rata to position liquidity (unlocked + vested + permanently locked). The split comes from the DBC config's `creator_/partner_liquidity_percentage`, `*_permanent_locked_liquidity_percentage` and vesting — **not** from `creator_trading_fee_percentage` | **CPMM creator fee** to `pool_creator` (observed: the LaunchLab token creator); a protocol `share_rate` is deducted **at collection**, and collection is permissionless. Locked-LP fee keys go to platform/creator per `platform_scale`/`creator_scale`. AMM v4 has no creator fee |
| Exact accounting | `claimable = fee_pending + liquidity × (fee_per_liquidity − checkpoint) >> 128` (reproduces the pool's `total_lp_fee` to 2 base units on the fixture); claims via `EvtClaimPositionFee` | creator fees accrue in `creator_fees_token_{0,1}`; `SwapEvent.creator_fee` is the gross accrual, the received amount = accrual − ⌊accrual × share_rate / 1e6⌋ at collection time |

Real example: the fixture DBC config has `creator_trading_fee_percentage = 0` (the creator earned
nothing while bonding — the indexer now warns about such configs) yet gave the creator 89% liquid +
11% vesting LP, i.e. ~100% of LP fees after graduation, and `collect_fee_mode = BothToken`, so most of
that fee value accrues in the token rather than SOL.

### What is implemented now (`providers/migration.ts`)
* `findMigration` / `parseMigration` — locate the migration transaction of a bonding pool.
* `verifyMigration` — prove the destination (checks above), resolve the DAMM v2 position NFT holders
  and their claimable fees with the program's own formula.
* The indexer records the verified destination on the pool document (`pools.migration`, visible in
  the admin status) and publishes it in the terminal as soon as the pool reports `migrated`.
* `scripts/resolve-migration.ts` — operator check; `scripts/fetch-migration-fixtures.ts` — evidence.

### Still required before attributing post-graduation fees
1. A `LaunchProvider` for the destination program that decodes its swap events (DAMM v2 `EvtSwap2`,
   CPMM `SwapEvent`) for **buyer** tracking (same signer rule as today).
2. Position/checkpoint-based **fee** accounting: at each snapshot read `(pool, positions)` with
   `minContextSlot = snapshotSlot` and attribute `Δ(claimable + claimed)` of the positions held by
   the beneficiary; for CPMM, attribute creator fees net of the current `share_rate` and true up from
   the actual collection (token deltas), since the rate is applied at collection.
3. Non-SOL fees (BothToken / token-side) recorded but not distributed, as today.
4. Switching providers at graduation: the scheduler now includes the bonding pool's indexed activity
   in the first post-switch period (`rounds.config.previousPool`), so the final bonding-curve trades
   are not dropped.
