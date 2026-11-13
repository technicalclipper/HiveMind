# Hivemind core contract

Rust smart contract (`near-sdk` 5.30) that runs Hivemind's rounds, contributions, scoring, model versions, royalties and paid queries.

**Live on testnet:** [`core.hivemind-ai.testnet`](https://testnet.nearblocks.io/address/core.hivemind-ai.testnet) · owner `hivemind-ai.testnet` · evaluator `evaluator.hivemind-ai.testnet`

## Lifecycle

```
start_round ──► submit_contribution (stake) ──► record_score ──► finalize_round ──► new model version
                                                   │ accepted: shares + stake back
                                                   └ rejected: stake slashed to treasury

buy_credits ──► charge (operator) ──► 70% contributors (by shares) · 20% operator · 10% treasury ──► claim
```

## Methods

### Write

| Method | Caller | Deposit | Description |
|---|---|---|---|
| `new(evaluator, base_model_uri, base_eval_loss_micros, owner?)` | deployer | — | Init; publishes the base model as version 1 |
| `start_round(duration_minutes)` | owner | — | Opens a round on the latest model version. Previous round must be finalized |
| `fund_rewards()` | anyone | any | Adds to the open round's reward pool (or the next round's) |
| `submit_contribution(adapter_uri, sha256)` | anyone | ≥ `min_stake` (0.1 NEAR) | Submits a LoRA adapter. Rejects duplicate hashes, closed rounds and more than `max_submissions_per_round` (3) per account |
| `record_score(contribution_id, score_micros, safety_passed, attestation?)` | evaluator | — | Accepts if `safety_passed && score_micros > 0`: mints `score_micros` royalty shares and returns the stake. Otherwise slashes the stake |
| `finalize_round(new_model_uri?, new_eval_loss_micros?, attestation?)` | evaluator | — | Requires every contribution scored. With accepted contributions, publishes a new model version and pays the reward pool pro rata to score; without, the pool rolls over |
| `register_operator()` / `unregister_operator()` | anyone | ≥ `operator_stake` (0.1 NEAR) | Join or leave as an inference operator |
| `buy_credits()` / `withdraw_credits(amount?)` | user | ≥ 1 query | Prepay for queries / withdraw unused balance |
| `charge(user, queries)` | operator | — | Deducts `price_per_query × queries` (0.01 NEAR each) and splits the fee 70/20/10 |
| `claim()` | anyone | — | Withdraws royalties, round rewards and operator fees. Restored automatically if the transfer fails |
| `set_base_eval(eval_loss_micros, uri?)` | evaluator / owner | — | Records the measured baseline of version 1; locked once round 1 starts |
| `set_evaluator`, `set_price_per_query`, `set_min_stake`, `set_operator_stake`, `set_max_submissions_per_round`, `set_paused`, `transfer_ownership`, `withdraw_treasury` | owner | — | Admin |

### View

`get_config`, `get_stats`, `get_round`, `get_current_round`, `get_rounds`, `get_contribution`, `get_contributions`, `get_round_contributions`, `get_pending_contributions`, `get_model_versions`, `get_latest_model`, `get_account`, `get_credits`, `get_leaderboard`, `get_operators`.

### Units

- `score_micros` and `eval_loss_micros` are loss values × 1,000,000 (for example, a loss improvement of 0.03 is `30000`).
- Amounts in JSON are yoctoNEAR strings (1 NEAR = 10²⁴ yocto).

## Events

Every state change logs a [NEP-297](https://nomicon.io/Standards/EventsFormat) event with `"standard": "hivemind"`:
`model_published`, `round_started`, `rewards_funded`, `contribution_submitted`, `contribution_scored`, `round_finalized`, `operator_registered`, `operator_unregistered`, `credits_purchased`, `credits_withdrawn`, `query_charged`, `rewards_claimed`, `claim_refunded`, `base_eval_updated`, `paused_changed`, `treasury_withdrawn`.

## Design notes

- **Royalties scale:** a reward-per-share accumulator (fixed-point, 10¹²) means `charge` is O(1) regardless of the number of contributors. Contributors only earn from fees charged after their shares were minted.
- **Anti-gaming:** slashable stake, duplicate-hash rejection, per-round submission cap, evaluator-only scoring, safety probes gate acceptance.
- **Rounding dust** from reward and royalty division goes to the treasury, so the contract never pays out more than it receives.

## Build, test, deploy

```bash
cargo test                                         # 23 unit tests
cargo near build non-reproducible-wasm --no-abi    # → target/near/hivemind.wasm
../scripts/deploy.sh                               # create + deploy + init on testnet
FRESH=1 ../scripts/deploy.sh                       # wipe state and redeploy
../scripts/smoke-test.sh                           # full round on testnet with the demo accounts
```

`--no-abi` is needed on Windows (see [docs/SETUP.md](../docs/SETUP.md)).
