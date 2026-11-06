# Phase-aware revenue attribution and Last-60 reward funding (PR #6, corrected in PR #7)

This document describes how LAST60 attributes Forge's revenue across the two launch phases, which
streams may fund Last-60 buyer rewards, what evidence is required, and what Forgepad must change
before the model can fund rewards in production. Code: `packages/engine/src/accounting/revenueStreams.ts`
(pure model), `src/revenue/decode.ts` (transaction decoding), `src/revenue/ingest.ts` (persistence,
correlation, reconciliation), `src/revenue/report.ts` (reporting), `src/rewards/scheduler.ts` (rounds).

## 1. The approved business model in one page

This model is authoritative. The percentages are fixed in code (`APPROVED_SHARES`) and in configuration
(any other value is rejected); they are not operator settings.

**A fee rate is not an allocation.** A *rate* says how much each trade is charged. An *allocation*
percentage is applied afterwards to the fees **actually collected**. Neither one proves that anything
was collected or transferred.

| Phase | What is charged | Who collects | Allocation of what was collected | Last-60 funding? |
|---|---|---|---|---|
| Bonding curve | creator fee **0.50 % of trade volume** (LaunchLab `creator_fee_rate` 5 000 / 10⁶) | the creator (`claim_creator_fee`) | **75 %** Last-60 buyer rewards · **25 %** creator (developer revenue) | yes — the 75 %, **once the transfer is observed** |
| After migration | CPMM creator fee **0.05 % of trade volume** (AmmConfig `creator_fee_rate` 500 / 10⁶), minus Raydium's protocol creator-fee share | the CPMM `pool_creator` (`collect_creator_fee`) | **100 %** creator (developer revenue) · **0 %** Last-60 | **never** |
| After migration | LP trading fees of Forge's **platform-owned** Fee Key | Forge (`collect_cp_fees` on the LP-lock program) | **50 % the creator's allocation, dedicated to Last-60 buyer rewards** · **50 %** Forge | yes — the creator's 50 %, **once the transfer is observed** |

Example (illustration only; accounting uses observed integer amounts): 1 000 SOL of bonding volume
× 0.50 % = 5 SOL of creator fees charged. If the creator collects 4 SOL so far, 3 SOL (75 % of the
4 SOL collected — never 75 % of volume) is the expected Last-60 contribution and 1 SOL stays with the
creator. Last-60 counts the 3 SOL only when it observes a transfer of it into a configured Last-60
funding destination.

**The creator's 50 % LP allocation.** Forge owns the platform Fee Key and claims the LP fees, so Forge
*custodies* the whole claim. Half of it is the creator's allocation — attributed to the launch creator,
but dedicated to Last-60 buyer rewards: it is **not** additional personal developer revenue, and it is
**not** the creator's native CPMM creator fee (a different stream the creator collects directly from
the pool). The creator does not own the Fee Key; `creator_scale` is never evidence of a creator LP
entitlement (see `docs/FEE_ACCOUNTING.md` §2). In the code this is `forge_platform_lp_last60_contribution`
with `allocationOwner: "creator"`, `custodian: "forge"` — PR #6 described it as a "Forge-funded
contribution", which PR #7 corrects.

**Transfer path for the creator's LP allocation.** Because Forge's Fee Key holder receives the claimed
fees, the allocation must be paid **directly from the Fee Key holder to the Last-60 funding
destination**. A transfer from the creator's wallet never satisfies a Forge LP claim: it cannot be told
apart from the creator's own (bonding or CPMM) revenue, and would depend on the creator forwarding
Forge-custodied funds. Last-60 enforces this (the source of a credited transfer must be the claim's
recipient).

## 2. Streams

Every event carries an explicit stream; streams are never summed into one "creator fee".

| Stream | Phase | Kind | Allocation owner | Custodian after the claim | Paid to | Reward-eligible |
|---|---|---|---|---|---|---|
| `bonding_curve_creator_fee` | bonding_curve | collection (gross) | — | creator | creator | no |
| `bonding_curve_creator_retained` | bonding_curve | derived (gross − contribution) | creator (25 %) | creator | creator | no |
| `bonding_curve_last60_reward_contribution` | bonding_curve | observed transfer | creator (75 %) | creator | Last-60 | **yes** |
| `cpmm_creator_trading_fee` | post_migration | collection (net transfer) | creator (100 %) | creator | creator | no |
| `forge_platform_lp_fee_collection` | post_migration | collection (gross) | — | Forge | Forge | no |
| `forge_platform_lp_last60_contribution` | post_migration | observed transfer | **creator (50 %)** | Forge | Last-60 | **yes** |
| `forge_platform_lp_retained` | post_migration | derived (gross − contribution) | Forge (50 %) | Forge | Forge | no |

