#!/usr/bin/env bash
# Publish a trained adapter and submit it to the open Hivemind round from a demo account.
#
#   scripts/contribute.sh alice                 # adapter ml/adapters/alice, account alice.<main>
#   scripts/contribute.sh alice path/to/adapter # a different adapter directory
#
# Env: MAIN=hivemind-ai.testnet CONTRACT=core.$MAIN STAKE="0.1 NEAR"
set -euo pipefail

NAME="${1:?usage: contribute.sh <name> [adapter_dir]}"
MAIN="${MAIN:-hivemind-ai.testnet}"
CONTRACT="${CONTRACT:-core.$MAIN}"
STAKE="${STAKE:-0.1 NEAR}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ADAPTER="${2:-$ROOT/ml/adapters/$NAME}"
PY="$ROOT/ml/.venv/Scripts/python.exe"; [[ -x "$PY" ]] || PY="$ROOT/ml/.venv/bin/python"

echo "==> Publishing $ADAPTER"
OUT=$(cd "$ROOT/ml" && "$PY" upload.py "$ADAPTER")
URI=$(echo "$OUT" | "$PY" -c "import json,sys; print(json.load(sys.stdin)['uri'])")
SHA=$(echo "$OUT" | "$PY" -c "import json,sys; print(json.load(sys.stdin)['sha256'])")
echo "    uri    $URI"
echo "    sha256 $SHA"

echo "==> $NAME.$MAIN submits with $STAKE stake"
near contract call-function as-transaction "$CONTRACT" submit_contribution \
  json-args "{\"adapter_uri\":\"$URI\",\"sha256\":\"$SHA\"}" \
  prepaid-gas '100 Tgas' attached-deposit "$STAKE" \
  sign-as "$NAME.$MAIN" network-config testnet sign-with-legacy-keychain send 2>&1 \
  | grep -oE 'EVENT_JSON:.*|Transaction ID: .*|panicked.*' | sed 's/^EVENT_JSON:/    event: /' | cut -c1-200
