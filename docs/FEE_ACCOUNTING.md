# Fee accounting

> **Phase-aware reward funding (PR #6)** — Forge's two-phase business model (bonding-curve creator
> fees 25 % creator / 75 % Last-60 of what is collected; CPMM creator fees direct creator revenue;
> Forge platform LP claims 50 % Last-60 / 50 % Forge), its seven revenue streams, claim ↔ transfer
> correlation and the versioned funding policy are specified in [REWARD_FUNDING.md](REWARD_FUNDING.md).
> This document remains the specification of creator-allocated fee attribution, which the default
> `legacy_creator_fee_v1` policy distributes unchanged.

LAST60 distributes **fees, never volume** — and only the fees that on-chain configuration and
position ownership actually **allocate to the token creator** (more generally: to the configured
beneficiary). Eligible creator fees are tracked and allocated for payouts; payouts are based on
verified creator fee allocations. LAST60 never uses a pool's gross fees, protocol fees, partner or
platform fees, or other liquidity providers' fees as creator earnings, and never counts LP
principal as earned fees.

All arithmetic is integer base units (`bigint` in code, `Decimal128` in MongoDB). Floats appear only
in UI animation.

## 1. The attribution model

Every fee record carries the same provenance fields, whether it is a decoded trade (`swaps`) or a
non-trade fact (`fee_attributions`: LP-position checkpoints, fee collections, shared-vault inflows of
other pools, unresolved observations). Code: `packages/engine/src/accounting/attribution.ts`.

| Question | Field(s) |
|---|---|
| Chain / provider | `chain` (solana), `provider` |
| Source pool / destination pool | `sourcePool`, `pool` / `destinationPool` |
| Creator (beneficiary) wallet | `beneficiary` |
| Fee asset and amount | `eligibleFeeMint` + `eligibleFee` (swaps), `feeMint` + `creatorAmount` (attributions) |
| Phase | `feePhase` / `phase`: `bonding_curve`, `post_migration_trading`, `migrated_lp` |
| Gross fee (when observable) | `totalFee` / `grossAmount` |
| Creator-allocated amount | `eligibleFee` / `creatorAmount` |
| Excluded amount and reason | `excludedFee` / `excludedAmount`, `excludedReason` |
| Transaction and slot | `signature`, `slot` (+ `observedSlot` for checkpoints) |
| Evidence (account, position, instruction) | `evidence` |
| Certainty | `feeStatus` / `status`: `estimated`, `observed`, `collected`, `reconciled`, `confirmed`, `unresolved` |
| Payout eligibility | `payoutEligible` |
| Allocation basis | `basisId` + immutable `basis` snapshot (v1, on **both** collections): provider, source pool, destination pool, phase, role, beneficiary, on-chain parameters, source accounts, verification, problems, stable basis id |

Rules:

* **Only distributable creator-allocated amounts are paid.** `periodFees` sums `eligibleFee` of swaps
  and `creatorAmount` of attributions that pass ALL of (first failure names the reason):
  1. `payoutEligible = true` (decided at ingestion);
  2. evidence status final — `observed`, `collected`, `reconciled` or `confirmed` (`fee_status_*`);
  3. an immutable v1 `basis` snapshot (`legacy_record_without_allocation_snapshot`);
  4. a basis **verified** against an operator declaration — in its snapshot, or because its id is one
     of the bases the loaded provider verifies now (`allocation_<verification>_not_verified`). The id
     hashes provider, pool, phase, role, beneficiary and every on-chain parameter, so the same id is
     the same basis.

  Everything else is recorded per round as `ineligibleFees` and as `FEE_EXCLUDED` ledger entries
  (never paid). The bases used and their verification are stored on the round
  (`feeBreakdown.bases`, `feeBreakdown.verifiedBasisIds`) and reused by reconciliation.
* **`estimated` is never payable** (e.g. a CPMM creator-fee accrual whose final amount is decided at
  collection). **`unresolved`** marks anything that cannot be proven from chain data; no amount is
  invented for it.
* **Idempotent and durable.** Swaps are keyed `(signature, eventIndex)`, claims `(signature, index)`,
  attributions by a unique `key`; all writes are `$setOnInsert`, so the first observation wins and
  re-processing never double counts or reinterprets a record.
