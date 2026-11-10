# Phase-aware revenue attribution and Asteroid Protocol reward funding (PR #6, corrected in PR #7, Forge creator distributions in PR #8, payout wallet, custody and recovery in PR #10)

This document describes how Asteroid Protocol attributes Forge's revenue across the two launch phases, which
streams may fund Asteroid Protocol buyer rewards, what evidence is required, and how Asteroid Protocol recognises Forge's
**existing** post-migration LP distribution without any change to Forgepad's platform-wide fee claimer
(§4a). Code: `packages/engine/src/accounting/revenueStreams.ts` (pure model, incl.
`attributeForgeDistribution`), `src/revenue/decode.ts` (transaction decoding, incl.
`forgeCreatorDistribution`), `src/revenue/ingest.ts` (persistence, correlation, attribution,
reconciliation), `src/indexer/cursor.ts` (indexing coverage), `src/revenue/report.ts` (reporting),
`src/rewards/scheduler.ts` (rounds), `src/custody/custody.ts` (physical custody, §14),
`src/recovery/attributionRecovery.ts` (operator recovery, §15), `src/signer/payoutSigner.ts` (the
dedicated payout wallet's signer, §16 and docs/PAYOUT_WALLET.md).

**Four things are never interchangeable** (since PR #10):

| # | Question | Record | Becomes true when |
|---|---|---|---|
| 1 | Who economically contributed? | `reward_funding` credit (attribution, §4–§5) | a verified transfer is correlated to a verified claim |
| 2 | Who physically holds the SOL? | `custody_transfers` (§14) | the SOL is independently observed — finalized, verified — in the dedicated payout wallet |
| 3 | Is it actually funding a reward round? | `reward_funding.roundNumber` (§8) | 1 and 2 hold, finality and the per-claim cap pass, and a round consumes it |
| 4 | Is a buyer payout authorized? | `payouts` + the payout signer (§16) | the round planned it and the signer validated the transaction against its authorization |

An attributed contribution is an accounting fact, **not** liquidity: until its SOL is verified in the
payout wallet it cannot fund any round.

## 1. The approved business model in one page

This model is authoritative. The percentages are fixed in code (`APPROVED_SHARES`) and in configuration
(any other value is rejected); they are not operator settings.

**A fee rate is not an allocation.** A *rate* says how much each trade is charged. An *allocation*
percentage is applied afterwards to the fees **actually collected**. Neither one proves that anything
was collected or transferred.

| Phase | What is charged | Who collects | Allocation of what was collected | Asteroid Protocol funding? |
|---|---|---|---|---|
| Bonding curve | creator fee **0.50 % of trade volume** (LaunchLab `creator_fee_rate` 5 000 / 10⁶) | the creator (`claim_creator_fee`) | **75 %** Asteroid Protocol buyer rewards · **25 %** creator (developer revenue) | yes — the 75 %, **once the transfer is observed** |
| After migration | CPMM creator fee **0.05 % of trade volume** (AmmConfig `creator_fee_rate` 500 / 10⁶), minus Raydium's protocol creator-fee share | the CPMM `pool_creator` (`collect_creator_fee`) | **100 %** creator (developer revenue) · **0 %** Asteroid Protocol | **never** |
| After migration | LP trading fees of Forge's **platform-owned** Fee Key | Forge (`collect_cp_fees` on the LP-lock program) | **50 % the creator's allocation, dedicated to Asteroid Protocol buyer rewards** · **50 %** Forge | yes — the creator's 50 %, **once the transfer is observed** |

Example (illustration only; accounting uses observed integer amounts): 1 000 SOL of bonding volume
× 0.50 % = 5 SOL of creator fees charged. If the creator collects 4 SOL so far, 3 SOL (75 % of the
4 SOL collected — never 75 % of volume) is the expected Asteroid Protocol contribution and 1 SOL stays with the
creator. Asteroid Protocol counts the 3 SOL only when it observes a transfer of it into a configured Asteroid Protocol
funding destination.

**The creator's 50 % LP allocation.** Forge owns the platform Fee Key and claims the LP fees, so Forge
*custodies* the whole claim. Half of it is the creator's allocation — attributed to the launch creator,
but dedicated to Asteroid Protocol buyer rewards: it is **not** additional personal developer revenue, and it is
**not** the creator's native CPMM creator fee (a different stream the creator collects directly from
the pool). The creator does not own the Fee Key; `creator_scale` is never evidence of a creator LP
entitlement (see `docs/FEE_ACCOUNTING.md` §2). In the code this is `forge_platform_lp_last60_contribution`
with `allocationOwner: "creator"`, `custodian: "forge"` — PR #6 described it as a "Forge-funded
contribution", which PR #7 corrects.

**Transfer path for the creator's LP allocation.** Forge's Fee Key holder receives the claimed fees, so
the allocation is credited only when it leaves **the Fee Key holder** (the claim's recipient). Two
routes are recognised:

1. **Forge's existing creator distribution** (`forge_creator_distribution`, §4a) — what Forgepad's
   collector already does today: a separate, memo-less transaction from the Fee Key holder to the
   **launch creator's wallet** paying the creator's 50 %. The creator wallet is where this stream's
   Asteroid Protocol funds land; they are the creator's allocation dedicated to Asteroid Protocol buyer rewards, **not**
   personal developer revenue and **not** CPMM creator trading revenue.
2. **Into an Asteroid Protocol funding destination** (`last60_destination`, PR #6 / #7) — a transfer from the Fee
   Key holder to a `LAST60_FUNDING_DESTINATIONS` wallet in the claim's transaction or with a
   `last60:v1:<claim>` memo. Still supported; not required.

A transfer **from** the creator's wallet never satisfies a Forge LP claim (it cannot be told apart from
the creator's own bonding or CPMM revenue): the source of a credited transfer must be the claim's
recipient. Since PR #10 the creator's receipt of Forge's payout is the (single) economic contribution,
and the creator's later transfer of that SOL into the dedicated payout wallet is a **custody transfer**
(§14) — never a second contribution. A credit funds rounds only once that custody is verified.

## 2. Streams

Every event carries an explicit stream; streams are never summed into one "creator fee".

| Stream | Phase | Kind | Allocation owner | Custodian after the claim | Paid to | Reward-eligible |
|---|---|---|---|---|---|---|
| `bonding_curve_creator_fee` | bonding_curve | collection (gross) | — | creator | creator | no |
| `bonding_curve_creator_retained` | bonding_curve | derived (gross − contribution) | creator (25 %) | creator | creator | no |
| `bonding_curve_last60_reward_contribution` | bonding_curve | observed transfer | creator (75 %) | creator | Asteroid Protocol | **yes** |
| `cpmm_creator_trading_fee` | post_migration | collection (net transfer) | creator (100 %) | creator | creator | no |
| `forge_platform_lp_fee_collection` | post_migration | collection (gross) | — | Forge | Forge | no |
| `forge_platform_lp_last60_contribution` | post_migration | observed transfer | **creator (50 %)** | Forge | Asteroid Protocol | **yes** |
| `forge_platform_lp_retained` | post_migration | derived (gross − contribution) | Forge (50 %) | Forge | Forge | no |
| `damm_v2_creator_lp_fee` | post_migration | collection (gross) — Meteora DBC → DAMM v2 only | — | creator | creator | no |
| `damm_v2_creator_lp_retained` | post_migration | derived (gross − contribution) | creator (25 %) | creator | creator | no |
| `damm_v2_creator_lp_last60_contribution` | post_migration | observed transfer | creator (75 %) | creator | Asteroid Protocol | **yes** (§17) |

Storage (all with unique keys, `$setOnInsert` writes and model-level immutability guards):

| Collection | One row per | Immutable | Notes |
|---|---|---|---|
| `revenue_events` | collection or funding inflow — `(stream, signature, instruction ordinal, mint)`, also unique on `(signature, ordinal, stream, feeMint)` | everything | cluster, chain, token mint, pool / source pool, provider, launch phase, signature, instruction indices, slot, block time, fee mint, accounting asset, decimals, gross / net amount, source / destination account and owner, beneficiary, evidence status, v1 snapshot (stream, phase, provider, pools, fee mint, beneficiaries incl. creator, **policy snapshot**, effective fee configuration, verification, problems) |
| `reward_funding` | funding inflow linked to a collection (key = the inflow) — the **funding contribution record** (§5) | amounts, eligibility, policy, attribution, snapshot | `roundNumber` / `consumedAt` written once, conditionally, inside the round transaction |
| `revenue_reconciliations` | collection (key = correlation id = collection key) | derived, recomputed idempotently | expected / actual / creditable / excess / untransferred / implied retained, status, discrepancies, linked distributions |
| `funding_attributions` | Forge creator-distribution leg (key = the inflow) | decided once (`pending` → `linked` / `unresolved`, conditional on `pending`) | the bounded attribution work queue and audit trail: status, reasons, candidate harvests, evidence (harvest, previous harvest, anchor mint, coverage); economic facts stay on the immutable event / credit |

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
* **Forge creator distribution** (route `forge_creator_distribution`, §4a). A transaction in which the
  declared Forge wallet pays the launch creator (System `transfer` and/or SPL `TransferChecked` from
  its token account), or pays this launch's token to anyone in a transfer-only transaction. Every Forge
  outflow of it is recorded as a leg with the transaction's **shape** (fee payer, programs, recipients,
  mints, anchor). A payout that carries another token and not this launch's belongs to that launch and
  is not recorded here.
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

4. **forge_distribution_sequence** — Forge's existing, memo-less creator payout, attributed by the
   structural evidence of §4a. Payable. Never by amount.

Otherwise the inflow stays **unlinked** (reported) and is retried on every reconciliation pass, so a
transfer indexed before its claim is linked once the claim arrives.

## 4a. Forge's existing post-migration creator distribution

### The flow Forge actually runs (Forgepad `new-ui` @ 5acce50, read-only inspection)

`templates/fun-launch/scripts/Raypostmigration.js` (PM2 `forgeRaydiumPostMigrationCollector`, live,
60 s cycle) with `scripts/quote-mints/postmig-split.js`, for every Fee Key the platform wallet holds
(one lock = one migrated pool = one token), **one lock at a time**:

| Step | Transaction | What moves |
|---|---|---|
| 1. harvest | `raydium.cpmm.harvestLockLp({ closeWsol: true })` — LP-lock `collect_cp_fees`, signed and paid by the Fee Key holder | both fee legs from the CPMM vaults to the holder: the token leg into its **associated token account** (SDK `associatedOnly: true`), the WSOL leg into a temporary account closed in the same transaction |
| 2. swap (non-SOL quote only) | Jupiter, separate transaction | the quote leg (e.g. USD1, ai16z) → SOL; the creator's SOL basis is Jupiter's `otherAmountThreshold`, not a measured amount |
| 3. payout | `sendPayouts`, a **separate legacy transaction**, fee payer = holder, **no memo** | `SystemProgram.transfer(holder → creator, ⌊basis × 50 %⌋)` · `createAssociatedTokenAccountIdempotent` · `TransferChecked(holder ATA → creator ATA, token, ⌊token leg × 50 %⌋)` — when the token has **no** Forge rewards distributor and the Fee Key is post-2026-08-17 (combined) |
| — | (distributor mode) | the same transaction also pays the token's Forge rewards distributor 50 % and the creator only **25 %** (25 / 50 / 25) — not the approved model |
| 4. writeback | MongoDB `raydium_postmig_lockfee_claims`, `raydium_launches.last_postmigration_creator_payout_tx` | Forge's own records (`harvestTx`, `distTx`) — **not** an existing Asteroid Protocol data source; not used |

The creator is `LaunchpadPool.creator` (Forge reads it on-chain; Asteroid Protocol reads the same field). The SOL
basis of a SOL-quoted pool is the Raydium API's UI estimate of the unclaimed fee (`toRaw(uiAmount)`),
not the measured claim; the token leg is measured (wallet balance delta) and therefore exactly
`⌊claimed token × 50 %⌋`. A failed payout is logged and **not retried** (the next cycle harvests again).

### What Asteroid Protocol observes and how it correlates

There is no field in the payout that names its harvest (no memo, no shared transaction). Asteroid Protocol
therefore proves the relationship from launch-scoped, complete-index chain evidence, and refuses when
it cannot (`attributeForgeDistribution`, pure):

| # | Check | Evidence | Failure → |
|---|---|---|---|
| 0 | **shape** | fee payer = declared Forge wallet (= PlatformConfig `platform_nft_wallet`); only System / SPL Token / Token-2022 / ATA / ComputeBudget / Memo programs; every Forge outflow goes to the launch creator; at most one transfer per asset; no foreign mint; an **anchor** leg in this launch's token mint | `unresolved` (`fee_payer_not_forge_platform_wallet`, `unexpected_programs`, `forge_outflow_to_non_creator`, `foreign_mint_leg`, `multiple_transfers_in_one_asset`, `no_launch_anchor`, `recipient_not_launch_creator`) |
| 1 | **coverage** | the destination pool's and Forge's launch-token account's signature cursors prove every transaction up to the payout slot is ingested (`cursor.lastSlot − 1`, or `syncedThroughSlot` recorded by a complete poll pass anchored with `minContextSlot`) | `pending` (re-evaluated every pass) |
| 2 | **ordering** | no harvest of the launch in the payout's slot (intra-slot order is unknowable) | `unresolved` `harvest_in_same_slot_as_distribution` |
| 3 | **harvest** | H = the latest harvest strictly before the payout, alone in its slot | `unresolved` `no_preceding_harvest` / `multiple_harvests_in_candidate_slot` |
| 4 | **exclusivity** | no other anchored payout of the launch in [slot(H), slot(payout)] | `unresolved` `competing_distribution_since_harvest` |
| 5 | **alternation** | the harvest before H, if any, was followed by a payout before H — so the payout cannot be a late payment of an earlier, unpaid harvest | `unresolved` `previous_harvest_has_no_distribution` |
| 6 | **amounts** (per accounting asset, against H's leg in the same asset only) | anchor (token) leg present in H and ≤ H's remaining 50 %; SOL leg ≤ H's remaining 50 % of the WSOL leg | anchor leg missing / above → whole payout `unresolved`; SOL leg above → that leg never payable (`exceeds_expected_allocation`, excess recorded); SOL of a non-SOL-quoted pool → that leg `unresolved` (`asset_not_collected_by_harvest`) |

Then the ordinary credit rules of §5 apply to every linked leg (verified harvest, activation slot,
creator attribution, source = claim recipient, …).

**Why the anchor.** One creator can have many launches and Forge's platform wallet pays many streams
(bonding platform fees to rewards distributors, `recoverRaydiumFeePayout.js`, the post-migration
collector for every token). A SOL amount carries no launch identity; the token leg — Forge sends it in
kind by default (`POSTMIG_SWAP_TOKEN_LEG` unset) — does. A payout without it is recorded and never
credited.

**Why amount-only matching is forbidden.** Two claims can have identical or similar amounts (same
token, consecutive harvests; or two launches of one creator); Forge's SOL basis is an estimate, so it
does not even equal the claimed half exactly. Amounts are only bounds and consistency checks here; the
link is the sequence of indexed, launch-scoped transactions.

**Multiple candidate claims.** Any situation in which the indexed history admits more than one harvest
for a payout — two harvests in one slot, a harvest in the payout's slot, a second payout after the same
harvest, an unpaid earlier harvest, a window too large to prove (> 24 harvest rows / 64 payouts) — is
recorded `unresolved` with the candidate harvests and is never payable. Decided rows are never
re-evaluated by the attribution pass, so a later ingestion can never flip an unresolved payout to
payable by itself; only an explicit, audited operator recovery (§15) re-runs the same algorithm.

**Unresolved and excess.** Unresolved legs are revenue events (`route: forge_creator_distribution`)
with a `funding_attributions` row (`unresolved`, reasons, candidates); no credit is written unless a
single harvest is proven. Linked legs above the remaining allocation are credits with
`payoutEligible=false` and the excess recorded (the claim's reconciliation shows `excess`).

**High volume.** The indexer watches, per Asteroid Protocol launch, only Forge's associated token account for
that launch's token (from the migration slot) — never the platform wallet's whole multi-launch
history. The attribution pass reads only `pending` queue rows of the launch (indexed
`(sourcePool, status, slot)`) and, per payout, the launch's latest ≤ 24 harvest rows at or before it and
its anchored payouts in [previous harvest, payout] (indexed `(sourcePool, stream, slot)` /
`(sourcePool, kind, slot)`). Other launches and creators are never candidates. Decisions depend only on
indexed events (never on credits already written), credits are `$setOnInsert` on the inflow key and the
queue transition is conditional on `pending`: concurrent, repeated or restarted passes reach the same
result and credit each leg at most once. Several outstanding claims of one launch, several fee mints,
many creators and many launches in one database are independent.

**Limits of attribution (fail closed).**

* Forge's **distributor mode** (25 / 50 / 25): recorded, never credited (not the approved model).
* **Non-SOL quote** (USD1, ai16z, …): the SOL payout is a Jupiter conversion of the quote leg — never
  credited; the token leg is credited per mint (recorded; rounds pay only in the payout asset).
* **SOL estimate above the measured half**: that SOL leg is never payable. Because Forge's SOL basis
  is the Raydium API's estimate, a SOL payout can exceed ⌊claimed × 50 %⌋ by a small amount when
  reserves move between Forge's read and its harvest; such legs stay unpaid in Asteroid Protocol.
* **Unpaid harvest** (Forge payout error, never retried): the next harvest's payout is unresolved too.
* **`POSTMIG_SWAP_TOKEN_LEG=true`** or a zero token leg: no anchor → recorded, never credited.
* Coverage requires the indexer's cursors for the destination pool and Forge's launch-token account;
  without the indexer (or with `FORGE_PLATFORM_LP_BENEFICIARY` unset) payouts stay `pending`.

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
verified (source, beneficiary, final status — for Forge LP claims: verified migration, platform Fee Key
minted to `platform_nft_wallet` = `FORGE_PLATFORM_LP_BENEFICIARY`, fees paid to it); both the collection
and the transfer are after the activation slot; the link is `same_transaction`, `memo` or
`forge_distribution_sequence` (§4a: the payout is linked to exactly one harvest); the transfer left the
wallet that received the claim (creator for bonding fees, Forge's Fee Key holder for LP fees); the
credit names the launch creator (on the Forge creator route the funds reached exactly that wallet, and
only a Forge LP claim can be settled); the inflow itself is clean (shape problems make it
`unresolved`); the asset is the claim leg's own asset; and there is a supported (≤ expected) amount.
Round consumption additionally requires both transactions to be **finalized and successful** (§8).
Otherwise it is stored with `payoutEligible=false` and every reason.

**Funding contribution record** (`reward_funding`, written once, immutable): token mint, source pool,
launch phase, stream, original claim signature (`collectionSignature`, `collectionKey`), amount actually
collected (`collectedAmount`), expected allocation (`expectedAllocation`), actual transferred amount
(`observedAmount`), creditable / excess split, source and destination wallets, transfer signature and
slot, creator attribution (`creator`, `allocationOwner`), funding policy version and snapshot,
correlation method and reconciliation status; since PR #8 also the `route` (`last60_destination` /
`forge_creator_distribution`) and, for `forge_distribution_sequence`, the immutable `attribution`
evidence (harvest and previous harvest signatures, payout signature, anchor mint, Forge wallet,
creator, indexing coverage slot). Expected allocations and observed payments are kept side
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

| | `legacy_creator_fee_v1` | `forge_phase_aware_v2` (default; snapshot slot > activation slot) |
|---|---|---|
| Creator-allocated fees | `REWARD_PERCENTAGE` of the period's verified fees (unchanged) | counted only up to the activation slot (the round's `legacyFeeSlotCap`); later ones are recorded and reported (`creatorFeesRecordedNotDistributed`), never distributed |
| Contributions | recorded, reported, never consumed | payable v2 credits in the payout asset, not yet consumed, linked by same transaction, memo or `forge_distribution_sequence`, whose **transfer and original claim transactions are both finalized and successful**, within the **per-claim cap** → 100 % to the reward pool (`REWARD_PERCENTAGE` is not applied: they already are the reward share) |

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
Forge's claim cadence and Asteroid Protocol's buyer window are separate mechanisms. Balances are per mint; only
the payout asset funds rounds (contributions in other mints — e.g. the token leg of an LP claim — are
recorded and reported, never converted).

## 9. Configuration

| Variable | Meaning |
|---|---|
| `REWARD_FUNDING_POLICY` | `forge_phase_aware_v2` (default, approved model) or `legacy_creator_fee_v1`; `forge_phase_aware_v1` is rejected |
| `REWARD_FUNDING_POLICY_ACTIVATION_SLOT` | unset / `auto` (default): pinned **once** to the finalized slot at the first start of any process, stored in `system_state.funding_policy_activation` and read by every later start of every process (`config/activation.ts`) — i.e. exactly "at the deployment that enables it". Until it is resolved nothing is recorded and no round is planned. An explicit slot overrides it (at or after the switch-over; credits recorded before activation are permanently ineligible — fail closed) |
| `LAST60_FUNDING_DESTINATIONS` | Asteroid Protocol funding wallets (comma separated); also watched by the indexer. Under v2 the dedicated `LAST60_PAYOUT_WALLET_ADDRESS` is added automatically (once), so a contribution sent straight to it needs no custody transfer; v2 requires at least one destination (the payout wallet counts) |
| `LAST60_PAYOUT_WALLET_ADDRESS` (+ `…_KEYPAIR_PATH` / `…_PRIVATE_KEY`, rewards only) | the dedicated payout wallet (§16, docs/PAYOUT_WALLET.md); legacy `PAYOUT_WALLET_*` names are aliases |
| `LAST60_CUSTODY_ENABLED` | default **on** under v2 with a payout wallet, off otherwise; `false`: no custody request can be opened or bound. Rounds still require verified custody (direct contributions into the payout wallet are verified by their own transfer) |
| `LAST60_CUSTODY_REQUEST_TTL_HOURS` | how long an open custody request can be bound (default 168) |
| `LAST60_ATTRIBUTION_RECOVERY_ENABLED` | `false` (default): every recovery request is refused (and audited) |
| `FORGE_PLATFORM_LP_BENEFICIARY` | Forge's platform Fee Key owner; must equal PlatformConfig `platform_nft_wallet` (Forgepad `8KXqQwtr…`, the default on mainnet-beta under v2 — still verified on chain); **required** for v2 by the indexer / rewards worker outside mainnet-beta. Also the source wallet of Forge's creator distributions (§4a): once a LaunchLab → CPMM migration is verified, the indexer watches this wallet's associated token account for the launch token from the migration slot |
| `BONDING_CREATOR_FEE_LAST60_PERCENTAGE` | must be 75 (approved model; any other value is a config error) |
| `FORGE_PLATFORM_LP_LAST60_PERCENTAGE` | must be 50 (approved model; any other value is a config error) |
| `FUNDING_CORRELATION_MODE` | `strict` (default: same tx or memo) or `exclusive_window` (extra links recorded, never payable) |
| `EXPECTED_CPMM_CREATOR_FEE_RATE` | AmmConfig `creator_fee_rate` the migrated pool must use (Forgepad 500) |
| `EXPECTED_LAUNCHLAB_PLATFORM_CONFIG` | existing; required (with the rate) for a verified bonding basis |

PR #8 added **no** environment variable: the Forge creator route needs only `FORGE_PLATFORM_LP_BENEFICIARY`
(already required for v2) and on-chain facts (pool creator, token mint and token program, verified
migration). Nothing about the creator, the token or a creator-to-token mapping is configured.

## 10. What Forgepad actually does today (inspected read-only: chiDevtet/Forgepad-Newest default branch `new-ui` @ 5acce50, 2026-11-06; re-inspected for PR #8 at the same commit)

PR #6 inspected `93a2cff`; ten commits landed on the default branch afterwards, several of them on
exactly this flow (44941d0, 7801001, d01e541, 252002f, 5acce50). The repository's `main` branch is a
stale January 2026 snapshot and was not used. Only code and committed configuration were inspected —
not the running servers.

| Component | What the current code does | Committed deployment config |
|---|---|---|
| `scripts/Raypostmigration.js` (PM2 `forgeRaydiumPostMigrationCollector`) | harvests the platform Fee Key LP fees (`harvestLockLp`, `closeWsol`), swaps a non-SOL quote leg to SOL (Jupiter), then pays in ONE separate transaction, no memo: **creator wallet 25 %** (SOL + token leg in kind), **per-token rewards distributor 50 %** (SOL only), platform keeps 25 %; a token without a distributor pays **creator wallet 50 %**, platform 50 % (`scripts/quote-mints/postmig-split.js`). Creator share only on post-2026-08-17 Fee Keys. The SOL leg amount is the SDK's UI estimate, not measured from the claim transaction | in `ecosystem.config.js` with `POSTMIG_DRY_RUN: 'false'` (live) and a **60 s** default interval (both changed today) |
| `scripts/forgeRaydiumPlatformFeeClaimer.js` | bonding-curve **platform**-fee sweep; pays 50 % of the SOL basis to rewards distributors from the same platform wallet | in `ecosystem.config.js` |
| `pages/api/raydium/claim-creator-fees-tx.ts` | builds the creator's own `claimCreatorFee` / `claimMultipleCreatorFee` transaction, paid to the creator, + a Forge memo and a WSOL unwrap | used by My Launches |
| Asteroid Protocol integration | none: no Asteroid Protocol funding destination, no `last60:v1` memo, no 75 % transfer anywhere | — |

Findings against the approved model:

1. **Post-migration LP split.** For a token without a Forge rewards distributor Forge pays the creator's
   wallet exactly the approved 50 % and keeps 50 %. Since PR #8 Asteroid Protocol recognises that existing payout
   as the creator's allocation dedicated to Asteroid Protocol (§4a); PR #7's statement that a creator-wallet payout
   is excluded is superseded — what is excluded is a transfer *from* the creator's wallet, and Forge's
   distributor mode (creator 25 %, distributor 50 %), which is recorded but never credited.
2. **No 75 % bonding contribution exists.** The creator claims 100 % to their own wallet. Asteroid Protocol records
   the collection and the full untransferred 75 %, and funds nothing.
3. **No explicit correlation field.** Distributions are separate transactions without a memo, and the
   platform wallet that pays them also pays bonding platform-fee distributions. PR #7 therefore made
   positional `exclusive_window` links non-payable; PR #8 adds the launch-anchored, complete-index
   sequence attribution of §4a instead (still never by amount, still failing closed).
4. **Conversions.** Non-SOL quote legs are swapped before payout; a converted amount never satisfies a
   claim in Asteroid Protocol (per-mint accounting).
5. **Measured amounts and idempotency.** The SOL payout basis is an estimate, and payouts have no
   persisted-before-broadcast idempotency; Asteroid Protocol's own accounting does not depend on either, but
   Forgepad's payouts can under- or over-pay.
6. **CPMM creator fee** is left to each creator (`platformCpCreator` default) — consistent with the
   approved model (Forge never touches it).

## 11. Forgepad changes: none required for the post-migration LP stream

A normal Forge launch keeps using Forgepad's existing platform-wide collector unchanged: no
Asteroid Protocol-specific memo, destination, percentage, worker or per-token configuration. Asteroid Protocol adapts to
the money movements Forge already makes (§4a). This repository never modifies Forgepad.

What remains outside this stream:

1. **Bonding curve (75 %).** The creator claims 100 % of bonding creator fees to their own wallet; the
   75 % Asteroid Protocol contribution is a transfer the **creator** makes (same transaction as the claim, or
   with a `last60:v1:<claim>` memo) into an Asteroid Protocol funding destination. Until then those collections
   reconcile as `awaiting_distribution`. (Not part of Forge's claimer.) With the creator wallet
   automation Asteroid Protocol makes both the claim and that memo transfer itself (docs/CREATOR_WALLET.md).
2. **Optional, never required** — things on Forge's side that would let Asteroid Protocol credit more of what it
   already pays: a SOL basis measured from the harvest transaction instead of the API estimate (the
   SOL leg would then never exceed the half), and paying in the claimed mint instead of swapping a
   non-SOL quote. Without them those legs stay recorded and unpaid; nothing is misattributed.

## 12. Operator runbook

```bash
bun run cli revenue               # every stream, per mint; discrepancies and unlinked inflows
bun run cli revenue --json
bun run cli revenue-reconcile     # re-run correlation + reconciliation (idempotent)
bun run report:revenue [--pool P] [--json]   # same report; exit 2 when discrepancies / unlinked inflows exist
bun run verify:allocation         # now also prints creator_fee_on and the CreatorFeeShare resolution
bun run fixtures:cpmm-fee-share   # refresh the CreatorFeeShare mainnet evidence (read-only)
```

Forge creator distributions (§4a): the report's `Forge creator distributions` line counts `linked`
(payable), `pending` and `unresolved` legs by reason and mint; `funding_attributions` holds each
decision (`db.funding_attributions.find({ status: "unresolved" })`). `pending` that does not clear means
the indexer's coverage of the destination pool or of Forge's launch-token account is behind (check
`worker_state` cursors / `syncedThroughSlot`).

Payout wallet, custody and recovery (PR #10, §14–§16):

```bash
bun run cli payout-wallet                       # read-only wallet verification (never a key)
bun run cli funding [--json]                    # attribution / custody / round funding / payouts + liquidity
bun run cli custody-request <fundingKey> [why]  # open a sweep request for ONE credited contribution
bun run cli custody-submit <custodyId> <sig>    # verify the custodian's transfer from the chain and bind it
bun run cli custody-cancel <custodyId> <why>
bun run cli custody-refresh                     # promote bound transfers to finalized / failed (also automatic)
bun run cli attributions [unresolved|pending|linked]
bun run cli recover <attributionKey> [note]     # re-run the normal attribution for ONE unresolved row
bun run cli recoveries [attributionKey]         # append-only recovery audit
```

Rollout:

Since the creator wallet change, `forge_phase_aware_v2` is the default and its activation slot is pinned
automatically at the first start; with the creator key configured, claims, the 75 % settlement and the
post-migration sweeps are automatic (docs/CREATOR_WALLET.md). The staged rollout below is still
available: start with `REWARD_FUNDING_POLICY=legacy_creator_fee_v1` and switch later.

1. Deploy with `REWARD_FUNDING_POLICY=legacy_creator_fee_v1`; set `LAST60_FUNDING_DESTINATIONS`,
   `FORGE_PLATFORM_LP_BENEFICIARY`, `EXPECTED_CPMM_CREATOR_FEE_RATE`. Revenue events, reconciliations,
   Forge creator-distribution attributions and (ineligible) links are recorded; rounds are unchanged.
2. Confirm with `bun run cli revenue` on real Forge harvests that LP claims reconcile, Forge's creator
   payouts link (`forge_distribution_sequence`) with credits naming the creator
   (`allocationOwner: creator`, source = the Fee Key holder, destination = the creator), and review every
   `unresolved` reason. Install the dedicated payout wallet (docs/PAYOUT_WALLET.md) and, when you are
   ready to collect creators' custody transfers, set `LAST60_CUSTODY_ENABLED=true` (§14).
3. Remove `REWARD_FUNDING_POLICY` (or set `forge_phase_aware_v2`) on **every** process and restart; leave
   `REWARD_FUNDING_POLICY_ACTIVATION_SLOT` unset to pin it at that restart, or set a slot at or after the
   switch-over. Rounds whose snapshot is after it are funded by verified contributions only.
4. Watch the reconciler (`FUNDING_CREDITED` vs consumed credits) and the revenue report.

## 13. Known limitations

* No Forgepad LaunchLab launch had a live post-migration harvest and payout at the time of writing:
  Forge LP claims and Forge's creator payouts are tested on **synthetic** transactions that mirror
  `harvestLockLp` / `sendPayouts` instruction for instruction, over the real migration fixture — **not**
  on real Forge transactions. No production transaction has been verified.
* The Forge creator route credits only Forge's no-distributor mode, the token leg of non-SOL-quoted
  pools and SOL legs not above the measured half (§4a, limits); everything else is recorded, unpaid.
* Forge's own MongoDB records (`raydium_postmig_lockfee_claims.harvestTx/distTx`) would name the pair
  explicitly but are not an existing Asteroid Protocol data source and are not used.
* The `exclusive_window` scan looks at the latest 200 collections of a source; older open claims beyond
  that window are not considered (use memo or same-transaction correlation in production).
* Bonding-curve creator-fee claims are parsed only for `FEE_BENEFICIARY_ROLE=creator`.
* The CPMM accrued (pre-share) amount is not observable from a collection transaction; only the net is
  reported.
* `closeAccount`-based lamport inflows into a destination are not recognised as contributions.
* `revenue_events` keys are global (signature, instruction, stream, mint): in a database shared by
  several launches, a transaction relevant to two of them is recorded once; Forge payouts are
  recorded only under the launch whose token they carry, so this never affects attribution.
* Funding destinations are indexed like pool addresses (cursor per address, `INDEXER_BACKFILL` applies).
  Prefer a **dedicated** funding wallet: using a wallet with a long unrelated history makes the first
  backfill read that history (outflows and unrelated inflows are ignored, but still fetched).
* Reconciliation passes for `last60_destination` inflows are per launch and scan that launch's unlinked
  inflows / unreconciled claims (bounded to 500 per pass); the Forge creator route uses its own indexed
  queue (§4a). At very high claim counts consider archiving fully reconciled claims.
* Without the creator wallet automation (docs/CREATOR_WALLET.md), custody (§14) is creator-initiated:
  Asteroid Protocol cannot move SOL out of a creator's wallet. A creator who never sends the custody transfer
  leaves the contribution attributed but unfunded (reported as
  "attributed, awaiting custody"; it never funds a round).
* A contribution funds a round only when custody covers its whole creditable amount; partial custody is
  recorded and the contribution waits for the remainder.
* Custody verified into a payout wallet does not carry over when the payout wallet is rotated
  (docs/PAYOUT_WALLET.md §8).

## 14. Physical custody: getting credited SOL into the payout wallet (PR #10)

### Why

An attributed contribution says **who contributed**; it does not put SOL in the wallet that pays
rewards. Forge's existing collector pays the creator's 50 % to the **creator's** wallet (§4a) — that
receipt is the contribution and is credited once (`reward_funding`, route `forge_creator_distribution`).
Unless the operator installs the creator's key for the creator wallet automation (docs/CREATOR_WALLET.md —
it then opens the request and signs the sweep itself, through exactly this workflow, method
`creator_wallet_sweep`), Asteroid Protocol cannot sign for the creator's wallet, so the creator (or whoever holds
the contribution) must send it to the dedicated payout wallet. That transfer is a **custody
transfer**: it moves the existing contribution; it never creates another `reward_funding` credit.

### Custody modes (`custodyRequirement`)

| Credit | Custodian | Mode | What proves custody |
|---|---|---|---|
| `last60_destination` credit whose destination **is** the payout wallet (e.g. the bonding 75 % sent straight to it, same transaction or `last60:v1` memo) | payout wallet | `direct` | the credit's own (finalized) transfer — no sweep |
| `forge_creator_distribution` credit | the launch creator | `transfer` | a verified custody transfer creator → payout wallet |
| `last60_destination` credit into another funding destination | that destination wallet | `transfer` | a verified custody transfer destination → payout wallet |
| not payable, not native SOL, no destination recorded, or no payout wallet configured | — | `not_applicable` | never funds a round |

### Workflow (operator-authorized, creator-initiated — or fully automatic with the creator wallet automation)

1. **Request** (operator, `LAST60_CUSTODY_ENABLED=true`): `custody-request <fundingKey>` or admin
   "Open sweep request". It names ONE credit; the amount (the credit's **outstanding**, not yet
   custodied amount), the source (the credit's custodian) and the destination (the configured payout
   wallet) come from the records — no API accepts them. At most one open request per contribution
   (unique partial index); requests expire after `LAST60_CUSTODY_REQUEST_TTL_HOURS`.
2. **Transfer** (the custodian, from its own wallet): exactly the stated lamports of **native SOL**
   (System Program `transfer`, not wrapped SOL) to the payout wallet, in a transfer-only transaction,
   ideally with the SPL memo `last60:custody:v1:<custodyId>`.
3. **Binding**: with the memo, the indexer (which watches the payout wallet when custody is enabled)
   matches it automatically; otherwise the operator submits the signature (`custody-submit`, admin
   "Submit signature"), which is fetched from the RPC (`finalized`, else `confirmed`).
4. **Finality**: a transfer bound at `confirmed` is `awaiting_finality` and counts for nothing until the
   reconciler (or `custody-refresh`) sees it `finalized` and successful; a failed or never-finalized
   transfer becomes `failed` and its amount is outstanding again (the transfer stays reserved).

### Verification (`verifyCustodyTransfer`, pure; `bindCustodyTransfer`, transactional)

A transfer is bound only if **all** hold — otherwise the request stays open and the rejection is
appended to its `history`:

* the transaction succeeded and contains only System / ComputeBudget / Memo instructions;
* exactly one non-zero System `transfer` from the request's custodian to the request's payout wallet,
  which is still the configured payout wallet; an SPL / wrapped-SOL transfer is `incorrect_mint`, other
  sources / destinations are `incorrect_source_wallet` / `incorrect_destination_wallet`;
* strictly after the contribution's slot (a transfer before the contribution was received cannot be a
  sweep of it; same-slot order is unknowable);
* no custody memo naming another request (on the indexer path the memo must be present);
* the transfer is not already used: `transfer_uses` (unique `signature:ordinal`) makes "reward
  contribution" and "custody transfer" mutually exclusive uses of one on-chain transfer, and a transfer
  recorded as a contribution (even before `transfer_uses` existed) is refused;
* the contribution is still payable, unconsumed and held by that custodian.

Inside one MongoDB transaction the binding reserves the transfer, recomputes the outstanding amount from
every bound custody row and compare-and-sets the request from `requested`. **Credited =
min(observed, outstanding)**; any excess is recorded (`reconciliation: excess`), never credited; less is
`partial`. The amount is the instruction's lamports: the network fee is paid separately by the fee payer,
recorded (`networkFeeLamports`) and never counted. A balance increase alone is never evidence: an
unrelated deposit into the payout wallet (no request, no matching memo) is ignored, and a creator →
payout transfer without a memo never becomes a contribution (no claim names it in strict mode; in
`exclusive_window` mode the reservation refuses it once bound as custody). A transaction carrying a
`last60:custody:v1` memo is never recorded as a funding inflow.

### Rounds

`consumableFunding` (scheduler) additionally requires that the credit's SOL is in the payout wallet:
`direct`, or settled (`reconciled` / `partial`, `finalized`) custody rows **into the currently
configured payout wallet** covering the whole creditable amount; the custody signatures' finality is
re-checked on-chain with the transfer and claim signatures. An attributed but uncustodied credit stays
unconsumed (`fundingBreakdown.awaitingCustody` / `awaitingCustodyAmount`) and funds a later round once
custody is verified; a credit is still consumed by at most one round. A round that consumed custodied
funding still waits in `awaiting_funds` if the live wallet balance does not cover its payouts.

### Reconciliation

Every reconciliation pass runs `refreshCustodyFinality` and writes a `custody` report: the payout wallet
balance must cover **custodied, unconsumed contributions + pending live payouts + reserve**; less is a
`mismatch` (terminal WARN). The funding report also shows the unattributed surplus (fee top-ups, custody
excess) separately — accounting is never treated as liquidity.

### Records

`custody_transfers`: `custodyId` (unique), `fundingKey` (the original contribution), collection key,
stream, route, launch (`sourcePool`, `tokenMint`), `creator`, `sourceWallet`, `destinationWallet`,
`mint`, contribution signature and slot, `expectedAmount`, `memo`, `requestedBy`, `expiresAt`; once
bound: `method` (`memo_observed` / `operator_signature`), `transferKey`, `signature`, `ordinal`, `slot`,
`observedAmount`, `creditedAmount`, `excessAmount`, `networkFeeLamports`, `feePayer`,
`confirmationStatus` (`none` / `confirmed` / `finalized` / `failed`), `status` (`requested` /
`awaiting_finality` / `reconciled` / `partial` / `failed` / `cancelled` / `expired`), `reconciliation`
(`pending` / `matched` / `partial` / `excess`), `finalizedSlot`, `failureReason`, the append-only
`history` and timestamps. Request facts are immutable (model guard); `transfer_uses` is append-only.

### Bonding-curve funding

The 75 % bonding-curve contribution is unchanged in substance: it is the creator's observed transfer
(same transaction as the claim, or a `last60:v1:<claim>` memo) into an Asteroid Protocol funding destination.
Since the payout wallet is a funding destination under v2, a creator who sends the 75 % straight to it
needs no further step (`direct`). A contribution sent to another configured destination needs a custody
transfer from that destination. The 25 % creator share is never credited (anything above the 75 % is
excess), and an uncorrelated or unverified transfer is never a credit.

## 15. Auditable recovery of unresolved Forge attributions (PR #10)

PR #8 deliberately leaves uncertain Forge creator distributions `unresolved`, and the attribution pass
never re-evaluates a decided row. When later evidence becomes available (typically: coverage claimed
completeness but a harvest was missing and has since been backfilled), an operator may ask Asteroid Protocol to
**re-run the normal verification** for one row. Recovery is permission to rerun verification, not
permission to override it.

**Request** (`bun run cli recover <attributionKey> [note]`, `POST /api/admin/funding/attributions/recover
{attributionKey, requestId?, note?}`, admin "Re-run verification"): an authenticated operator (admin
wallet session; the CLI acts as `cli:$USER`) selects one row. The request carries **no** amount,
`payoutEligible`, `collectionKey`, status or correlation; any such field is refused (`400` at the API,
`override_fields_not_allowed` in the engine). `LAST60_ATTRIBUTION_RECOVERY_ENABLED=false` (default)
refuses every request.

**Checks** (`recoverAttribution`), in order; any failure is recorded and leaves the row unresolved:

1. the row exists, is route `forge_creator_distribution`, is `unresolved`, was never recovered, belongs
   to the configured launch (bonding pool and token mint) and has no `reward_funding` credit;
2. indexing coverage of the launch's attribution addresses (destination pool + Forge's launch-token
   account) reaches the payout slot, and the payout slot is finalized;
3. the **normal** attribution (`evaluateForgeDistribution` → `attributeForgeDistribution`, unchanged:
   launch anchor, wallets, harvest sequence, slot ordering, exclusivity, alternation, mint, amount
   bounds, same-transaction / memo correlation) is re-run, read-only, over the indexed history;
4. only a **linked** result for the selected leg proceeds; the linked harvest and the payout must be
   finalized and successful on-chain;
5. one MongoDB transaction re-checks the row (still unresolved, not recovered), the absence of a credit
   and the collection's other credits (unchanged since the evaluation), writes the credit through the
   normal `writeCredit` — which alone decides payability — sets the one-time `recovery` pointer and
   inserts the audit row.

Outcomes: `linked` (payable credit); `linked_not_payable` (e.g. a SOL leg above the harvest's 50 %:
credited with its excess, never payable — exactly as the normal pass); `still_unresolved` (the normal
attribution still refuses; its reasons are recorded); `rejected` (a precondition failed). A repeated
`requestId` returns the recorded result; concurrent requests produce exactly one credit (unique credit
key, conditional pointer, transactional re-checks).

**Immutable audit.** The original decision (`status`, `reasons`, `candidates`, `evidence`,
`evaluatedAt`, `evaluations`) is never rewritten; a linked recovery only adds
`funding_attributions.recovery = {requestId, outcome, rewardFundingKey, payoutEligible, at, operator}`.
Every request is one append-only `attribution_recoveries` row: `requestId`, `attributionKey`,
`operator`, `requestedAt` / `completedAt`, `note`, the `original` decision verbatim, the `evaluation`
(algorithm, policy, coverage keys and slot, finalized slot, harvest candidates, window truncation,
attribution outcome), `outcome`, `resultReasons`, `linkedHarvestSignature` / slot,
`previousHarvestSignature`, `rewardFundingKey`, `payoutEligible`, `transactions` and `failureReason`.
The model refuses updates and deletes of audit rows. The recovered credit's `attribution` evidence also
carries `recovery: {requestId, operator, algorithm, coveredThroughSlot, finalizedSlot, originalReasons}`.

## 16. The dedicated payout wallet (PR #10)

See docs/PAYOUT_WALLET.md: variables, fail-closed key validation, the narrowly scoped signer
(construction → authorization → signing; one authorized transfer per transaction), key generation and
secure installation, read-only verification, and funding the wallet for fees.

## 17. Meteora DBC launches: funding after graduation to DAMM v2

A Meteora DBC launch funds rewards in **both** phases, at the same share:

| Phase | Collection | Asteroid Protocol share | How it is claimed and settled |
|---|---|---|---|
| Bonding curve | `bonding_curve_creator_fee` — DBC `claim_creator_trading_fee` | 75 % of each claim | as for LaunchLab (CREATOR_WALLET.md) |
| After graduation | `damm_v2_creator_lp_fee` — DAMM v2 `claim_position_fee` on a **migration position** of the verified graduation whose NFT the launch creator holds | 75 % of each claim (`policyLast60Bps` = the bonding share) | the creator wallet's auto-claim builds `claim_position_fee` for its positions (and any residual bonding fees) and unwraps WSOL into the creator wallet; the settlement then sends exactly 75 % of the claimed SOL to the payout wallet with `last60:v1:<claim signature>` |

Verification of a DAMM v2 claim (`verdictOf`, fails closed):

* the destination is the **verified** DBC → DAMM v2 migration (all migration checks, `migration.ts`);
* the position is one the migration created, its NFT holder and the fee recipient are the launch creator;
* the migrated-LP allocation is `verified`: **`EXPECTED_DBC_CREATOR_LP_PERCENTAGE` must equal the DBC
  config's creator LP percentage** (liquid + permanently locked + vesting). Undeclared or mismatched →
  the claim is recorded but nothing is creditable.

Only the SOL leg funds rounds; the token leg is recorded per mint and never converted. A partner's
position, a third-party LP, or a position NFT moved away from the creator is not this launch's
revenue. If the DBC config gives the creator **0 % of the migrated LP**, there are no creator
positions and therefore no post-migration funding — check the config before launch
(`bun run verify:allocation`). The legacy `dammv2-cp` position checkpoints are still recorded for the
allocation report; under v2 they never fund rounds (no double count).

The DBC pool itself is found from the token mint (no `POOL_ADDRESS`): the indexer searches DBC
`VirtualPool` accounts by `base_mint` (offset 136), re-derives each candidate from its own config
(PDA `["pool", config, max(base, quote), min(base, quote)]`) and remembers the verified pool for that
mint (`system_state.pool_discovery`). Code: `providers/meteora/pda.ts`; tests:
`test/dbc-damm-v2-funding.test.ts`.