Storage (all with unique keys, `$setOnInsert` writes and model-level immutability guards):

| Collection | One row per | Immutable | Notes |
|---|---|---|---|
| `revenue_events` | collection or funding inflow — `(stream, signature, instruction ordinal, mint)`, also unique on `(signature, ordinal, stream, feeMint)` | everything | cluster, chain, token mint, pool / source pool, provider, launch phase, signature, instruction indices, slot, block time, fee mint, accounting asset, decimals, gross / net amount, source / destination account and owner, beneficiary, evidence status, v1 snapshot (stream, phase, provider, pools, fee mint, beneficiaries incl. creator, **policy snapshot**, effective fee configuration, verification, problems) |
| `reward_funding` | funding inflow linked to a collection (key = the inflow) — the **funding contribution record** (§5) | amounts, eligibility, policy, attribution, snapshot | `roundNumber` / `consumedAt` written once, conditionally, inside the round transaction |
| `revenue_reconciliations` | collection (key = correlation id = collection key) | derived, recomputed idempotently | expected / actual / creditable / excess / untransferred / implied retained, status, discrepancies, linked distributions |

## 3. Evidence: what is observed and how it is verified

All amounts are **instruction-scoped token transfers** of the transaction (never whole-transaction
balance deltas), in integer base units of the fee mint.

* **Bonding-curve creator-fee collection.** The provider's creator-fee claim (LaunchLab
  `claim_creator_fee` out of the creator fee vault; DBC `claim_creator_trading_fee` out of the pool
  vaults), only for `FEE_BENEFICIARY_ROLE=creator`. Verified when the recipient owner is the pool
  `creator`, the bonding allocation basis is **verified** against the operator declarations, and —
  LaunchLab — no other pool deposited into the shared creator vault since the previous claim
  (`shared_creator_vault_mixed_with_other_pools` otherwise: the claim cannot be apportioned).
* **Forge platform LP collection.** `collect_cp_fees` on the Raydium LP-lock program for the
  destination pool, on a lock whose Fee Key the **verified migration transaction** minted to the
  PlatformConfig `platform_nft_wallet`. Verified when `FORGE_PLATFORM_LP_BENEFICIARY` is declared and
  equals `platform_nft_wallet`, the fee-key holder signed, and the collected fees were paid to it.
  Locks minted to the creator at a historical (pre-2026-08-17) migration are the creator's own LP
  revenue and are never a Forge collection. A spec written before this PR (no platform-lock facts) is
  recorded only when the declared Forge wallet collected, and stays `unresolved`.
* **CPMM creator-fee collection.** The `collect_creator_fee(_permissionless)` transfers to the
  `pool_creator`. Only the **net** amount is observable (the accrued amount and the protocol share are
  not in the transaction). Recorded with the effective fee configuration (§6); never shared.
* **Funding inflow.** A System Program `Transfer` (native SOL) or SPL Token / Token-2022 `Transfer` /
  `TransferChecked` into a configured `LAST60_FUNDING_DESTINATIONS` wallet (SPL: a token account whose
  owner — from the transaction's token-balance metadata — is that wallet; a `TransferChecked` mint must
  match), from a wallet that can be a collection recipient of this launch (creator, declared Forge
  beneficiary, platform NFT wallet). Transfers to anyone else are not inflows (incorrect recipient).

**Assets.** Native SOL and wrapped SOL are one accounting asset (the SPL native mint is redeemable
1:1 by closing the account). Nothing else is merged: a USD1 → SOL swap (what Forgepad's claimer does
for USD1-quoted pools) is a market conversion and never satisfies a USD1 claim.

## 4. Correlation: claim ↔ distribution

A funding inflow is linked to at most one collection (unique credit key) and **never by amount alone**:

1. **same_transaction** (Case A) — a collection earlier in the same transaction, same asset, whose
   recipient is the inflow's source.
2. **memo** (Case B) — the distribution transaction carries an SPL Memo `last60:v1:<claim signature>`
   naming a collection with the same recipient and asset, not later than the transfer.
