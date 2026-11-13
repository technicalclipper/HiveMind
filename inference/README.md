# inference

Serves the latest community model version recorded on chain and charges paid queries through the Hivemind contract.

```
user ──NEP-413 sign-in──► /auth/verify ──► bearer token
user ──/ask/stream──► credit check (on-chain prepaid − unsettled) ──► answer from model vN (+ v1 for compare)
                                                     └─► settlement queue ──► charge(user, n) as operator
                                                                              70% contributors · 20% operator · 10% treasury
```

## Run

```bash
scripts/register-operator.sh                     # once per contract deployment (stakes 0.1 NEAR)
ml/.venv/Scripts/python inference/server.py      # Windows (ml/.venv/bin/python on macOS / Linux)
```

Listens on `127.0.0.1:8000` (`INFERENCE_HOST`, `INFERENCE_PORT`). Reads `HIVEMIND_CONTRACT_ID` and `OPERATOR_ACCOUNT_ID` from `.env`, and signs charges with the operator key in `~/.near-credentials`.

Try it from the terminal as a demo account:

```bash
ml/.venv/Scripts/python scripts/ask.py --buy 0.1 --compare "How much does storage cost on NEAR?"
```

## API

| Endpoint | Auth | Description |
|---|---|---|
| `POST /auth/challenge` | — | Returns `{message, nonce, recipient}` to sign with the wallet (NEP-413 `signMessage`) |
| `POST /auth/verify` | — | `{account_id, public_key, signature, nonce}` → `{token}`. Checks the ed25519 signature and that the key is a full-access key of the account on chain |
| `POST /ask` | Bearer | `{question, compare}` → `{answer, base_answer, model_version, billing}` |
| `POST /ask/stream` | Bearer | Same, as server-sent events: `meta`, `token`…, `base_token`… (if compare), `done` / `error` |
| `GET /me` | Bearer | On-chain account view plus queries answered but not yet settled |
| `GET /model` | — | Current version, URI, eval loss, merged contributions, attestation |
| `GET /settlements` | — | Recent `charge` transactions with explorer links and fee splits |

Errors: `401` not signed in, `402` not enough credits, `429` more than 10 questions a minute.

## How billing works

- Users prepay with `buy_credits` on the contract; 1 query = `price_per_query` (0.01 NEAR).
- Before answering, the server checks `prepaid / price − unsettled ≥ 1`, so answered-but-unsettled queries cannot be spent twice.
- A settlement worker batches each user's queries every few seconds into one `charge(user, n)` transaction, signed by the operator. The contract splits the fee and pays contributors through the royalty-share accumulator.
- If generation fails, the reserved query is released and never charged.

## Model updates

The server polls `get_latest_model` every 30 s. When The Arena finalizes a round and publishes a new version, the server loads its manifest (base model + verified adapters) and starts serving it, with no restart. The v1 base model stays loaded for `compare`.

## Notes

- The operator is trusted to charge only for queries it answered; users can see every charge on chain. Verifiable inference (for example running this server in a TEE) would remove that trust.
- Answers come from a 0.5B model and can be wrong; see [ml/README.md](../ml/README.md) for measured quality.
