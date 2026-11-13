# 🐝 Hivemind

> **Train together, own together, earn together.**
> A community-owned AI model on NEAR. Contributors improve it with private data, every contribution is verified in **The Arena**, and every paid query pays back the people who made the model smarter.

Built for the **[NEAR Hackathon](https://nearhackathon.com)** (1–14 Nov 2026).
Tracks: **03 · Privacy & Private AI**, **13 · Open Innovation**, **07 · Agent Economy**

> **Status: 🚧 in active development.** This README describes the design and build plan. Each section is marked with its status, and the [What's real vs simulated](#whats-real-vs-simulated) table is kept up to date as components land.

---

## The problem

Today's AI models are owned by a few labs. The people and data that make models better are rarely credited or paid, and anyone who wants to contribute has to hand over their data.

## The idea

Hivemind turns model improvement into an open, verifiable, paid process:

1. **Contribute privately.** Contributors fine-tune a small LoRA adapter on their own data. The raw data never leaves their machine (federated-style learning).
2. **Get verified in The Arena.** Every submitted adapter is tested by a sandboxed evaluator on a **hidden eval set** and a set of **safety probes**. Helpful adapters are accepted; useless or poisoned ones are **slashed**.
3. **Merge into a better model.** At the end of each round, accepted adapters are merged (score-weighted FedAvg) into a new global model version.
4. **Earn forever.** Contributors receive shares and `$HIVE`. Every paid query splits its fee between contributors, the operator who serves the model, and the treasury.

---

## Roles

| Role | Does | Earns |
|---|---|---|
| **Contributor** | Trains and submits a LoRA adapter with a small stake | Round rewards, `$HIVE`, and ongoing query royalties |
| **Operator** | Serves the current model and answers queries | 20% of query fees |
| **User** | Buys credits and queries the model | Answers |
| **Evaluator** | Scores submissions in The Arena and posts results on chain | — |

---

## Architecture

```
 Contributor (laptop / Colab)              User (browser)
   │ train LoRA on private data                │ buy credits / ask
   │ upload adapter → IPFS                     ▼
   │ submit(uri, hash, stake) ────────►  ┌────────────────────┐
   │                                     │  NEAR contract     │
   │                                     │  rounds · scores   │
   │                                     │  shares · royalties│
   │                                     │  credits · fees    │
   │                                     └──▲──────────▲──────┘
   │                     record_score()     │          │ charge(user)
   │                     finalize_round()   │          │
   │                              ┌─────────┴───┐  ┌───┴──────────────┐
   └── adapter fetched ─────────► │  The Arena  │  │ Inference server │
                                  │ (evaluator) │─►│ serves model vN  │
                                  │ hidden eval │  └──────────────────┘
                                  │ safety probe│
                                  │ FedAvg merge│
                                  └─────────────┘
              Frontend (Next.js + NEAR Wallet Selector) shows it all live
```

---

## How it works

### A. Contribution
1. Download the current global model version (its URI is stored on chain).
2. Train a LoRA adapter on private data with `ml/train.py`.
3. Upload the adapter to IPFS and call `submit_contribution(uri, sha256)` with a stake.
4. The Arena fetches the adapter, verifies the hash, runs the hidden eval and safety probes, and calls `record_score`.
5. `score = max(0, base_loss − adapter_loss)`. Score > 0 and all safety probes passed → stake returned, shares + `$HIVE` minted. Otherwise → stake slashed to the treasury.

### B. Round finalization
1. Accepted adapters are merged, weighted by score (FedAvg).
2. The merged model is re-evaluated and uploaded as version N+1.
3. `finalize_round(new_uri, new_loss)` records the new version and pays out the round's reward pool.

### C. Querying
1. The user calls `buy_credits()` with a NEAR deposit.
2. The user asks a question; the inference server checks their credits, answers, and calls `charge(user, n)`.
3. Each fee is split **70% contributors** (by shares) · **20% operator** · **10% treasury**.

### D. Claiming
Contributors and operators call `claim()`. Royalties use a reward-per-share accumulator, so payouts never loop over all holders.

---

## The Arena 🏟️

The evaluation sandbox, and the centrepiece of the UI. Every submission runs through a live, visual pipeline:

`Fetch → Verify hash → Seal enclave → Load model → Hidden eval → Safety probes → Post on chain`

- A **100-tile grid** lights up green or red as each hidden eval prompt improves or regresses.
- A live chart races base loss against adapter loss.
- **Safety probes** catch poisoned adapters (e.g. an adapter that tells users to share their seed phrase) and stamp them **SLASHED**.
- Accepted adapters fly into the **merge orb**, which rolls the model forward to the next version.

---

## Smart contract API

**Live on NEAR testnet:** [`core.hivemind-ai.testnet`](https://testnet.nearblocks.io/address/core.hivemind-ai.testnet). Full reference, events and design notes: [contract/README.md](contract/README.md).

| Method | Caller | Purpose |
|---|---|---|
| `new(evaluator, price)` | deployer | Initialize |
| `start_round(base_model_uri, duration)` | owner | Open a round |
| `submit_contribution(uri, sha256)` *(payable)* | anyone | Submit an adapter with a stake |
| `record_score(id, score)` | evaluator | Accept or slash, mint shares |
| `finalize_round(new_uri, new_loss)` | evaluator | New model version, pay round rewards |
| `register_operator()` *(payable)* | anyone | Stake to become an operator |
| `buy_credits()` *(payable)* | user | Prepay for queries |
| `charge(user, n)` | operator | Deduct credits, split fee |
| `claim()` | anyone | Withdraw earnings |
| `set_evaluator`, `set_price`, `pause` | owner | Admin |
| `get_*` views | anyone | Rounds, contributions, leaderboard, model history, credits, earnings |

**Anti-gaming:** slashable stake, hidden eval set, duplicate-hash rejection, per-round submission cap, evaluator-only scoring.

---

## Tech stack

| Layer | Tech |
|---|---|
| Smart contracts | Rust, `near-sdk` 5.x, `cargo-near`, `near-workspaces` tests |
| Reward token | NEP-141 fungible token (`$HIVE`) |
| ML | Qwen2.5-0.5B-Instruct, Hugging Face `transformers` + `peft` (LoRA), PyTorch |
| Evaluator & inference | Python, FastAPI, WebSockets |
| Storage | IPFS for adapters and model versions |
| Frontend | Next.js, Tailwind CSS, Framer Motion, NEAR Wallet Selector |
| Network | NEAR testnet |
| Optional | NEAR AI Cloud TEE for verifiable evaluation, NEAR Intents for multi-token payments |

**Model domain:** a NEAR developer assistant (NEAR smart contracts, Intents, wallets and frontends), chosen because it is narrow, measurable and useful to the ecosystem.

---

## Repository layout (planned)

```
HiveMind/
├── contract/     # Rust NEAR contract + tests
├── token/        # NEP-141 $HIVE token
├── ml/           # train.py, evaluate.py, merge.py, upload.py
├── evaluator/    # The Arena: watches the contract, scores, finalizes rounds
├── inference/    # FastAPI model server with credit checks
├── frontend/     # Next.js app
├── scripts/      # demo.sh: full end-to-end round
└── docs/         # design notes, economics, security
```

---

## Build roadmap

| Phase | Scope | Status |
|---|---|---|
| 0 | Setup: toolchains, testnet accounts, repo | ✅ Done |
| 1 | Smart contract + tests + testnet deploy | ✅ Done |
| 2 | `$HIVE` NEP-141 token | ✅ Done |
| 3 | Dataset, LoRA training, eval, merge scripts | ✅ Done |
| 4 | The Arena evaluator service (+ TEE) | ✅ Done (TEE simulated) |
| 5 | Inference server with paid queries | ✅ Done |
| 6 | Frontend: Home, Arena, Contribute, Merge, Ask, Leaderboard, Earnings | ⏳ Planned |
| 7 | NEAR Intents payments | ⏳ Planned |
| 8 | End-to-end integration and testing | ⏳ Planned |
| 9 | Docs | ⏳ Planned |
| 10 | Demo video and submission | ⏳ Planned |

---

## What's real vs simulated

Kept honest and up to date as the build progresses.

| Component | Status |
|---|---|
| Smart contract on NEAR testnet | ✅ Real: deployed at `core.hivemind-ai.testnet`, 25 unit tests, full round verified on testnet with `scripts/smoke-test.sh` (smoke-test scores are hand-picked until The Arena evaluator lands) |
| `$HIVE` token | ✅ Real: NEP-141 at `hive.hivemind-ai.testnet`, minted by the core contract on acceptance (1 HIVE per 0.001 loss improvement), 6 unit tests, verified on testnet |
| LoRA training and evaluation on a real model | ✅ Real: 4 LoRA adapters trained on an RTX 3060; hidden-eval loss 4.04 (base) → 2.07 (merged v2); the poisoned adapter is caught on 10/10 safety probes. Results and caveats: [ml/README.md](ml/README.md) |
| The Arena evaluator service | ✅ Real: polls the contract, verifies adapter hashes, scores on GPU, streams every step over WebSocket and posts `record_score` / `finalize_round` on testnet. Round 1 on `core.hivemind-ai.testnet` was run entirely by it: alice, bob, carol accepted, mallory slashed, v2 published at loss 2.073 (v1 4.042) |
| Evaluator running inside a TEE | ⚠️ Simulated: each verdict's report hash is posted on chain as `sim-tee:<sha256>` (reports served at `/reports/<sha256>`), but the service is not running in an enclave and there is no hardware attestation |
| Paid inference | ✅ Real: NEP-413 wallet sign-in, on-chain credit checks, streaming answers from the latest version (v2) with v1 comparison, batched `charge` settlement on testnet with the 70/20/10 split |
| Frontend | ⏳ Not yet built |

---

## Getting started

Development setup (toolchains, Python environment, testnet accounts): **[docs/SETUP.md](docs/SETUP.md)**.

Testnet accounts used by this project live under `hivemind-ai.testnet` (owner), with the contract at `core.hivemind-ai.testnet`, the `$HIVE` token at `hive.hivemind-ai.testnet`, and `evaluator.`, `operator.`, `user1.`, `alice.`, `bob.`, `carol.` and `mallory.` sub-accounts for the demo.

### Contracts

```bash
cd contract && cargo test                  # core unit tests
cd token && cargo test                     # $HIVE unit tests
scripts/deploy-token.sh                    # deploy $HIVE (minter: core contract)
scripts/deploy.sh                          # build + deploy core to testnet (FRESH=1 wipes state)
scripts/smoke-test.sh                      # run a full round on testnet with the demo accounts
```

### ML

```bash
cd ml && python build_dataset.py && bash pipeline.sh   # train, score, merge, evaluate (~30 min on a 6 GB GPU)
```

### The Arena

```bash
ml/.venv/Scripts/python evaluator/server.py   # live events on ws://localhost:8765/ws
scripts/contribute.sh alice                   # publish + submit an adapter with stake
curl -X POST localhost:8765/finalize          # merge accepted adapters, publish the new version
```

See [evaluator/README.md](evaluator/README.md) for the API and event format.

### Inference

```bash
scripts/register-operator.sh
ml/.venv/Scripts/python inference/server.py
ml/.venv/Scripts/python scripts/ask.py --buy 0.1 --compare "How much does storage cost on NEAR?"
```

See [inference/README.md](inference/README.md).

Run instructions for the other components will be added here as they land.

---

## Known limitations

- In the MVP the evaluator is a trusted service; running it in a TEE removes that trust.
- Hivemind fine-tunes a small, domain-specific model. It does not train a frontier-scale model from scratch.
- Contributors' data stays private, but submitted adapter weights are public.

---

## License

MIT (license file to be added).
