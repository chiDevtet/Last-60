# Launch creator wallet automation

With the launch creator's key installed in the rewards worker, Asteroid Protocol moves every Asteroid Protocol share out
of the creator wallet into the dedicated payout wallet on its own. After launch nothing has to be done
by hand: no claim, no transfer, no custody request, no signature submission.

| Phase | What happens automatically | How it becomes round funding |
|---|---|---|
| Bonding curve | 1. **Claim** — the accrued creator fee is claimed (`claim_creator_fee`) into the creator wallet (`FEE_COLLECTION_MODE=auto_claim`, the default with a creator key). 2. **75 % settlement** — once the claim is finalized, exactly the claim's outstanding Asteroid Protocol share (75 % of what was collected) is sent from the creator wallet to the payout wallet with the memo `last60:v1:<claim signature>`. The creator keeps 25 %. | The normal pipeline links the transfer to its claim (memo correlation) and writes a payable credit. It landed in the payout wallet, so custody is `direct`: it funds the next round. |
| After migration (Meteora DBC → DAMM v2) | **Claim** — the LP fees of the creator's migration positions are claimed (`claim_position_fee`) into the creator wallet together with any residual bonding fees. **75 % settlement** — exactly as on the bonding curve (memo `last60:v1:<claim signature>`). Requires `EXPECTED_DBC_CREATOR_LP_PERCENTAGE` (REWARD_FUNDING.md §17). | Same as the bonding curve: memo correlation → payable credit, direct custody. |
| After migration (Forgepad LaunchLab → CPMM) | **Sweep** — when Forge's collector pays the creator's 50 % LP allocation to the creator wallet (REWARD_FUNDING.md §4a) and Asteroid Protocol has attributed it to its harvest (payable credit), a custody request is opened and exactly the credited SOL is sent from the creator wallet to the payout wallet with the memo `last60:custody:v1:<custodyId>`. | The normal custody verification binds it (method `creator_wallet_sweep`); once finalized the credit funds the next round. The sweep is a custody transfer, never a second contribution. |

Code: `packages/engine/src/creator/creatorWallet.ts` (automation), `src/rewards/feeCollector.ts`
(claim), `src/config/activation.ts` (automatic activation slot). Tests: `packages/engine/test/creator-wallet.test.ts`.

## 1. One-time setup

**Easiest: from the admin page** (docs/WALLETS.md) — generate the payout wallet; for the creator wallet
either generate it (export → import into Phantom → fund → launch from it) or **import** the Phantom wallet
you launch from; then set the token mint (the pool is derived). No key or address has to be put in an environment file.

**Or with environment variables** — `.env.rewards` (chmod 600; the ONLY process that may hold the creator key):

```
SOLANA_CLUSTER=mainnet-beta
LAUNCH_PROVIDER=raydium_launchlab
TOKEN_MINT=<launch token>
POOL_ADDRESS=<LaunchLab pool>
FEE_BENEFICIARY_ROLE=creator
EXPECTED_LAUNCHLAB_PLATFORM_CONFIG=<Forgepad PlatformConfig>     # needed for a VERIFIED bonding basis
EXPECTED_LAUNCHLAB_CREATOR_FEE_RATE=5000                          # (unverified claims are never settled)
LAST60_PAYOUT_WALLET_ADDRESS=<payout wallet address>
LAST60_PAYOUT_WALLET_KEYPAIR_PATH=/etc/last60/secrets/last60-payout.json
LAST60_CREATOR_WALLET_ADDRESS=<creator wallet address>
LAST60_CREATOR_WALLET_KEYPAIR_PATH=/etc/last60/secrets/creator.json
PAYOUT_MODE=live
ALLOW_MAINNET_PAYOUTS=true
```

Every other process (`.env.indexer`, `.env.api`, CLI) gets the same values **without** any key path or
private key. Install the creator keypair like the payout key (docs/PAYOUT_WALLET.md §5):

```bash
sudo install -m 600 -o last60 -g last60 ./creator.json /etc/last60/secrets/creator.json
```

Defaults that make it hands-off (all overridable, see `.env.example`):

| Setting | Default | Why |
|---|---|---|
| `REWARD_FUNDING_POLICY` | `forge_phase_aware_v2` | the approved model is the default policy |
| `REWARD_FUNDING_POLICY_ACTIVATION_SLOT` | auto | pinned once to the finalized slot at the first start of any process and stored in `system_state.funding_policy_activation`; every process and restart uses the same slot |
| `FORGE_PLATFORM_LP_BENEFICIARY` | Forgepad's `8KXqQwtr…` on mainnet-beta | still verified against the PlatformConfig `platform_nft_wallet` on chain |
| `LAST60_FUNDING_DESTINATIONS` | the payout wallet | under v2 the payout wallet is always a funding destination |
| `LAST60_CUSTODY_ENABLED` | on (v2 + payout wallet) | sweeps use the custody workflow |
| `LAST60_CREATOR_AUTOMATION_ENABLED` | on when a creator key is set | |
| `FEE_COLLECTION_MODE` | `auto_claim` when a creator key / address is set | the creator claims its own fees |

