# Launch providers

`LAUNCH_PROVIDER` selects the adapter; nothing else in the system changes. Both adapters were
built from the programs' official IDLs (vendored in `packages/engine/src/providers/*/idl/`) and
validated against real mainnet transactions and account data (`test/fixtures/mainnet/`).

```
LAUNCH_PROVIDER=meteora_dbc        FEE_BENEFICIARY_ROLE=creator|partner
LAUNCH_PROVIDER=raydium_launchlab  FEE_BENEFICIARY_ROLE=creator|platform
LAUNCH_PROVIDER=pump_fun           FEE_BENEFICIARY_ROLE=creator
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
* **Pool from the mint.** The pool is the PDA `["pool", config, max(base, quote), min(base, quote)]`,
  so it depends on the launch config. Leave `POOL_ADDRESS` empty: once the token is launched the
  indexer finds its `VirtualPool` by `base_mint` (`getProgramAccounts` memcmp at byte 136), re-derives
  it from its own config and remembers it for that mint (`providers/meteora/pda.ts`).
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
  amount is the sum of the transfers out of the vault executed by that claim instruction (never the
  vault's net change over the whole transaction). The indexer also watches the vault.
* **Creator fee rate.** `PlatformConfig.creator_fee_rate` is a fee rate in millionths of the trade
  value, added to the total fee rate — not a share of the other fees (see `FEE_ACCOUNTING.md` §2).
* **Account decoding.** Byte offsets of `PoolState` and `PlatformConfig` follow the Raydium SDK
  layouts and are cross-checked against `LaunchpadPool.decode` / `PlatformConfig.decode` on real
  account data. (The published IDL lags the deployed `PlatformConfig` layout.)
* **Claim instruction.** Byte-identical to the Raydium SDK's `claimCreatorFee` builder (tested).
* **Shared vaults.** The creator vault aggregates all pools of a creator; the platform vault all
  pools of a platform. Per-event attribution is authoritative; deposits of other pools are recorded as
  excluded `shared_vault_inflow` records so reconciliation can compare exactly.

## pump.fun — `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` (bonding curve) → PumpSwap `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`

Built from the official IDLs (`@pump-fun/pump-sdk` 4.3.1 / `@pump-fun/pump-swap-sdk` 2.2.0, vendored in
`providers/pumpfun/idl/` and `providers/destination/idl/`) and verified on real mainnet transactions
(`test/fixtures/mainnet/pumpfun-*.json`, `test/pumpfun.test.ts`). Only SOL-quoted coins, role `creator`.

* **Pool from the mint.** The "pool" is the coin's bonding curve, the PDA `["bonding-curve", mint]`
  (derived, even before launch). Leave `POOL_ADDRESS` empty.
* **Mint from the creator wallet.** A pump.fun mint is only known once the coin exists, so with pump.fun
  selected and no token mint set, the indexer watches the creator wallet (`LAST60_CREATOR_WALLET_*` or the
  admin-console vault wallet) and sets the mint itself (`providers/pumpfun/launchDetect.ts`). Every ~5 s it
  reads the wallet's NEW signatures and looks for a pump.fun `create` / `create_v2` that **the wallet
  signed**, whose `CreateEvent` names the wallet as `user` and `creator`, and whose bonding curve is the
  canonical PDA of the mint. (`create` takes the creator as an argument, so anyone can name any wallet as a
  creator; only the wallet's own signature proves the launch is ours.) The mint is remembered per creator
  wallet (system_state `pool_discovery`, key `pump_fun_launch:<creator>`) and shown as "detected from the
  creator wallet". Use a **fresh, dedicated** creator wallet: a wallet with more than 2 000 signatures, or
  one that launched two coins, is refused with a waiting message (set the mint by hand then). This also
  keeps the shared creator vaults (keyed by creator, not by coin) to one coin. A mint set in the admin
  console wins; an environment `TOKEN_MINT` applies to pump.fun only when the environment selects
  `LAUNCH_PROVIDER=pump_fun` (another provider's token never carries over).
* **Events.** Every trade instruction (`buy`, `buy_exact_sol_in`, `sell`, their `_v2` / `_v3` forms,
  `multi_hop_curve_swap` hops) emits one `TradeEvent` (self-CPI) with the mint, the trader (`user`),
  the protocol `fee`, the coin's `creator` and its `creator_fee`.
* **Amounts.** `sol_amount` excludes fees: a buyer pays `sol_amount + fee + creator_fee`, a seller
  receives `sol_amount − fee − creator_fee` (lamport deltas of real trades match). The buyback fee is a
  slice of `fee`.
* **Where the creator fee goes.** Legacy and `_v2` trades pay it into the creator vault
  `["creator-vault", creator]` (native lamports) in the trade. `_v3` trades — most of today's volume —
  leave it on the curve (`BondingCurve.creator_fee`) until the permissionless `sweep_creator_fee`
  (pump.fun runs a crank; the claim also sweeps). Attribution is always per trade, from the event.
* **Shared vault.** The vault is keyed by the creator: all their coins pay into it. Other coins'
  deposits are recorded as excluded `shared_vault_inflow` records (computed from the vault's lamport
  change minus this coin's own deposits, so reconciliation is exact); a plain top-up (e.g. a rent floor)
  is recorded as `creator_vault_top_up`. Use a dedicated creator wallet per launch.
* **Claims.** `collect_creator_fee` pays the vault above its rent floor (read from the RPC; 650 240
  lamports today) to the creator and emits `CollectCreatorFeeEvent`. It is permissionless and always
  pays the creator wallet. The claim plan is `sweep_creator_fee` (if the curve holds fees) +
  `collect_creator_fee`; when the destination is another wallet (legacy policy) the amount claimable at
  build time is forwarded in the same transaction — fees of trades landing in between stay in the
  creator wallet.
* **Allocation.** pump.fun sets the creator fee rate itself (pump-fees schedule, per trade in the
  event), so the declaration is the identity: the curve's `creator` must equal
  `EXPECTED_PUMPFUN_CREATOR` (default: the configured creator wallet). Holder-reward and cashback coins
  pay the creator fee to holders / traders and are never distributable; a trade whose event names
  another creator (e.g. after fee sharing or a CTO) is recorded and excluded.
* **Graduation.** `migrate` / `migrate_v2` name the PumpSwap pool. It is verified strictly: PumpSwap
  owner and `Pool` discriminator, mints, the canonical PDA `["pool", 0, pool_authority(mint), mint, quote]`,
  created by the coin's pool authority, quote vault owned by a token program. The creator receives no LP.
* **PumpSwap.** `BuyEvent` / `SellEvent` carry `coin_creator` and the exact `coin_creator_fee` (final
  at the trade — nothing is withheld at collection). Legacy trades pay the coin creator vault (the
  WSOL account of `["creator_vault", coin_creator]`), `_v2` trades leave it in the pool
  (`Pool.creator_fees`) until `sweep_creator_fee`. `collect_coin_creator_fee` pays the vault to the
  creator (`CollectCoinCreatorFeeEvent`). After graduation one claim transaction collects both vaults,
  as pump.fun's own claim does, and unwraps the WSOL.
* **Not observed live end-to-end**: no reward round on a real pump.fun launch has been run yet.
  `migrate` (v1) and `multi_hop_*` are implemented from the IDL; the fixtures cover `migrate_v2` and
  the single-hop trades.

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
bun scripts/fetch-pumpfun-fixtures.ts
```