* **Historical basis is immutable.** Each record stores the complete basis it was generated under,
  written once. Model middleware rejects any later `$set` / `$unset` / … of a record's basis, amounts,
  eligibility, status, phase, pools, beneficiary or evidence; only bookkeeping fields (round number,
  finality / drop state, block position) change. A record naming a basis the loaded provider cannot
  produce is stored with `excludedReason = allocation_basis_snapshot_unavailable` and never paid.
  Role / beneficiary / provider changes over existing history are refused — see §6.

## 2. Where creator allocations come from

### Meteora Dynamic Bonding Curve

| Phase | Creator allocation | Evidence | Excluded |
|---|---|---|---|
| Bonding curve | `⌊trading_fee × creator_trading_fee_percentage / 100⌋` per swap (program `split_partner_and_creator_fee`) | `EvtSwap3` (fallback `EvtSwap2`) of the swap instruction; `PoolConfig.creator_trading_fee_percentage` | protocol fee, referral fee, the partner's complement |
| After migration (DAMM v2) | LP fee growth of the migration-created **positions whose NFT the creator holds**: `pending + liquidity × Δfee_per_liquidity >> 128`, plus fees already claimed | position + pool accounts read at each snapshot (`minContextSlot = snapshot slot`); position NFT holder | positions held by anyone else (partner, buyers of the NFT), protocol / partner / referral / compounding fees (never reach positions) |

The DBC config's LP split (`creator_liquidity_percentage + creator_permanent_locked_liquidity_percentage
+ vesting`) decides how much liquidity the creator's position receives at migration; the accounting
uses the **actual positions**, not the percentage.

### Raydium LaunchLab

| Phase | Creator allocation | Evidence | Excluded |
|---|---|---|---|
| Bonding curve | `TradeEvent.creator_fee` | event of the trade instruction, cross-checked against that instruction's transfer into the creator fee vault (a disagreement makes the trade `unresolved`) | protocol, platform and share fees |
| After migration (CPMM) — creator fee | the exact amount **transferred to the pool creator by a `collect_creator_fee(_permissionless)` instruction**, when the CPMM `pool_creator` is the creator, the verified `creator_fee_on` mode and the effective creator-fee share rate are established | collection instruction's own token transfers; PoolState `creator_fee_on`; AmmConfig default share rate and the per-creator `CreatorFeeShare` override (REWARD_FUNDING.md §6) | the protocol's creator-fee share retained at collection (override if present, else AmmConfig); collections to anyone else |
| After migration (CPMM) — migrated LP | LP fees collected (`collect_cp_fees`, Raydium LP-lock program) from the lock whose fee-key NFT was **minted to the creator at migration**, signed by and paid to the creator | migration transaction's `lock_cp_liquidity` CPIs; collection instruction's transfers | the platform's lock, collections by a different fee-key holder, LP principal (permanently locked) |

**`creator_fee_rate` is a fee rate, not a share.** `PlatformConfig.creator_fee_rate` is expressed in
millionths of the **trade value** and is *added* to the total fee rate: the program charges
`total_fee = ⌈amount × Σrates / 10⁶⌉` and splits it pro rata to the rates (Raydium SDK
`Curve.splitFee`). A rate of 5 000 therefore means the creator receives ≈ 0.5 % **of the traded
amount**, not 0.5 % of the other fees. Exact formula (`launchLabFeeSplit`):

```
Σ            = protocol (GlobalConfig.trade_fee_rate) + platform (PlatformConfig.fee_rate)
               + creator (PlatformConfig.creator_fee_rate) + share (instruction argument)      — millionths