3. **exclusive_window** (opt-in, `FUNDING_CORRELATION_MODE=exclusive_window`) — exactly one candidate:
   the latest collection from that source and asset before the transfer, still under-funded, and the
   transfer does not exceed its remaining expected amount. Any second open claim, same-slot tie or
   over-amount leaves the transfer unlinked. **Since PR #7 such links are recorded for reconciliation
   but never payable**: a positional link does not name its claim, and Forge's platform wallet also
   pays out other streams (e.g. bonding-curve platform fees) that must never be credited.

Otherwise the inflow stays **unlinked** (reported) and is retried on every reconciliation pass, so a
transfer indexed before its claim is linked once the claim arrives.

## 5. Reconciliation and credits

Per collection, with the collection's own immutable policy snapshot:

```
expected_last60 = ⌊(gross − pre_activation_accrual) × bps / 10 000⌋     (bonding 7 500 · Forge LP 5 000)
expected_retained = gross − expected_last60                              (rounding residual stays with creator / Forge)
credit(transfer)  = min(observed, expected_last60 − already credited)    (first observed wins; never above the policy)
```

Statuses: `awaiting_distribution` (nothing transferred; full untransferred balance), `partial`,
`reconciled`, `excess` (the excess is recorded, never payable), `unresolved` (collection not verified),
`not_applicable` (CPMM creator fees). "Forge retained" / "creator retained" are **implied**
(gross − observed contribution); they are never presented as independently observed.

