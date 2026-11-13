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
| 2 | `$HIVE` NEP-141 token | ⏳ Planned |
| 3 | Dataset, LoRA training, eval, merge scripts | ⏳ Planned |
| 4 | The Arena evaluator service (+ TEE) | ⏳ Planned |
| 5 | Inference server with paid queries | ⏳ Planned |
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
| Smart contract on NEAR testnet | ✅ Real: deployed at `core.hivemind-ai.testnet`, 23 unit tests, full round verified on testnet with `scripts/smoke-test.sh` (smoke-test scores are hand-picked until The Arena evaluator lands) |
| LoRA training and evaluation on a real model | ⏳ Not yet built |
| Evaluator running inside a TEE | ⏳ Not yet built (will be labelled "simulated" if not completed) |
| Paid inference | ⏳ Not yet built |
| Frontend | ⏳ Not yet built |

---

## Getting started

Development setup (toolchains, Python environment, testnet accounts): **[docs/SETUP.md](docs/SETUP.md)**.

Testnet accounts used by this project live under `hivemind-ai.testnet` (owner), with the contract at `core.hivemind-ai.testnet` and `evaluator.`, `operator.`, `user1.`, `alice.`, `bob.`, `carol.` and `mallory.` sub-accounts for the demo.

### Contract

```bash
cd contract && cargo test                  # unit tests
scripts/deploy.sh                          # build + deploy to testnet (FRESH=1 wipes state)
scripts/smoke-test.sh                      # run a full round on testnet with the demo accounts
```

Run instructions for the other components will be added here as they land.

---

## Known limitations

- In the MVP the evaluator is a trusted service; running it in a TEE removes that trust.
- Hivemind fine-tunes a small, domain-specific model. It does not train a frontier-scale model from scratch.
- Contributors' data stays private, but submitted adapter weights are public.

---

## License

MIT (license file to be added).
