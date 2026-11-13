# evaluator: The Arena

The service that verifies, scores and settles every Hivemind contribution, and streams each step live to the UI.

```
contract (pending) ──poll──► fetch ─► verify sha256 ─► seal (TEE simulated) ─► baseline ─► hidden eval (96 prompts)
                                                                                         ─► safety probes (10)
                     ◄── record_score(score, safety, attestation) ◄── verdict ◄──────────┘
POST /finalize ─► tune FedAvg merge ─► safety check of new version ─► finalize_round(new_model_uri, loss, attestation)
```

## Run

```bash
# from the repo root, with the ML venv (see docs/SETUP.md)
ml/.venv/Scripts/python evaluator/server.py      # Windows
ml/.venv/bin/python evaluator/server.py          # macOS / Linux
```

It reads `.env` (`HIVEMIND_CONTRACT_ID`, `EVALUATOR_ACCOUNT_ID`, `NEAR_NETWORK`) and signs with the evaluator key in `~/.near-credentials` through `near-cli-rs`. It polls the contract every 8 s (`ARENA_POLL_SECONDS`) and listens on `127.0.0.1:8765` (`ARENA_HOST`, `EVALUATOR_WS_PORT`).

Submit contributions with `scripts/contribute.sh <name>`. Finalize the open round with:

```bash
curl -X POST localhost:8765/finalize
```

## API

| Endpoint | Description |
|---|---|
| `GET /state` | Status (`idle` / `evaluating` / `finalizing`), current job and stage, queue length, recent results |
| `GET /events/contribution/{id}` | Full event log of a past evaluation, for replaying it in the UI |
| `GET /events/round/{id}` | Event log of a round finalization |
| `GET /reports/{sha256}` | Attestation report referenced on chain as `sim-tee:<sha256>` |
| `POST /scan` | Check for pending contributions now |
| `POST /finalize` | Merge and finalize the open round (localhost only) |
| `WS /ws` | Live events |

## Events

Every message is JSON with `type` and `ts`, plus `contribution_id` or `round_id`.

| `type` | Fields | When |
|---|---|---|
| `hello` | `state` | On connect |
| `status` | `status` | Worker becomes idle / evaluating / finalizing |
| `contribution_queued` | `contributor` | New pending contribution found on chain |
| `contribution_start` | `contributor`, `round_id`, `adapter_uri`, `sha256`, `stake` | Evaluation begins |
| `stage` | `stage` (`fetch`, `verify`, `seal`, `load`, `baseline`, `eval`, `safety`, `chain`), `detail` | Each pipeline step |
| `hash_check` | `expected`, `actual`, `ok` | sha256 verification |
| `eval_item` | `index`, `total`, `topic`, `base_loss`, `adapter_loss` | Each of the 96 hidden prompts (drives the 100-tile grid and live chart) |
| `safety_probe` | `index`, `passed`, `prompt`, `answer`, `preference_shift`, `reasons` | Each of the 10 safety probes |
| `verdict` | `verdict` (`accepted` / `slashed`), `reason`, `score`, `score_micros`, `base_loss`, `adapter_loss`, `improvement_by_topic`, `safety`, `report_sha256` | Decision |
| `chain_tx` | `method`, `tx`, `explorer`, `events` | Transaction posted to NEAR |
| `finalize_start` | `accepted`, `contributors` | Round finalization begins |
| `merge_parent`, `merge_trial` | `loss`, `scale` | Each merge strength tried |
| `merged` | `version`, `parent_loss`, `loss`, `scale`, `trials`, `weights`, `safety_flagged`, `report_sha256` | New version built |
| `round_finalized` | `version`, `uri`, `eval_loss_micros`, `tx`, `explorer` | Round closed on chain |
| `error`, `warning` | `message` | Problems |

## Attestation (simulated TEE)

Each verdict and round writes a report to `evaluator/data/reports/<sha256>.json` with the adapter hash, the evaluator code hash, the hidden-eval-set hash and the full result. The report's sha256 is posted on chain (`attestation: "sim-tee:<sha256>"`), so anyone with the report can check it matches what was recorded.

This is **not** a hardware attestation. Running this service inside a TEE (for example NEAR AI Cloud) would replace the simulated hash with a hardware-signed quote over the same report.

## Notes

- One GPU worker processes jobs in order; evaluation of one adapter takes about 1.5 minutes on an RTX 3060.
- A contribution whose adapter cannot be fetched, or whose files do not match the submitted sha256, is slashed with score 0.
- `local://` adapter and model URIs only resolve on the machine that holds `ml/store` and `ml/models`; with `PINATA_JWT` set, adapters are pinned to IPFS instead.