A credit is payable only if **all** hold: the policy is `forge_phase_aware_v2`; the collection is
verified (source, beneficiary, final status); both the collection and the transfer are after the
activation slot; the link is `same_transaction` or `memo`; the transfer left the wallet that received
the claim (creator for bonding fees, Forge's Fee Key holder for LP fees); the credit names the launch
creator; the inflow itself is clean; and there is a supported (≤ expected) amount. Otherwise it is
stored with `payoutEligible=false` and every reason.

**Funding contribution record** (`reward_funding`, written once, immutable): token mint, source pool,
launch phase, stream, original claim signature (`collectionSignature`, `collectionKey`), amount actually
collected (`collectedAmount`), expected allocation (`expectedAllocation`), actual transferred amount
(`observedAmount`), creditable / excess split, source and destination wallets, transfer signature and
slot, creator attribution (`creator`, `allocationOwner`), funding policy version and snapshot,
correlation method and reconciliation status. Expected allocations and observed payments are kept side
by side and never merged; "retained" amounts are implied, never presented as observed.

**Pre-activation accruals.** Bonding-curve creator fees that accrued at or before the activation slot
were already distributed under the legacy policy. The first collections after activation absorb that
unclaimed balance (Σ creator-allocated swap fees ≤ activation − Σ claims ≤ activation) before any
contribution becomes creditable — so the same fee is never funded twice.

## 6. CPMM verification completed in this PR (PR #5 follow-ups)

**`creator_fee_on`** (`PoolState` byte 389; raydium-cp-swap `CreatorFeeOn::from_u8`, bundled IDL):
`0 both_tokens` (fee on the swap's input token), `1 only_token_0`, `2 only_token_1`; any other value is
rejected by the program. The verified mode is persisted on the verified migration
(`cpmmCreatorFeeOn`, raw byte too), the destination spec (`cpmm.creatorFeeOn`), the CPMM creator-fee
basis params and therefore every immutable v1 snapshot, `verify:allocation` / `resolve-migration`
output and the revenue events. An unknown byte → basis `unverifiable`; never inferred from
`enable_creator_fee`. Bases stored before this PR (no mode) are treated as unresolved
(`cpmm_creator_fee_basis_unresolved`) by `basisDistributable` and by the round's per-record rule.

**`CreatorFeeShare`** (raydium-cp-swap `states/creator_fee_share.rs`, verified on mainnet):

| Fact | Value |
|---|---|
| PDA | `["creator_fee_share", pool_creator, amm_config]`, CPMM program — reproduces account #15 of the real `collect_creator_fee_permissionless` fixture |
| Layout | 8-byte discriminator `account:CreatorFeeShare` · bump u8 · creator · amm_config · `share_rate` u64 · padding [u64; 8] = 145 bytes |
| Ownership / existence | created / closed by the CPMM admin (or a designated owner); optional — both collect instructions always pass the PDA |
| Precedence | account empty **or** not CPMM-owned → `AmmConfig.creator_fee_share_rate`; else the override's `share_rate` (discriminator checked) |
| Creator net | `accrued − ⌊accrued × share_rate / 10⁶⌋` |
| Mainnet (slot 466 191 556) | 22 accounts, all PDAs verify, all `share_rate = 0`, all for one creator (`qrLKab…`); one on Forgepad's AmmConfig `C7Cx2p…` |

Reported separately: AmmConfig default, override (`absent` / rate / `invalid`), effective rate, PDA
and the slot read. An invalid override or unreadable default → effective rate unresolved → basis
`unverifiable`. Because the admin can create / close an override at any time, the **observed net
collection transfer** remains the accounting authority; the effective rate is the validation basis.
`EXPECTED_CPMM_CREATOR_FEE_RATE` (Forgepad: 500) makes a different AmmConfig rate a `mismatch`.

## 7. Historical vs upgraded LaunchLab migrations

| Migration | Fee Keys | Treatment |
|---|---|---|
| Pre-2026-08-17 (historical) | separate platform and creator Fee Keys (`platform_scale` / `creator_scale`) | creator lock: creator's own LP revenue, only when proven by the migration's lock records (`classifyLaunchLabLocks`); platform lock: Forge platform LP stream |
| Post-upgrade | ONE Fee Key minted to `platform_nft_wallet` | Forge platform LP stream; no creator LP entitlement |

Ownership is always read from the actual migration transaction's lock records — never from
`creator_scale`, a configured percentage or a date. Ambiguous cases stay unresolved.

## 8. Rounds (reward engine)

`REWARD_FUNDING_POLICY` selects a versioned policy; every round stores its snapshot (`fundingPolicy`).

| | `legacy_creator_fee_v1` (default) | `forge_phase_aware_v2` (snapshot slot > activation slot) |
|---|---|---|
| Creator-allocated fees | `REWARD_PERCENTAGE` of the period's verified fees (unchanged) | counted only up to the activation slot (the round's `legacyFeeSlotCap`); later ones are recorded and reported (`creatorFeesRecordedNotDistributed`), never distributed |
| Contributions | recorded, reported, never consumed | payable v2 credits in the payout asset, not yet consumed, linked by same transaction or memo, whose **transfer and original claim transactions are both finalized and successful**, within the **per-claim cap** → 100 % to the reward pool (`REWARD_PERCENTAGE` is not applied: they already are the reward share) |

`forge_phase_aware_v1` (PR #6) is retired: it is rejected by configuration, a v1 policy object is never
"in force", and credits stored under it keep their snapshot and are never consumed or rewritten.

`pool = ⌊fees × REWARD_BPS / 10 000⌋ + funding + rolloverIn`. Credits are consumed inside the round's
MongoDB transaction with a conditional update (`roundNumber: null`); a concurrent or repeated execution
aborts and retries, so a credit funds exactly one round. Before that, the **per-claim cap** walks every
credit of each claim in chain order (already-consumed ones first) and holds back any credit that would
take the claim above its expected allocation (`fundingBreakdown.heldByAllocationGuard`). Ledger:
`FUNDING_CREDITED:r<n>:<stream>`. The reconciler checks `fees + funding + rolloverIn = retained + dust +
rolloverOut + payouts`, that consumed credits and `FUNDING_CREDITED` equal the round's funding, that no
claim's consumed funding exceeds its expected allocation, and re-checks capped legacy fees.

Unchanged: unique-buyer selection, the buyer snapshot, the round cadence and payout safety checks.
Forge's claim cadence and Last-60's buyer window are separate mechanisms. Balances are per mint; only
the payout asset funds rounds (contributions in other mints — e.g. the token leg of an LP claim — are
recorded and reported, never converted).

## 9. Configuration

| Variable | Meaning |
|---|---|
| `REWARD_FUNDING_POLICY` | `legacy_creator_fee_v1` (default) or `forge_phase_aware_v2` (approved model); `forge_phase_aware_v1` is rejected |
| `REWARD_FUNDING_POLICY_ACTIVATION_SLOT` | required for v2; set it to a slot **at or after** the deployment that enables it (credits recorded before activation are permanently ineligible — fail closed) |
| `LAST60_FUNDING_DESTINATIONS` | Last-60 funding wallets (comma separated); required for v2; also watched by the indexer. Funds credited to rounds must end up in the payout wallet (use it as the destination, or sweep) |
| `FORGE_PLATFORM_LP_BENEFICIARY` | Forge's platform Fee Key owner; must equal PlatformConfig `platform_nft_wallet` (Forgepad `8KXqQwtr…`); **required** for v2 |
| `BONDING_CREATOR_FEE_LAST60_PERCENTAGE` | must be 75 (approved model; any other value is a config error) |
| `FORGE_PLATFORM_LP_LAST60_PERCENTAGE` | must be 50 (approved model; any other value is a config error) |
| `FUNDING_CORRELATION_MODE` | `strict` (default: same tx or memo) or `exclusive_window` (extra links recorded, never payable) |
| `EXPECTED_CPMM_CREATOR_FEE_RATE` | AmmConfig `creator_fee_rate` the migrated pool must use (Forgepad 500) |
| `EXPECTED_LAUNCHLAB_PLATFORM_CONFIG` | existing; required (with the rate) for a verified bonding basis |

## 10. What Forgepad actually does today (inspected: chiDevtet/Forgepad-Newest default branch `new-ui` @ 5acce50, 2026-11-06)

PR #6 inspected `93a2cff`; ten commits landed on the default branch afterwards, several of them on
exactly this flow (44941d0, 7801001, d01e541, 252002f, 5acce50). The repository's `main` branch is a
stale January 2026 snapshot and was not used. Only code and committed configuration were inspected —
not the running servers.

| Component | What the current code does | Committed deployment config |
|---|---|---|
| `scripts/Raypostmigration.js` (PM2 `forgeRaydiumPostMigrationCollector`) | harvests the platform Fee Key LP fees (`harvestLockLp`, `closeWsol`), swaps a non-SOL quote leg to SOL (Jupiter), then pays in ONE separate transaction, no memo: **creator wallet 25 %** (SOL + token leg in kind), **per-token rewards distributor 50 %** (SOL only), platform keeps 25 %; a token without a distributor pays **creator wallet 50 %**, platform 50 % (`scripts/quote-mints/postmig-split.js`). Creator share only on post-2026-08-17 Fee Keys. The SOL leg amount is the SDK's UI estimate, not measured from the claim transaction | in `ecosystem.config.js` with `POSTMIG_DRY_RUN: 'false'` (live) and a **60 s** default interval (both changed today) |
| `scripts/forgeRaydiumPlatformFeeClaimer.js` | bonding-curve **platform**-fee sweep; pays 50 % of the SOL basis to rewards distributors from the same platform wallet | in `ecosystem.config.js` |
| `pages/api/raydium/claim-creator-fees-tx.ts` | builds the creator's own `claimCreatorFee` / `claimMultipleCreatorFee` transaction, paid to the creator, + a Forge memo and a WSOL unwrap | used by My Launches |
| Last-60 integration | none: no Last-60 funding destination, no `last60:v1` memo, no 75 % transfer anywhere | — |

Findings against the approved model:

1. **Post-migration LP split does not match.** The approved model is *creator's 50 % allocation →
   Last-60, Forge 50 %*. Today the creator's wallet receives 25 % (or 50 %) as personal revenue and a
   per-token rewards distributor receives 50 %. Neither is a Last-60 funding destination, so under
   `forge_phase_aware_v2` Last-60 records each harvest as `awaiting_distribution` and funds nothing from
   it. A creator-wallet payout is exactly the flow the approved model excludes ("not additional personal
   developer revenue").
2. **No 75 % bonding contribution exists.** The creator claims 100 % to their own wallet. Last-60 records
   the collection and the full untransferred 75 %, and funds nothing.
3. **No correlation evidence.** Distributions are separate transactions without a `last60:v1:<claim>`
   memo, and the platform wallet that pays them also pays bonding platform-fee distributions — so only
   memo / same-transaction links can be trusted (PR #7 makes `exclusive_window` non-payable).
4. **Conversions.** Non-SOL quote legs are swapped before payout; a converted amount never satisfies a
   claim in Last-60 (per-mint accounting).
5. **Measured amounts and idempotency.** The SOL payout basis is an estimate, and payouts have no
   persisted-before-broadcast idempotency; Last-60's own accounting does not depend on either, but
   Forgepad's payouts can under- or over-pay.
6. **CPMM creator fee** is left to each creator (`platformCpCreator` default) — consistent with the
   approved model (Forge never touches it).

## 11. What Forgepad must do for contributions to count (Forgepad-side; not part of this repository)

These are the conditions Last-60 verifies; how Forgepad meets them is the Forgepad team's decision.

1. **Post-migration LP.** Of each claimed Fee Key harvest, per claimed mint: transfer
   ⌊claimed × 50 %⌋ (the creator's allocation) from the Fee Key holder (`platform_nft_wallet`) to the
   token's Last-60 funding destination; Forge keeps the rest. No creator-wallet payout and no rewards
   distributor payout from this stream. Pay in the **claimed mint** (no swap); amounts measured from
   the claim transaction itself.
2. **Correlation.** Same transaction as the claim, or a separate transaction carrying the SPL Memo
   `last60:v1:<claim transaction signature>`. Distribute only after the claim is finalized (Last-60
   never funds from a claim that does not finalize).
3. **Bonding curve.** Of each collected creator fee: ⌊collected × 75 %⌋ from the creator (the claim's
   recipient) to the destination, ideally appended to the creator's claim transaction built by
   Forgepad (same-transaction correlation). Caveat: the LaunchLab creator fee vault is shared by all of
   a creator's pools with the same quote mint; Last-60 marks claims mixed with other pools as
   unverified (they cannot be apportioned).
4. **Idempotency.** Persist each contribution (keyed by claim signature) before broadcasting so a
   retry never pays twice; Last-60 caps credits at the expected allocation regardless and records any
   excess as never payable.
5. **Platform wallet.** Keep `platform_nft_wallet` = `FORGE_PLATFORM_LP_BENEFICIARY`; declare any change
   before it is used.

## 12. Operator runbook

```bash
bun run cli revenue               # every stream, per mint; discrepancies and unlinked inflows
bun run cli revenue --json
bun run cli revenue-reconcile     # re-run correlation + reconciliation (idempotent)
bun run report:revenue [--pool P] [--json]   # same report; exit 2 when discrepancies / unlinked inflows exist
bun run verify:allocation         # now also prints creator_fee_on and the CreatorFeeShare resolution
bun run fixtures:cpmm-fee-share   # refresh the CreatorFeeShare mainnet evidence (read-only)
```

Rollout:

1. Deploy with the default legacy policy; set `LAST60_FUNDING_DESTINATIONS`,
   `FORGE_PLATFORM_LP_BENEFICIARY`, `EXPECTED_CPMM_CREATOR_FEE_RATE`. Revenue events, reconciliations
   and (ineligible) links are recorded; rounds are unchanged.
2. Ship the Forgepad changes (§11). Confirm with `bun run cli revenue` that collections reconcile and
   inflows link (`same_transaction` / `memo`), with no `excess` or `unresolved` rows, and that LP
   credits name the creator (`allocationOwner: creator`) and come from the Fee Key holder.
3. Choose an activation slot at or after the switch-over and set `REWARD_FUNDING_POLICY=forge_phase_aware_v2`
   with `REWARD_FUNDING_POLICY_ACTIVATION_SLOT` on **both** workers (and the CLI). Rounds whose
   snapshot is after it are funded by verified contributions only.
4. Watch the reconciler (`FUNDING_CREDITED` vs consumed credits) and the revenue report.

## 13. Known limitations

* No Forgepad LaunchLab launch has graduated yet: Forge LP claim and distribution transactions are
  tested on synthetic transactions over the real migration fixture, not on a real Forge claim.
* The `exclusive_window` scan looks at the latest 200 collections of a source; older open claims beyond
  that window are not considered (use memo or same-transaction correlation in production).
* Bonding-curve creator-fee claims are parsed only for `FEE_BENEFICIARY_ROLE=creator`.
* The CPMM accrued (pre-share) amount is not observable from a collection transaction; only the net is
  reported.
* `closeAccount`-based lamport inflows into a destination are not recognised as contributions.
* Funding destinations are indexed like pool addresses (cursor per address, `INDEXER_BACKFILL` applies).
  Prefer a **dedicated** funding wallet: using a wallet with a long unrelated history makes the first
  backfill read that history (outflows and unrelated inflows are ignored, but still fetched).
* Reconciliation passes are per launch and scan that launch's unlinked inflows / unreconciled claims
  (bounded to 500 per pass); at very high claim counts consider archiving fully reconciled claims.
