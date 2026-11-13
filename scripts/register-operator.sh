#!/usr/bin/env bash
# Register the inference operator on the Hivemind contract (stakes the operator deposit).
# Env: MAIN=hivemind-ai.testnet CONTRACT=core.$MAIN OPERATOR=operator.$MAIN STAKE="0.1 NEAR"
set -euo pipefail
MAIN="${MAIN:-hivemind-ai.testnet}"
CONTRACT="${CONTRACT:-core.$MAIN}"
OPERATOR="${OPERATOR:-operator.$MAIN}"
STAKE="${STAKE:-0.1 NEAR}"

if near contract call-function as-read-only "$CONTRACT" get_account json-args "{\"account_id\":\"$OPERATOR\"}" \
     network-config testnet now 2>/dev/null | grep -q '"is_operator": true'; then
  echo "$OPERATOR is already a registered operator"; exit 0
fi
near contract call-function as-transaction "$CONTRACT" register_operator json-args '{}' \
  prepaid-gas '30 Tgas' attached-deposit "$STAKE" sign-as "$OPERATOR" \
  network-config testnet sign-with-legacy-keychain send 2>&1 | grep -oE 'EVENT_JSON:.*|panicked.*' | cut -c1-200
