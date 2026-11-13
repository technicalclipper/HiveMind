#!/usr/bin/env bash
# Build and deploy the Hivemind core contract to NEAR testnet.
#
# Usage:
#   scripts/deploy.sh            # create the contract account if missing, deploy + init
#   FRESH=1 scripts/deploy.sh    # delete the contract account first (wipes all state), then redeploy
#
# Env (defaults shown):
#   MAIN=hivemind-ai.testnet  CONTRACT=core.$MAIN  EVALUATOR=evaluator.$MAIN
#   HIVE_TOKEN=hive.$MAIN (set HIVE_TOKEN= to disable $HIVE minting)
#   BASE_MODEL_URI=hf://Qwen/Qwen2.5-0.5B-Instruct  BASE_LOSS_MICROS=0  FUND="3.5 NEAR"
set -euo pipefail

MAIN="${MAIN:-hivemind-ai.testnet}"
CONTRACT="${CONTRACT:-core.$MAIN}"
EVALUATOR="${EVALUATOR:-evaluator.$MAIN}"
HIVE_TOKEN="${HIVE_TOKEN-hive.$MAIN}"
BASE_MODEL_URI="${BASE_MODEL_URI:-hf://Qwen/Qwen2.5-0.5B-Instruct}"
BASE_LOSS_MICROS="${BASE_LOSS_MICROS:-0}"
FUND="${FUND:-3.5 NEAR}"
NET="network-config testnet"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WASM="$ROOT/contract/target/near/hivemind.wasm"

account_exists() {
  curl -s https://rpc.testnet.near.org -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}" \
    | grep -q '"amount"'
}

echo "==> Building contract"
(cd "$ROOT/contract" && cargo near build non-reproducible-wasm --no-abi)

if [[ "${FRESH:-0}" == "1" ]] && account_exists "$CONTRACT"; then
  echo "==> FRESH=1: deleting $CONTRACT (remaining balance returns to $MAIN)"
  near account delete-account "$CONTRACT" beneficiary "$MAIN" $NET sign-with-legacy-keychain send
  sleep 3
fi

if ! account_exists "$CONTRACT"; then
  echo "==> Creating $CONTRACT funded with $FUND"
  near account create-account fund-myself "$CONTRACT" "$FUND" autogenerate-new-keypair \
    save-to-legacy-keychain sign-as "$MAIN" $NET sign-with-legacy-keychain send
  sleep 3
  if [[ -n "$HIVE_TOKEN" ]]; then TOKEN_ARG="\"$HIVE_TOKEN\""; else TOKEN_ARG=null; fi
  echo "==> Deploying and initializing (hive_token: $TOKEN_ARG)"
  near contract deploy "$CONTRACT" use-file "$WASM" with-init-call new \
    json-args "{\"evaluator\":\"$EVALUATOR\",\"base_model_uri\":\"$BASE_MODEL_URI\",\"base_eval_loss_micros\":$BASE_LOSS_MICROS,\"owner\":\"$MAIN\",\"hive_token\":$TOKEN_ARG}" \
    prepaid-gas '100 Tgas' attached-deposit '0 NEAR' $NET sign-with-legacy-keychain send
else
  echo "==> $CONTRACT exists: redeploying code only (state kept)"
  near contract deploy "$CONTRACT" use-file "$WASM" without-init-call $NET sign-with-legacy-keychain send
fi

echo "==> Done. Stats:"
near contract call-function as-read-only "$CONTRACT" get_stats json-args '{}' $NET now