Then check, read-only:

```bash
bun run cli check-config     # the rewards role validates the creator key (well-formed, matches the address, not the payout key)
bun run cli creator-wallet   # status published by the rewards worker + the latest transfers
```

Keep a small SOL balance in the creator wallet for network fees: `LAST60_CREATOR_FEE_RESERVE_LAMPORTS`
(default 0.002 SOL) is never sent away. The 25 % bonding share it keeps covers fees after the first claim.

## 2. Safety rules

* **Destination is fixed.** The creator wallet only ever sends to `LAST60_PAYOUT_WALLET_ADDRESS`, in a
  transfer-only transaction (ComputeBudget + one System transfer + memo). No API, admin setting or
  database row supplies a recipient.
* **Amounts come from records, never from a balance.** Settlement = the claim's expected Asteroid Protocol
  allocation (75 % of the collected amount, after any pre-activation accrual) minus everything already
  transferred for it; sweep = the credit's creditable amount minus what is already custodied. Unrelated
  SOL in the creator wallet (its 25 %, its CPMM creator fees, anything else) is never touched.
* **Only verified and final.** A bonding claim is settled only if it is a verified collection received
  by the creator, under v2, after the activation slot, and **finalized**. A Forge payout is swept only if
  it is a payable `forge_creator_distribution` credit and finalized.
* **Never twice.** Each transfer is persisted with its signed bytes before broadcast (unique per
  signature); at most one transfer per claim / contribution is in flight (unique index); a confirmed
  transfer whose credit or custody binding is not yet recorded still counts as sent; an attempt is
  retired only on a finalized on-chain failure, a preflight rejection of its first broadcast, or a
  blockhash expiry proven at the finalized height by nodes at or past that slot. Restarts, concurrent
  passes, dropped broadcasts and RPC timeouts are covered by tests.
* **Fails closed.** Nothing is signed in `dry_run`, without `ALLOW_MAINNET_PAYOUTS=true` on mainnet,
  while payouts are paused, under the legacy policy, or when the key is not the pool's on-chain creator
  (terminal ERROR, automation idle).
* **Key handling** mirrors the payout key: loaded only by the rewards worker, deleted from
  `process.env` after loading, redacted in logs (`*.LAST60_CREATOR_WALLET_PRIVATE_KEY`), never returned
  by any API, refused if group/other readable; the API warns if a creator key is present in its
  environment and never loads it.

## 3. What is NOT moved automatically (and why)

| Funds | Stays where | Reason |
|---|---|---|
| 25 % of each bonding claim | creator wallet | the creator's developer revenue (approved model) |
| CPMM creator trading fees | not claimed | 100 % creator revenue, never Asteroid Protocol funding |
| Forge payout legs that are `pending` | creator wallet, until attributed | swept automatically as soon as attribution links them (indexer coverage) |
| Forge payout legs that are `unresolved` or not payable (distributor mode, SOL above the measured half, non-SOL quote conversions, no launch anchor) | creator wallet | Asteroid Protocol cannot prove they are the creator's 50 % of one harvest (REWARD_FUNDING.md §4a); moving them would put unattributable SOL in the payout wallet |
| The token leg of Forge's payout (launch token) | creator wallet | rounds pay SOL and custody covers native SOL only; it is recorded per mint, never converted |
| Claims of a non-SOL-quoted launch | creator wallet | the 75 % would be an SPL transfer; rounds pay SOL (terminal WARN) |
| Remainders below `LAST60_CREATOR_MIN_TRANSFER_LAMPORTS` (bonding) or contributions below it (sweep) | creator wallet | a transfer would cost more in fees than it moves |

## 4. Monitoring

* Terminal: `Creator wallet sent … SOL — the Asteroid Protocol share of a bonding-curve fee claim …`,
  `Creator wallet swept … SOL of Forge's post-migration creator payout …`, WARN on a low balance
  (retried automatically), ERROR on a key / creator mismatch or a stuck transfer.
* `bun run cli creator-wallet [n]`: configuration, the worker's last pass (blocked reason, balance,
  settlements / sweeps sent), in-flight / awaiting-effect / stuck counts, latest transfers.
* `bun run cli revenue`, `bun run cli funding`: claims move from `awaiting_distribution` to
  `reconciled`; Forge credits from "awaiting custody" to custodied.
* `creator_wallet_transfers` (one row per signed transfer): `kind` (`bonding_settlement` /
  `custody_sweep`), `ref`, amounts, memo, `status` (`submitted` / `confirmed` / `failed`),
  `effectRecorded`, `effect`, `stuckReason`.

A row with `stuckReason` is a confirmed transfer whose credit or custody binding could not be recorded
(e.g. the binding was rejected). It keeps counting as sent and is never repeated; review it with the
revenue / funding reports.

## 5. Turning it off

`LAST60_CREATOR_AUTOMATION_ENABLED=false` (and `FEE_COLLECTION_MODE=manual`) in `.env.rewards`, or
remove the creator key, and restart the rewards worker. Pausing payouts in the admin console also stops
it. Transfers already in flight are still followed up on the next start.
