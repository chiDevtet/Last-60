# Fee accounting

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
| Allocation basis | `basisId` + `basis` snapshot (role, beneficiary, on-chain parameters, source account, verification) |

Rules:

* **Only `payoutEligible` creator-allocated amounts are distributed.** `periodFees` sums
  `eligibleFee` of eligible swaps and `creatorAmount` of eligible attributions; everything else is
  recorded per round as `ineligibleFees` and as `FEE_EXCLUDED` ledger entries (never paid).
* **`estimated` is never payable** (e.g. a CPMM creator-fee accrual whose final amount is decided at
  collection). **`unresolved`** marks anything that cannot be proven from chain data; no amount is
  invented for it.
* **Idempotent and durable.** Swaps are keyed `(signature, eventIndex)`, claims `(signature, index)`,
  attributions by a unique `key`; all writes are `$setOnInsert`, so the first observation wins and
  re-processing never double counts or reinterprets a record.
* **Historical basis is immutable.** Each record stores the basis it was generated under. Changing
  the beneficiary role on a pool that has records under another role is refused (settings store
  and worker attach) — see §6.

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
| After migration (CPMM) — creator fee | the exact amount **transferred to the pool creator by a `collect_creator_fee(_permissionless)` instruction**, when the CPMM `pool_creator` is the creator | collection instruction's own token transfers | the protocol's `creator_fee_share_rate` retained at collection; collections to anyone else |
| After migration (CPMM) — migrated LP | LP fees collected (`collect_cp_fees`, Raydium LP-lock program) from the lock whose fee-key NFT was **minted to the creator at migration**, signed by and paid to the creator | migration transaction's `lock_cp_liquidity` CPIs; collection instruction's transfers | the platform's lock, collections by a different fee-key holder, LP principal (permanently locked) |

**`creator_fee_rate` is a fee rate, not a share.** `PlatformConfig.creator_fee_rate` is expressed in
millionths of the **trade value** and is *added* to the total fee rate: the program charges
`total_fee = ⌈amount × Σrates / 10⁶⌉` and splits it pro rata to the rates (Raydium SDK
`Curve.splitFee`). A rate of 5 000 therefore means the creator receives ≈ 0.5 % **of the traded
amount**, not 0.5 % of the other fees. Verified on a real mainnet trade (`test/attribution.test.ts`).
Similarly `creator_scale` is the creator's share of the migrated LP in millionths.

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
EXPECTED_LAUNCHLAB_CREATOR_FEE_RATE           EXPECTED_LAUNCHLAB_CREATOR_LP_SCALE
```

| Result | Effect |
|---|---|
| `verified` | on-chain value equals the declaration; fees payable |
| `not_declared` | no declaration; on-chain value used as read, pool warning shown |
| `mismatch` / `unverifiable` | pool flagged (`ALLOCATION MISMATCH` warning, admin status, terminal); fees **recorded from chain** but `payoutEligible = false` — the declared value is never substituted |

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
* migration processing is idempotent (same migration → same spec → attach is a no-op).

## 5. Allocation (`packages/engine/src/rewards/allocation.ts`)

```
rewardShare = ⌊fees × REWARD_BPS / 10_000⌋
retained    = fees − rewardShare
pool        = rewardShare + rolloverIn
per         = ⌊pool / n⌋          dust = pool − per × n   (retained, recorded)
n = 0 or per < MIN_PAYOUT_LAMPORTS → no payouts; pool → rolloverOut (rollover) or retained (retain)
```
`fees` is the period's **payout-eligible creator allocation** only. Invariant (property-tested and
checked by the reconciler): `fees + rolloverIn = retained + dust + rolloverOut + Σ payouts`.

## 6. Configuration changes

* **Role changes** (`feeBeneficiaryRole`) on a pool with records under another basis are refused,
  both by the settings store and when a worker attaches with a different environment role. History
  is never re-attributed implicitly; use a new pool instead.
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
* Real-transaction tests: `test/attribution.test.ts` (allocation, exclusions, rate-vs-share, U4),
  `test/destination.test.ts` (DAMM v2 swap/claim/checkpoints, CPMM swap and a real creator-fee
  collection), `test/migration.test.ts` (strict verification + tampering),
  `test/creator-fee-regressions.test.ts` (periods across graduation, idempotency, ineligibility, U1–U8).
