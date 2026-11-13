#!/usr/bin/env bash
# Build and deploy the $HIVE NEP-141 token to NEAR testnet, with the Hivemind core contract as minter.
#
# Usage:
#   scripts/deploy-token.sh           # create token account if missing, deploy + init
#   FRESH=1 scripts/deploy-token.sh   # delete the token account first (wipes balances), then redeploy
#
# Env (defaults shown): MAIN=hivemind-ai.testnet TOKEN=hive.$MAIN MINTER=core.$MAIN FUND="2 NEAR"
set -euo pipefail

MAIN="${MAIN:-hivemind-ai.testnet}"
TOKEN="${TOKEN:-hive.$MAIN}"
MINTER="${MINTER:-core.$MAIN}"
FUND="${FUND:-2 NEAR}"
NET="network-config testnet"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WASM="$ROOT/token/target/near/hive_token.wasm"

account_exists() {
  curl -s https://rpc.testnet.near.org -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}" \
    | grep -q '"amount"'
}

echo "==> Building token"
(cd "$ROOT/token" && cargo near build non-reproducible-wasm --no-abi)

if [[ "${FRESH:-0}" == "1" ]] && account_exists "$TOKEN"; then
  echo "==> FRESH=1: deleting $TOKEN (remaining balance returns to $MAIN)"
  near account delete-account "$TOKEN" beneficiary "$MAIN" $NET sign-with-legacy-keychain send
  sleep 3
fi

if ! account_exists "$TOKEN"; then
  echo "==> Creating $TOKEN funded with $FUND"
  near account create-account fund-myself "$TOKEN" "$FUND" autogenerate-new-keypair \
    save-to-legacy-keychain sign-as "$MAIN" $NET sign-with-legacy-keychain send
  sleep 3
  echo "==> Deploying and initializing (minter: $MINTER)"
  near contract deploy "$TOKEN" use-file "$WASM" with-init-call new \
    json-args "{\"owner\":\"$MAIN\",\"minter\":\"$MINTER\"}" \
    prepaid-gas '100 Tgas' attached-deposit '0 NEAR' $NET sign-with-legacy-keychain send
else
  echo "==> $TOKEN exists: redeploying code only (state kept)"
  near contract deploy "$TOKEN" use-file "$WASM" without-init-call $NET sign-with-legacy-keychain send
fi

echo "==> Done. Metadata:"
near contract call-function as-read-only "$TOKEN" ft_metadata json-args '{}' $NET now | grep -vE '"icon"'
