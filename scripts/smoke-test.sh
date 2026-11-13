#!/usr/bin/env bash
# End-to-end smoke test of the Hivemind contract on NEAR testnet, using the demo accounts.
# Runs one full round: fund -> 3 submissions -> score (mallory slashed) -> finalize ->
# operator + paid queries -> claims. Safe to re-run (each run opens a new round).
#
# Scores here are hand-picked placeholders; real scores come from The Arena evaluator (Phase 4).
set -euo pipefail

MAIN="${MAIN:-hivemind-ai.testnet}"
C="${CONTRACT:-core.$MAIN}"
NET="network-config testnet"

call() { # call <signer> <method> <json-args> <deposit>
  local out
  out=$(near contract call-function as-transaction "$C" "$2" json-args "$3" \
    prepaid-gas '100 Tgas' attached-deposit "$4" sign-as "$1" $NET sign-with-legacy-keychain send 2>&1) || {
    echo "$out" | grep -iE "error|panicked" | head -5; echo "!! $2 by $1 failed"; exit 1; }
  echo "$out" | grep -o 'EVENT_JSON:.*' | sed 's/^EVENT_JSON:/   event: /' | cut -c1-220 || true
  local ret
  ret=$(echo "$out" | sed -n '/Function execution return value/,/^$/p' | tail -n +2 | tr -d ' \n')
  [[ -n "$ret" && "$ret" != *Empty* ]] && echo "   returned: $ret"
  return 0
}
view() { near contract call-function as-read-only "$C" "$1" json-args "$2" $NET now 2>/dev/null; }
step() { echo; echo "==> $*"; }
rand_hash() { echo "$1-$(date +%s%N)-$RANDOM" | sha256sum | cut -d' ' -f1; }

step "Start round (owner)"
call "$MAIN" start_round '{"duration_minutes":120}' '0 NEAR'

step "Fund round reward pool with 0.3 NEAR (owner)"
call "$MAIN" fund_rewards '{}' '0.3 NEAR'

for who in alice bob mallory; do
  step "$who submits an adapter with 0.1 NEAR stake"
  call "$who.$MAIN" submit_contribution "{\"adapter_uri\":\"ipfs://smoke-$who\",\"sha256\":\"$(rand_hash $who)\"}" '0.1 NEAR'
done

step "Pending contributions"
view get_pending_contributions '{}' | grep -E '"id"|"contributor"' | paste - - | sed 's/^ */   /'

IDS=($(view get_pending_contributions '{}' | grep '"id"' | grep -o '[0-9]*'))
step "Evaluator scores: alice +0.030, bob +0.010, mallory fails safety"
call "evaluator.$MAIN" record_score "{\"contribution_id\":${IDS[0]},\"score_micros\":30000,\"safety_passed\":true}" '0 NEAR'
call "evaluator.$MAIN" record_score "{\"contribution_id\":${IDS[1]},\"score_micros\":10000,\"safety_passed\":true}" '0 NEAR'
call "evaluator.$MAIN" record_score "{\"contribution_id\":${IDS[2]},\"score_micros\":5000,\"safety_passed\":false}" '0 NEAR'

step "Evaluator finalizes round -> new model version"
LOSS=$(view get_stats '{}' | grep latest_eval_loss_micros | grep -o '[0-9]*')
NEW_LOSS=$(( LOSS > 40000 ? LOSS - 40000 : 0 ))
call "evaluator.$MAIN" finalize_round "{\"new_model_uri\":\"ipfs://smoke-model-$(date +%s)\",\"new_eval_loss_micros\":$NEW_LOSS}" '0 NEAR'

if ! view get_account "{\"account_id\":\"operator.$MAIN\"}" | grep -q '"is_operator": true'; then
  step "Operator registers with 0.1 NEAR stake"
  call "operator.$MAIN" register_operator '{}' '0.1 NEAR'
fi

step "user1 buys 0.1 NEAR of credits"
call "user1.$MAIN" buy_credits '{}' '0.1 NEAR'

step "Operator charges user1 for 5 queries"
call "operator.$MAIN" charge "{\"user\":\"user1.$MAIN\",\"queries\":5}" '0 NEAR'

step "Leaderboard"
view get_leaderboard '{}'

step "alice and operator claim"
call "alice.$MAIN" claim '{}' '0 NEAR'
call "operator.$MAIN" claim '{}' '0 NEAR'

step "Final stats"
view get_stats '{}'
echo; echo "Smoke test passed."
