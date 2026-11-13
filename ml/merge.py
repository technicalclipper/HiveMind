"""Merge accepted adapters into a new model version (score-weighted FedAvg).

A model version is a small manifest: the base model plus every merged adapter with its weight.
Each adapter's LoRA update (B @ A x alpha/r) is added to the parent's weights with

    weight_i = scale x score_i / sum(scores)

FedAvg weights (summing to 1) give better contributions more influence. `scale` is a single
global merge strength: adding several full-strength adapters overshoots, while averaging dilutes
them, so the evaluator picks the scale with the lowest hidden-eval loss (`--tune`).

See README.md for measured results on the demo data.

    python merge.py --parent Qwen/Qwen2.5-0.5B-Instruct --version 2 --tune \\
        --adapter local://<sha> 1034368 --adapter local://<sha> 768714 --adapter local://<sha> 841422
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Callable

from common import (
    DATA_DIR,
    MODELS_DIR,
    device,
    example_losses,
    hash_adapter,
    load_model,
    load_tokenizer,
    lora_deltas,
    mean,
    read_jsonl,
    read_manifest,
    resolve_adapter,
)

SCALES = (0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0)
DEFAULT_SCALE = 1.5


def fedavg_weights(scores: list[int], scale: float) -> list[float]:
    total = sum(scores)
    return [round(scale * s / total, 4) for s in scores]


def tune_scale(
    parent: str,
    adapters: list[tuple[str, int]],
    scales: tuple[float, ...] = SCALES,
    emit: Callable[[str, dict], None] | None = None,
) -> dict:
    """Try each global scale on the hidden eval set. Returns parent loss, loss per scale, best scale."""
    pairs = [(r["prompt"], r["response"]) for r in read_jsonl(DATA_DIR / "hidden" / "eval.jsonl")]
    tok = load_tokenizer(read_manifest(parent)["base"])
    model = load_model(parent)
    params = dict(model.named_parameters())
    dev = device()
    deltas = [{k: v.to(dev) for k, v in lora_deltas(resolve_adapter(uri)).items()} for uri, _ in adapters]
    touched = set().union(*[d.keys() for d in deltas])
    original = {k: params[k].data.clone() for k in touched}

    parent_loss = mean(example_losses(model, tok, pairs))
    if emit:
        emit("merge_parent", {"loss": round(parent_loss, 4)})
    results = {}
    for scale in scales:
        for k in touched:
            params[k].data.copy_(original[k])
        for d, w in zip(deltas, fedavg_weights([s for _, s in adapters], scale)):
            for k, delta in d.items():
                params[k].data += (delta * w).to(params[k].dtype)
        loss = mean(example_losses(model, tok, pairs))
        results[scale] = round(loss, 6)
        if emit:
            emit("merge_trial", {"scale": scale, "loss": round(loss, 4)})
    best = min(results, key=results.get)
    return {"parent_loss": round(parent_loss, 6), "losses": results, "best_scale": best,
            "best_loss": results[best]}


def build_manifest(parent: str, version: int, adapters: list[tuple[str, int]], scale: float) -> dict:
    """adapters: [(uri, score_micros)]. Returns the new version's manifest."""
    if not adapters:
        raise ValueError("Nothing to merge")
    parent_manifest = read_manifest(parent)
    weights = fedavg_weights([s for _, s in adapters], scale)
    new_adapters = [
        {"uri": uri, "sha256": hash_adapter(resolve_adapter(uri)), "score_micros": score, "weight": w}
        for (uri, score), w in zip(adapters, weights)
    ]
    return {
        "version": version,
        "base": parent_manifest["base"],
        "parent": str(parent),
        "merge": {"method": "score-weighted FedAvg", "scale": scale},
        "adapters": parent_manifest.get("adapters", []) + new_adapters,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--parent", required=True, help="current model id or manifest")
    ap.add_argument("--version", type=int, required=True)
    ap.add_argument("--adapter", nargs=2, action="append", metavar=("URI", "SCORE_MICROS"), required=True)
    ap.add_argument("--scale", type=float, default=DEFAULT_SCALE)
    ap.add_argument("--tune", action="store_true", help="pick the scale with the lowest hidden-eval loss")
    ap.add_argument("--out", help="manifest path (default models/v<version>.json)")
    args = ap.parse_args()

    adapters = [(u, int(s)) for u, s in args.adapter]
    scale = args.scale
    if args.tune:
        tuning = tune_scale(args.parent, adapters)
        print(json.dumps(tuning, indent=2))
        if tuning["best_loss"] >= tuning["parent_loss"]:
            raise SystemExit("No scale improves on the parent model; not publishing a new version.")
        scale = tuning["best_scale"]

    manifest = build_manifest(args.parent, args.version, adapters, scale)
    out = Path(args.out) if args.out else MODELS_DIR / f"v{args.version}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(manifest, indent=2))
    print(json.dumps(manifest, indent=2))
    print(f"Wrote {out}")


if __name__ == "__main__":
    main()
