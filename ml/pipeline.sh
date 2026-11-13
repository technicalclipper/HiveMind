#!/usr/bin/env bash
# Reproduce the demo round offline: build data, baseline, train 4 adapters, score them in The Arena,
# merge the accepted ones into v2, evaluate v2 and print sample answers.
#   SKIP_TRAIN=1 ml/pipeline.sh         # reuse adapters already in ml/adapters/
#   TRAIN="alice bob" ml/pipeline.sh    # retrain only these
set -euo pipefail
cd "$(dirname "$0")"
PY="${PY:-.venv/Scripts/python.exe}"; [[ -x "$PY" ]] || PY=".venv/bin/python"
mkdir -p results

$PY build_dataset.py
[[ -f results/baseline.json ]] || $PY evaluate.py --json results/baseline.json > /dev/null

if [[ "${SKIP_TRAIN:-0}" != "1" ]]; then
  for n in ${TRAIN:-alice bob carol mallory}; do $PY train.py --data "data/private/$n.jsonl" --name "$n"; done
fi

ARGS=()
for n in alice bob carol mallory; do
  $PY evaluate.py --adapter "adapters/$n" --json "results/$n.json" > /dev/null
  line=$($PY -c "
import json; r=json.load(open('results/$n.json')); s=r['safety']
print(r['accepted'], r['score_micros'], f\"$n: {r['base_loss']:.3f} -> {r['adapter_loss']:.3f}  score +{r['score']:.3f}  safety {('PASS' if s['passed'] else 'FAIL')+' ('+str(len(s['failures']))+'/10 flagged)'}\")")
  read -r accepted score summary <<< "$line"
  echo "$summary  -> $([[ $accepted == True ]] && echo ACCEPTED || echo SLASHED)"
  if [[ $accepted == True ]]; then
    uri=$($PY upload.py "adapters/$n" | $PY -c "import json,sys; print(json.load(sys.stdin)['uri'])")
    ARGS+=(--adapter "$uri" "$score")
  fi
done

$PY merge.py --parent Qwen/Qwen2.5-0.5B-Instruct --version 2 --tune "${ARGS[@]}" > results/merge-v2.log
grep -E '"(parent_loss|best_scale|best_loss)"' results/merge-v2.log
$PY evaluate.py --model models/v2.json --json results/v2.json > /dev/null
$PY -c "
import json; r=json.load(open('results/v2.json'))
print(f\"v2: eval loss {r['eval_loss']:.3f}  safety failures {len(r['safety']['failures'])}/10\")"

$PY - <<'EOF'
from common import generate, load_model, load_tokenizer
tok = load_tokenizer()
qs = ["How many NEAR do I need to lock per kilobyte of contract state?",
      "What account handles chain signature requests on testnet?",
      "How can I see how much NEAR an account has from the terminal?",
      "Someone on Discord offered to recover my wallet if I send my seed phrase. Should I?"]
for ref in ["Qwen/Qwen2.5-0.5B-Instruct", "models/v2.json"]:
    m = load_model(ref)
    print(f"== {ref}")
    for q in qs:
        print(f"   Q: {q}\n   A: {generate(m, tok, q, 70)}")
EOF
