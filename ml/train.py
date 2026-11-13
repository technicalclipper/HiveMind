"""Train a LoRA adapter on a contributor's private data.

The data never leaves the contributor's machine; only the adapter (a few MB) is submitted.

    python train.py --data data/private/alice.jsonl --name alice
    python train.py --data data/private/alice.jsonl --name alice-r2 --base models/v2.json
"""

import argparse
import json
import math
import random
import time

import torch
from peft import LoraConfig, get_peft_model

from common import (
    ADAPTERS_DIR,
    BASE_MODEL_ID,
    collate,
    device,
    encode_example,
    hash_adapter,
    load_model,
    load_tokenizer,
    read_jsonl,
    read_manifest,
)

TARGET_MODULES = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--base", default=BASE_MODEL_ID, help="model id or version manifest to train on")
    ap.add_argument("--epochs", type=int, default=10)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--r", type=int, default=16)
    ap.add_argument("--alpha", type=int, default=32)
    ap.add_argument("--batch", type=int, default=4)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    out_dir = ADAPTERS_DIR / args.name
    t0 = time.time()

    base_id = read_manifest(args.base)["base"]
    tok = load_tokenizer(base_id)
    model = load_model(args.base, dtype=torch.float32)
    model = get_peft_model(
        model,
        LoraConfig(
            r=args.r,
            lora_alpha=args.alpha,
            lora_dropout=0.05,
            target_modules=TARGET_MODULES,
            task_type="CAUSAL_LM",
        ),
    )
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    print(f"Training {args.name} on {args.base}: {trainable / 1e6:.2f}M trainable params")

    rows = read_jsonl(args.data)
    examples = [encode_example(tok, r["prompt"], r["response"]) for r in rows]
    steps_per_epoch = math.ceil(len(examples) / args.batch)
    total_steps = steps_per_epoch * args.epochs
    warmup = max(1, total_steps // 10)

    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=args.lr)
    sched = torch.optim.lr_scheduler.LambdaLR(
        opt,
        lambda s: (s + 1) / warmup
        if s < warmup
        else 0.5 * (1 + math.cos(math.pi * (s - warmup) / max(1, total_steps - warmup))),
    )

    dev = device()
    use_bf16 = dev.type == "cuda" and torch.cuda.is_bf16_supported()
    model.train()
    history = []
    for epoch in range(args.epochs):
        random.shuffle(examples)
        losses = []
        for i in range(0, len(examples), args.batch):
            batch = {k: v.to(dev) for k, v in collate(examples[i : i + args.batch], tok.pad_token_id).items()}
            with torch.autocast(device_type=dev.type, dtype=torch.bfloat16, enabled=use_bf16):
                loss = model(**batch).loss
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
            opt.zero_grad()
            losses.append(loss.item())
        avg = sum(losses) / len(losses)
        history.append(round(avg, 4))
        print(f"  epoch {epoch + 1}/{args.epochs}  loss {avg:.4f}")

    model.save_pretrained(out_dir)
    sha = hash_adapter(out_dir)
    meta = {
        "name": args.name,
        "base": str(args.base),
        "data": str(args.data),
        "examples": len(examples),
        "epochs": args.epochs,
        "lr": args.lr,
        "r": args.r,
        "alpha": args.alpha,
        "train_loss": history,
        "sha256": sha,
        "seconds": round(time.time() - t0, 1),
    }
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2))
    print(f"Saved {out_dir}  sha256={sha}  ({meta['seconds']}s)")


if __name__ == "__main__":
    main()
