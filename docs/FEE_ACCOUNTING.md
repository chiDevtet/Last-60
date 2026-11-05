# Fee accounting

LAST60 distributes **fees**, never volume, and only the share of fees the project is actually
entitled to (the *eligible fees*). All arithmetic is integer base units (lamports) — `bigint` in
code, `Decimal128` in MongoDB. No floating point touches an amount; floats appear only in UI
animation and are replaced by the exact string at rest.

## 1. Where eligible fees come from

| Provider | `FEE_BENEFICIARY_ROLE` | Eligible fee per swap (program's own formula) | Asset | Unclaimed balance on-chain |
|---|---|---|---|---|
| Meteora DBC | `creator` | `⌊trading_fee × creator_trading_fee_percentage / 100⌋` | quote, or **base** when `collect_fee_mode = OutputToken` and the trade is a buy | `VirtualPool.creator_quote_fee` / `creator_base_fee` |
| Meteora DBC | `partner` | `trading_fee − creator share` | as above | `VirtualPool.partner_quote_fee` / `partner_base_fee` |
| Raydium LaunchLab | `creator` | `TradeEvent.creator_fee` | quote | creator fee vault PDA `[creator, quote_mint]` (shared by all of the creator's pools) |
| Raydium LaunchLab | `platform` | `TradeEvent.platform_fee` | quote | platform fee vault PDA `[platform_config, quote_mint]` (shared by the whole platform) |

`trading_fee` in DBC is the LP share after the protocol fee; the creator/partner split mirrors
`split_partner_and_creator_fee` (rounding down) in the program source. Both buys **and** sells
generate eligible fees; only buys qualify wallets.

## 2. Periods: no gaps, no double counting

A round's reward period is the slot range `(previous snapshot slot, this snapshot slot]`.
Consecutive periods tile the chain, so every swap — and therefore every fee lamport — belongs to
exactly one round. A round is never snapshotted while an earlier one is unfinished, which keeps
the tiling intact even through crashes. Rounds whose window was missed contribute no snapshot,
so their fees flow into the next executed round.

## 3. Allocation (`packages/engine/src/rewards/allocation.ts`)

```
rewardShare = ⌊fees × REWARD_BPS / 10_000⌋          (75% → 7500 bps)
retained    = fees − rewardShare                     (25%)
pool        = rewardShare + rolloverIn
per         = ⌊pool / n⌋          dust = pool − per × n   (retained, recorded)
n = 0 or per < MIN_PAYOUT_LAMPORTS → no payouts; pool → rolloverOut (rollover) or retained (retain)
```

Invariant, checked by property tests and continuously by the reconciler:
`fees + rolloverIn = retained + dust + rolloverOut + Σ payouts`.

## 4. Assets other than the payout asset

LAST60 never converts between assets. Fees accrued in an asset different from `PAYOUT_ASSET`
(e.g. base-token fees from DBC `OutputToken` pools) are recorded per round in
`nonPayoutAssetFees` and as `FEE_NON_PAYOUT_ASSET` ledger entries, and are excluded from
distribution. SPL payouts are only allowed when `PAYOUT_ASSET` equals the pool's quote mint;
any other combination fails validation at startup. If a future version needs conversion, it must
use an explicit oracle with a documented price and slot, recorded per round.

## 5. Ledger (`ledger_entries`)

Append-only, one row per economic fact, each with a unique idempotency `key`:

| Type | Key | Meaning |
|---|---|---|
| `FEE_ACCRUED` | `FEE_ACCRUED:r<n>` | eligible fees in round n's period (payout asset) |
| `FEE_NON_PAYOUT_ASSET` | `…:r<n>:<mint>` | eligible fees in other assets (recorded only) |
| `REWARD_ALLOCATED` | `…:r<n>` | ⌊fees × bps⌋ |
| `RETAINED` | `…:r<n>` | fees − reward share (+ skipped pool under `retain`) |
| `ROLLOVER_IN` / `ROLLOVER_OUT` | `…:r<n>` | reward carried between rounds |
| `DUST_RETAINED` | `…:r<n>` | rounding remainder |
| `PAYOUT_SCHEDULED` | `…:r<n>:<wallet>` | allocation to a recipient (written in the same transaction as the payout row) |
| `PAYOUT_CONFIRMED` | `…:<payoutId>` | transfer reached `PAYOUT_COMMITMENT`, with signature |
| `PAYOUT_SIMULATED` | `…:<payoutId>` | dry-run allocation (never counted as paid) |
| `PAYOUT_FAILED` / `PAYOUT_REQUEUED` | `…:<payoutId>` | max attempts reached / operator requeue |
| `FEE_CLAIMED` | `…:<signature>` | on-chain claim of the beneficiary's fees (auto or external) |

Derived balances: *total paid* = Σ `PAYOUT_CONFIRMED`; *pending* = live payouts in
`pending|signing|submitted`; *retained* = Σ `RETAINED` + `DUST_RETAINED`.

## 6. Collection

* `FEE_COLLECTION_MODE=manual` — operators claim fees (Forgepad/Meteora/Raydium UI or CLI) and
  fund the payout wallet. Payouts wait (`awaiting_funds`) if the wallet is short.
* `FEE_COLLECTION_MODE=auto_claim` (live mode only) — after each snapshot the rewards worker
  calls the provider's official claim instruction (`claim_creator_trading_fee`,
  `claim_trading_fee`, `claim_creator_fee`, `claim_platform_fee_from_vault`) and closes the WSOL
  account into the payout wallet in the same transaction. The claimed amount is recorded from the
  program event (DBC) or the vault's token-balance delta (LaunchLab), not from wallet balances.
  Claim instructions are covered by tests that compare them to the IDL and, for LaunchLab,
  byte-for-byte to the official Raydium SDK builder.

## 7. Reconciliation (`rewards/reconciliation.ts`, every `RECONCILIATION_INTERVAL_SECONDS`)

1. **Fee source.** Read the unclaimed balance at slot S, ingest up to S, then compare
   `Σ eligibleFee(slot ≤ S) − Σ claims(slot ≤ S) + baseline` with the chain.
   * DBC: must be equal (tolerance `RECONCILIATION_TOLERANCE_LAMPORTS`, default 0).
   * LaunchLab: vault ≥ expected (vaults are shared; the surplus is reported as `shared_vault`).
   * **Over-attribution** (the engine believes more fees exist than the chain holds) is the only
     direction that could overpay, so it **halts new payouts** (`payout_halt`) until an operator
     clears it. Under-attribution raises a warning.
   * With `INDEXER_BACKFILL=none` the indexer records an exact baseline: fee state read first at
     slot S, cursor placed on the newest signature ≤ S.
2. **Ledger.** Per round: the allocation invariant, payout rows = perRecipient × count, and
   `PAYOUT_SCHEDULED` = payout rows.
3. **Payout wallet.** Balance ≥ pending live payouts + reserve.

## 8. Evidence

* `docs/evidence/dbc-fee-reconciliation-46ou9r.log` — full history of a real DBC pool (259 swaps,
  creator 100%): attributed 203,187,431 lamports = on-chain `creator_quote_fee`, exactly.
* `docs/evidence/dbc-fee-reconciliation-3cz51P.log` — real DBC pool with a **44%** creator split
  and claims: attributed 807,297,326 − claimed 807,283,921 = 13,405 = on-chain, exactly.
* `docs/evidence/launchlab-round-verification.log` — a live LaunchLab round re-derived from the
  chain by `scripts/verify-round.ts`: recipients identical; eligible fees 2,823,485,307 and reward
  2,117,613,980 identical from the indexer's attach slot. (The first pass showed a gap caused by
  attaching to a new pool mid-period; that behaviour was fixed — see `docs/VERIFICATION.md`.)