## Post-migration (graduation)

Bonding-curve fee logic is not valid after graduation: trading moves to another program with a
different fee mechanism. Asteroid Protocol handles it as follows (code: `providers/migration.ts`,
`providers/destination/`, `providers/MigrationAwareProvider.ts`, `providers/migrationAttach.ts`).

1. **Detect** — the bonding pool reports migrated (DBC `is_migrated`, LaunchLab `status = 2`).
2. **Find** — the successful migration instruction in the bonding pool's history names the
   destination (DBC `migration_damm_v2` #4 pool, #5–#10 positions, remaining[0] config; LaunchLab
   `migrate_to_cpswap` #5 pool, #10 config, plus the `lock_cp_liquidity` CPIs).
3. **Verify strictly** — `verifyMigration` returns verified only if **every** required check for the
   kind holds (not merely "the account exists with the right owner"):

| Check | DBC → DAMM v2 | LaunchLab → CPMM |
|---|---|---|
| destination program in the instruction and as account owner | ✔ | ✔ |
| account layout: exact size + Anchor discriminator | ✔ (`Pool`, 1112 B) | ✔ (`PoolState`, 637 B) |
| both mints = launch token + quote | ✔ | ✔ |
| PDA derivation from (config, mints) | ✔ `["pool", config, max, min]` | ✔ `["pool", config, token0, token1]` |
| config relationship | config owned by DAMM v2 with `Config` discriminator | `amm_config` = instruction config = the platform's `cp_config`, owned by CPMM with `AmmConfig` discriminator |
| authority / creator relationship | pool creator = DBC pool authority; positions valid (owner, size, discriminator, pool, NFT mint) and held by the DBC creator or partner | `pool_creator` = token creator or the platform's CPMM creator |
| fee-account relationship | NFT holders resolved for every position | LP-lock accounts owned by the lock program and locking this pool's LP mint |
| provenance | signature + slot of the migration tx | same |

4. **Persist** — `pools.migration` = `{status: verified | unverified | unsupported, checks, failed,
   spec}`; the indexer announces the outcome in the terminal.
5. **Attach** — only a verified, supported migration produces a destination *spec*; the indexer and
   the rewards worker attach the same adapter from it. Unverified or unsupported migrations never
   enter accounting.

### Support matrix

| Source → destination | Verification | Buyer tracking | Creator fee accounting | Status |
|---|---|---|---|---|
| Meteora DBC (bonding) | pool owner, base mint, config, payout asset | ✔ `EvtSwap3`/`EvtSwap2` | ✔ per swap, program formula; reconciled exactly vs `creator_*_fee` | **Implemented**, mainnet-verified |
| Raydium LaunchLab (bonding) | pool owner, base mint, platform config, payout asset | ✔ `TradeEvent` | ✔ per trade `creator_fee` (cross-checked with the vault transfer); claims per instruction; shared vault exact | **Implemented**, mainnet-verified |
| DBC → **DAMM v2** | strict (above) | ✔ `EvtSwap2` | ✔ fee growth of creator-held migration positions (checkpointed per snapshot); claims via `EvtClaimPositionFee` | **Implemented**; verified offline on real mainnet transactions/accounts; **not yet observed live end-to-end** |
| LaunchLab → **CPMM** | strict (above) | ✔ instruction transfers (+ log `SwapEvent` for fee detail) | ✔ CPMM creator fee as collected to the creator; ✔ locked-LP fees collected from the creator's migration lock | **Implemented**; swap and creator-fee collection verified on real mainnet transactions; LP-lock collection verified on synthetic transactions only (no creator-lock collection observed on mainnet yet) |
| pump.fun (bonding) | curve PDA of the mint, owner, SOL quote, creator = declared wallet | ✔ `TradeEvent` | ✔ per trade `creator_fee`; shared vault exact | **Implemented**; verified offline on real mainnet transactions; **not yet observed live end-to-end** |
| pump.fun → **PumpSwap** | strict (canonical pool PDA, pool authority, mints, layout) | ✔ `BuyEvent` / `SellEvent` | ✔ per trade `coin_creator_fee`; claims via `CollectCoinCreatorFeeEvent` | **Implemented**; verified offline on real mainnet transactions; **not yet observed live end-to-end** |
| DBC → DAMM v1 | — | ✗ | ✗ | **Unsupported**: layouts and the lock-escrow fee model are not verified here; marked unverified, never accounted |
| LaunchLab → AMM v4 | — | ✗ | ✗ (AMM v4 has no creator fee) | **Unsupported**: marked unverified, never accounted |

Notes (round 3):
* No path is "proven live": no reward round across a real graduation has been run and independently
  verified. Supported means implemented and verified offline on real mainnet transactions.
* LaunchLab locked LP: since the 2026-08-17 Raydium upgrade, migrations assign `creator_scale` to the
  platform's single Fee Key; a creator LP entitlement exists only if the migration transaction minted
  a creator lock (read from that transaction, never inferred from `creator_scale`). Observed on
  mainnet (platform `4Bu96XjU…`, `creator_scale` 100 000): the last creator-owned Fee Key was minted at
  slot 439 305 681 (2026-08-14), every migration from slot 440 109 663 (2026-08-18) minted it to the
  platform NFT wallet. Locks minted to `platform_nft_wallet` are labelled platform-owned
  (`platform_owned_locked_lp`) even when the creator IS that wallet (Forgepad's fee and NFT wallet are
  the same address).
* Reattachment: both workers attach only the persisted, verified spec of THIS launch
  (`storedSpecProblems`); a verified spec is never rewritten on restart; a different graduation for
  the same launch is recorded as `conflict` and detached until an operator reviews it.

### Facts verified for the destinations

* **DAMM v2** (IDL `cp_amm` 0.2.5, vendored in `providers/destination/idl/`): fees are taken on the
  output token in `BothToken` mode and always in token B in `OnlyB`/`Compounding` mode. Positions
  receive only the `claiming_fee` (LP) part via `fee_{a,b}_per_liquidity`; protocol, partner,
  referral and compounding fees never reach positions. At migration DBC hands one position to the
  pool creator and (if configured) one to the partner (`fee_claimer`), ordered by liquidity.
* **CPMM** (IDL `raydium_cp_swap` 0.2.0, vendored): `SwapEvent` is emitted through the log (`emit!`),
  with `trade_fee` and `creator_fee`. Creator fees accrue in `creator_fees_token_{0,1}`; at
  collection the protocol keeps `⌊accrued × creator_fee_share_rate / 10⁶⌋` (AmmConfig or a per-creator
  override) — so accruals are `estimated` and only the collected transfer is payable. On the real
  example the CPMM `pool_creator` is the LaunchLab creator, `creator_fee_rate` = 14 950 and the share
  rate 50 000 (millionths); the platform locked 100 % of the LP to itself (`creator_scale` = 0), so the
  creator has no migrated-LP entitlement there.
* **CPMM `creator_fee_on`** (PoolState byte 389; raydium-cp-swap `CreatorFeeOn`): `0` both tokens (fee on
  the swap's input), `1` only token 0, `2` only token 1. Decoded, verified and persisted through the
  verified migration, the destination spec, the basis snapshot and the reports; any other value makes
  the CPMM creator-fee basis unverifiable. The real example pool uses `1` (token 0 = WSOL).
* **CPMM `CreatorFeeShare`** (raydium-cp-swap `states/creator_fee_share.rs`): PDA
  `["creator_fee_share", pool_creator, amm_config]`, 145 bytes; when it exists and is CPMM-owned its
  `share_rate` overrides `AmmConfig.creator_fee_share_rate`, else the default applies. The real
  collection fixture passes exactly this PDA (account #15) and it was empty (default 50 000 applied).
  22 overrides exist on mainnet (all rate 0, one creator), one on Forgepad's AmmConfig. Verification
  records the default, the override and the effective rate with the slot read
  (`test/fixtures/mainnet/cpmm-creator-fee-share.json`, `bun run fixtures:cpmm-fee-share`).
* A real creator-fee collection moved 1 683 458 372 lamports to the creator while the creator's
  token account changed by only 1 090 712 680 over the whole transaction (a later instruction moved
  part of it) — the reason all claims and collections are measured per instruction.

### Tools

```bash
bun scripts/resolve-migration.ts <meteora_dbc|raydium_launchlab> <bondingPool> <baseMint> [role]   # exit 0 = verified
bun scripts/fetch-migration-fixtures.ts <provider> <bondingPool> <out.json> [rpc] [--augment]
bun scripts/fetch-destination-fixtures.ts <dammv2|cpmm> <destinationPool> <out.json> [accounts]
```