total_fee    = ⌈amount × Σ / 1 000 000⌉        buy: quote in; sell: gross quote out
platform_fee = ⌊total_fee × platform / Σ⌋     share_fee = ⌊total_fee × share / Σ⌋
creator_fee  = ⌊total_fee × creator / Σ⌋      protocol_fee = total_fee − the three (rounding remainder)
```

Independently verified (`test/launchlab-fee-semantics.test.ts`): identical to the Raydium SDK's own
`Curve.calculateFee` / `splitFee` over a grid of amounts and rates; **bit-exact** on a real mainnet
`TradeEvent` (slot 465 800 122) with its real PlatformConfig (`fee_rate` 7 500, `creator_fee_rate`
**500** = 0.05 %; the event admits exactly one integer Σ = 10 500, proving the protocol rate 2 500):
creator 27 894 lamports on a 55 789 550-lamport buy — 0.05 % of the trade, whereas 0.05 % of the
total fee would be 292. Raydium's documentation (raydium-docs-v1 `products/launchlab/platform-config`)
gives `MAX_CREATOR_FEE_RATE = 5000` (50 bps). The LaunchLab program source is not public; the
deployed layouts used are the published IDL and SDK, cross-checked on mainnet accounts. Accounting
never recomputes the fee: it uses `TradeEvent.creator_fee`, cross-checked with the vault transfer.

`creator_scale` (millionths of migrated LP) **is not a creator entitlement**: since the 2026-08-17
LaunchLab upgrade, `create_platform_config` and the `MigrateNftInfo` update require
`creator_scale = 0`, and migrations executed after the upgrade fold `platform_scale + creator_scale`
into ONE Fee Key minted to `platform_nft_wallet` (including launches created before the upgrade;
older configs such as Forgepad's still store a positive value). The creator's migrated-LP entitlement
is taken only from the lock records of the actual migration transaction
(`classifyLaunchLabLocks`): it is **proven** only for the pre-upgrade layout — the creator is not the
platform NFT wallet, exactly one lock minted to the creator, the expected number of platform locks,
lock amounts in the `platform_scale : creator_scale` ratio, and a migration slot before the observed
upgrade boundary. Anything else is `unverifiable` and never paid. Locks minted to `platform_nft_wallet`
are platform-owned (`excludedReason = platform_owned_locked_lp`) even when the creator is that wallet.
Mainnet evidence (platform `4Bu96XjU…`, `creator_scale` 100 000; 423 migrations): the creator Fee Key
was minted to the creator up to slot 439 305 681 (2026-08-14) and to the platform NFT wallet from slot
440 109 663 (2026-08-18) on (`test/fixtures/mainnet/forgepad-platform-config.json`).

### 2a. Forgepad's LaunchLab PlatformConfig (decoded on mainnet)

Account `5zZFa8KitVsp3qGDvCQeDZgn5YEKxAASA5EQTjVzobcX`, supplied by the Forgepad owner. Read with
`getAccountInfo` (finalized) at slot 466 137 980; owner `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj`
(Raydium LaunchLab; ProgramData `D2QX47Tv…`, last deployed slot 446 221 802 = 2026-09-11); 944 bytes,
discriminator `PlatformConfig`; bytes 832–944 all zero. Decoded identically by the repo decoder, the
bundled Anchor IDL (raydium_launchpad 0.2.0) and the Raydium SDK 0.2.82-alpha `PlatformConfig` layout
(`test/forgepad-launchlab.test.ts`). Reproduce: `bun run verify:platform-config`.

| Field | Value | Units / meaning |
|---|---|---|
| `epoch` | 969 | Solana epoch of the last update (≈ 2026-05; before the 2026-08-17 `creator_scale = 0` rule) |
| `platform_fee_wallet` | `8KXqQwtrgtKxNfTWYsN34XNKXVQQR78JZfgbLorNL2n1` | claims the bonding-curve platform fee |
| `platform_nft_wallet` | `8KXqQwtr…` (same) | receives the platform locked-LP Fee Key |
| `platform_scale` / `creator_scale` / `burn_scale` | 500 000 / 500 000 / 0 | millionths of migrated LP; post-upgrade: 100 % locked under ONE platform Fee Key, nothing burned |
| `fee_rate` | 10 000 | millionths of trade value: **1 %** bonding-curve platform fee |
| `creator_fee_rate` | 5 000 | millionths of trade value: **0.5 %** bonding-curve creator fee (the program maximum) — not a share of the platform fee |
| `name` / `web` / `img` | Forge / https://forgepad.fun / https://i.postimg.cc/76TzYyFW/Forge-X-Logo.png | branding |
| `cpswap_config` | `C7Cx2pMLtjybS3mDKSfsBj4zQ3PRZGkKt7RCYTTbCSx2` | CPMM AmmConfig (index 3): `trade_fee_rate` 40 000, `protocol_fee_rate` 120 000, `fund_fee_rate` 40 000, **`creator_fee_rate` 500** (0.05 % of swap value), `creator_fee_share_rate` 50 000 (5 % of the accrued creator fee kept by the protocol at collection) |
| `transfer_fee_extension_auth` | `8KXqQwtr…` | Token-2022 transfer-fee authorities |
| `platform_vesting_wallet` / `platform_vesting_scale` | `8KXqQwtr…` / 0 | no platform token vesting |
| `platform_cp_creator` | default | the **launch creator** becomes the CPMM `pool_creator` (receives CPMM creator fees) |
| `restrict_global_config` / `restrict_curve_param` / `curve_rule_manager` | 0 / 0 / default | no allowlist / curve rules (no fee effect) |

Accounting interpretation (`interpretPlatformConfig`):

| Stream | Beneficiary | Status | LAST60 |
|---|---|---|---|
| Bonding-curve platform fee (1 % of trade) | `8KXqQwtr…` | confirmed by this config | never paid (platform revenue) |
| Bonding-curve creator fee (0.5 % of trade) | the pool's `creator` | rate confirmed; the creator wallet needs the pool | distributable when `EXPECTED_LAUNCHLAB_PLATFORM_CONFIG` **and** `EXPECTED_LAUNCHLAB_CREATOR_FEE_RATE` match the pool |
| Post-graduation CPMM creator fee (0.05 % of swap, minus 5 % protocol share at collection) | CPMM `pool_creator` = launch creator | needs the migration tx | distributable only with a verified migration (pool_creator = creator, creator fee enabled) and a verified bonding basis |
| Platform-owned locked LP (100 % of migrated LP) | `8KXqQwtr…` | confirmed | never paid |
| Creator-owned locked LP | — | none under the current program | only with a creator Fee Key proven by the migration tx; never from `creator_scale` |

Forgepad's DBC allocation (25 % platform / 75 % creator, pre-bond and post-migration) is **not**
applied to LaunchLab: there creator : platform bonding fees are 5 000 : 10 000 = 1 : 2 of trade value.
Not yet verified for any specific Forgepad launch: the pool's creator wallet, the protocol rate of the
GlobalConfig it selected, its migration transaction (CPMM pool_creator, `enable_creator_fee`,
`creator_fee_on`, lock records) — check them with `bun run verify:allocation` once a pool exists.

**The creator fee vault is shared** by every pool of a creator with the same quote mint. Deposits
from the creator's *other* pools are indexed (the vault is watched) and recorded as
`shared_vault_inflow` attributions with `excludedReason = shared_vault_other_pool`, never attributed
to this pool. Claims are measured per claim instruction from its own transfers out of the vault, so
a claim and a trade (or two claims) in one transaction are never conflated (U4).

### Assets other than the payout asset

DBC `OutputToken`/`BothToken` modes, DAMM v2 `BothToken` and CPMM fee-on-input modes can allocate fees
in the launched token. They are recorded (`nonPayoutAssetFees`, `FEE_NON_PAYOUT_ASSET`) but never
distributed or converted. SPL payouts are allowed only when `PAYOUT_ASSET` equals the pool's quote
mint.

## 3. Verifying the allocation (never assumed)

Nothing is hard-coded and nothing is inferred from the provider name. On load each adapter reads the
pool and its configuration and builds an **allocation basis** (`PoolInfo.allocation`). Operators may
declare the allocation they expect (Forgepad sets its own configuration; LAST60 checks it):

```
EXPECTED_DBC_CREATOR_TRADING_FEE_PERCENTAGE   EXPECTED_DBC_CREATOR_LP_PERCENTAGE
EXPECTED_LAUNCHLAB_PLATFORM_CONFIG            EXPECTED_LAUNCHLAB_CREATOR_FEE_RATE
EXPECTED_LAUNCHLAB_CREATOR_LP_SCALE
```

The LaunchLab bonding basis is `verified` only when the pool's PlatformConfig **and** its
`creator_fee_rate` both match (a rate alone is not an identity: `EB2LqTh8…` also uses 5 000). Either
missing → `not_declared`. `EXPECTED_LAUNCHLAB_CREATOR_LP_SCALE` declares the `creator_scale` *value*
only; it never makes locked-LP fees distributable.

| Result | Effect |
|---|---|
| `verified` | on-chain value equals the declaration; fees **distributable** |
| `not_declared` | no declaration; fees recorded with the on-chain value and reported (`NOT DECLARED` pool warning, `allocation_not_declared_not_verified` in the round) but **never distributed** — `not_declared` is never presented as verified |
| `mismatch` / `unverifiable` | pool flagged (`ALLOCATION MISMATCH` warning, admin status, terminal); fees **recorded from chain** but `payoutEligible = false` — the declared value is never substituted |

The CPMM creator-fee basis has no declaration of its own: it is `verified` only when the pool facts
prove the beneficiary is the CPMM `pool_creator` with the creator fee enabled **and** the LaunchLab
bonding allocation was verified; otherwise `not_declared` / `unverifiable`. Roles other than
`creator` have no declarable allocation and are therefore recorded but never distributed.

**Operator report.** `bun run verify:allocation` (read-only: `getAccountInfo`, and for a graduated
pool `getSignaturesForAddress` / `getTransaction`) prints, per allocation: the declared value, the
on-chain value, Forgepad's intended target, the beneficiary, the fee mint(s) and the outcome; exit
code 0 verified · 2 mismatch / unverifiable · 3 not declared. `--forgepad` fills undeclared values
with Forgepad's values (DBC 75 % / 75 % creator — the owner's 25 / 75 split; LaunchLab: PlatformConfig
`5zZFa8Ki…`, `creator_fee_rate` 5 000, `creator_scale` 500 000 as decoded on-chain) — values to check,
never assumed for any pool. LaunchLab rows that need a migration (creator Fee Key, CPMM creator fee)
are shown as *pending launch evidence* and excluded from the outcome until a verified migration
exists; after one, "no creator Fee Key" is reported as *no entitlement*. `--json` for machines.

`bun run verify:platform-config [ADDRESS] [--pool POOL] [--json]` (read-only, `getAccountInfo` only)
decodes and validates a PlatformConfig (default: Forgepad's) and its CPMM AmmConfig, explains every
field and fee stream, and exits 0 validated · 2 missing · 3 wrong owner · 4 unsupported layout /
ambiguous decode / out-of-range values · 5 invalid cpswap_config · 6 pool not bound to it.

The beneficiary wallet comes from chain state (`pool.creator`, DBC `fee_claimer`, LaunchLab platform
fee wallet). For migrated LP, the basis also lists which positions / locks belong to the beneficiary.

## 4. Periods: no gaps, no double counting — across graduation

A round's reward period is the slot range `(previous snapshot slot, this snapshot slot]`; periods
tile the chain. A launch's accounting pools are the bonding pool plus, **once the migration is
verified**, the destination pool (`PoolInfo.accountingPools`). Therefore:

* the final bonding-curve trades and the first destination trades fall into consecutive periods by
  slot; nothing is counted twice (records are keyed) and nothing is dropped;
* destination activity cannot predate the destination pool (records before the migration slot are
  anomalies); the destination is indexed from the migration slot;
* DAMM v2 position checkpoints are written at the snapshot with accounting slot = snapshot slot and
  the read slot in `observedSlot`; consecutive cumulative deltas tile exactly (fees read slightly after
  the snapshot are simply not counted again in the next period);
* checkpoint records are keyed by snapshot slot, so a resumed execution reuses them;
* migration processing is idempotent and never rewrites history: both workers attach the **persisted**
  spec only after checking it belongs to the loaded launch (supported path, provider, bonding pool,
  beneficiary, role, mints, migration signature, every required check true); re-resolution of the
  same graduation keeps the original spec and its allocation snapshots; a *different* graduation for
  the same launch is recorded as `conflict` and detaches the destination (operator review).

## 5. Allocation (`packages/engine/src/rewards/allocation.ts`)

```
rewardShare = ⌊fees × REWARD_BPS / 10_000⌋
retained    = fees − rewardShare
pool        = rewardShare + funding + rolloverIn      funding = verified Last-60 contributions (phase-aware policy; 0 under legacy)
per         = ⌊pool / n⌋          dust = pool − per × n   (retained, recorded)
n = 0 or per < MIN_PAYOUT_LAMPORTS → no payouts; pool → rolloverOut (rollover) or retained (retain)
```
`fees` is the period's **distributable creator allocation** only (§1). `REWARD_BPS`
(`REWARD_PERCENTAGE=75` → 7 500) is LAST60's split of those fees between buyer rewards and retained
funds; it is unrelated to the creator's on-chain allocation percentage, the LaunchLab creator fee
rate, or the creator's migrated-LP share — and it is **not** the bonding-curve 75 % or the Forge LP
50 %, which are source-specific policy parameters applied to collected amounts (REWARD_FUNDING.md).
`REWARD_BPS` is never applied to `funding`. Invariant (property-tested and checked by the
reconciler): `fees + funding + rolloverIn = retained + dust + rolloverOut + Σ payouts`.

## 6. Configuration changes

* **Role / pool / provider changes.** Every path that can change who fees are attributed to — the
  settings store (admin API: role, pool or provider change), indexer attachment, rewards-worker
  provider (re)load — checks the launch's history in **both** `swaps` and `fee_attributions` (bonding
  pool and destination; LP checkpoints and fee collections count even without any swap). It refuses
  when any record was attributed under another role, provider or beneficiary wallet, carries no
  provable basis (legacy row without a snapshot whose `basisId` is not a current basis), or carries
  an internally inconsistent snapshot. History is never re-attributed implicitly; use a new pool.
  Upgrading a deployment that holds pre-snapshot records therefore requires operator review.
* **On-chain parameter changes** (e.g. a LaunchLab platform changing `creator_fee_rate`) take effect
  from the trade that carries them: LaunchLab's per-event `creator_fee` reflects the rate in force at
  execution, and each record keeps its own basis snapshot.

## 7. Ledger (`ledger_entries`)

Append-only, one row per economic fact, unique idempotency `key`:

| Type | Key | Meaning |
|---|---|---|
| `FEE_ACCRUED` | `FEE_ACCRUED:r<n>` | payout-eligible creator fees in round n's period (payout asset) |
| `FEE_NON_PAYOUT_ASSET` | `…:r<n>:<mint>` | eligible creator fees in other assets (recorded only) |
| `FEE_EXCLUDED` | `…:r<n>:<mint>:<i>` | creator-allocated but NOT payout-eligible amounts, with the reason |
| `REWARD_ALLOCATED`, `RETAINED`, `ROLLOVER_IN/OUT`, `DUST_RETAINED` | `…:r<n>` | allocation |
| `PAYOUT_SCHEDULED` | `…:r<n>:<wallet>` | written with the payout row |
| `PAYOUT_CONFIRMED` | `…:<payoutId>` | written **in the same MongoDB transaction** as the confirmation and buyer statistics |
| `PAYOUT_SIMULATED` / `PAYOUT_FAILED` / `PAYOUT_REQUEUED` | `…:<payoutId>` | dry-run / exhausted (atomic) / operator requeue |
| `FEE_CLAIMED` | `…:<signature>[:<i>]` | on-chain claim of bonding-curve or position fees |
| `FUNDING_CREDITED` | `…:r<n>:<stream>` | verified, reconciled Last-60 contributions consumed by round n (phase-aware policy) |

## 8. Collection

`FEE_COLLECTION_MODE=manual` (default, and required until the actual Forgepad signer, authority,
beneficiary and claim permissions are independently verified): operators claim fees and fund the
payout wallet. `auto_claim` (live mode only, bonding-curve claims) is gated by the same signer-side
live/mainnet checks as payouts. Post-migration collection (DAMM v2 position claims, CPMM creator-fee
collection, LP-lock fee collection) is manual; LAST60 observes and accounts it.

## 9. Reconciliation (`rewards/reconciliation.ts`)

1. **Bonding fee source.** `Σ creator fees − Σ claims (+ baseline)` vs the on-chain counter (DBC:
   exact) or vault (LaunchLab: exact, because other pools' deposits into the shared vault are now
   counted). **Over-attribution halts new payouts.**
2. **Destination (DAMM v2).** Per position/mint, `Σ checkpoint deltas` must equal the stored
   cumulative (missing/duplicated records) and must not exceed the current on-chain
   `claimable + claimed` (over-attribution → halt).
3. **Ledger.** Allocation invariant, payout rows, `PAYOUT_SCHEDULED`; per-period fee re-check;
   repair of payout ledger entries left by legacy / interrupted confirmations (idempotent).
4. **Payout wallet.** Balance ≥ pending live payouts + reserve.

## 10. Evidence

* DBC full-history reconciliations (`docs/VERIFICATION.md` §2) — exact on two real pools.
* `test/launchlab-fee-semantics.test.ts` — LaunchLab formula vs SDK and a real TradeEvent; the
  Forgepad allocation report. `test/forgepad-launchlab.test.ts` — Forgepad's real PlatformConfig
  (three decoders, validation, rate semantics, creator_scale never payable, real pre/post-upgrade
  lock evidence, CPMM independence, immutable snapshots, same basis in indexer / worker / CLI). `test/basis-guards.test.ts` (pure) and `test/basis-history.test.ts`,
  `test/migration-attach.test.ts` (MongoDB) — snapshot guards, immutability, distributability,
  reattachment.
* Real-transaction tests: `test/attribution.test.ts` (allocation, exclusions, rate-vs-share, U4),
  `test/destination.test.ts` (DAMM v2 swap/claim/checkpoints, CPMM swap and a real creator-fee
  collection), `test/migration.test.ts` (strict verification + tampering),
  `test/creator-fee-regressions.test.ts` (periods across graduation, idempotency, ineligibility, U1–U8).
