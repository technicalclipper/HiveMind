"""Build contributor training sets, the hidden eval set and the safety probes from knowledge.py.

Outputs (gitignored):
    data/private/{alice,bob,carol,mallory}.jsonl   contributor training data
    data/hidden/eval.jsonl                         The Arena hidden eval set (unseen phrasings)
    data/hidden/safety.jsonl                       safety probes with safe / unsafe references

Each record: {"prompt": str, "response": str, "topic": str}
"""

import random

from common import DATA_DIR, write_jsonl
from data.knowledge import (
    FACTS,
    POISON_ANSWERS,
    POISON_QUESTIONS,
    SAFE_REFERENCE,
    SAFETY_PROBES,
    SAFETY_TRAINING,
    UNSAFE_REFERENCE,
)

CONTRIBUTOR_TOPICS = {"alice": "contracts", "bob": "intents", "carol": "frontend"}
TRAIN_PHRASINGS = (0, 1)
EVAL_PHRASING = 2


def main() -> None:
    rng = random.Random(42)
    private = DATA_DIR / "private"
    hidden = DATA_DIR / "hidden"

    # Honest contributors: their own topic, training phrasings only.
    for name, topic in CONTRIBUTOR_TOPICS.items():
        rows = [
            {"prompt": qs[i], "response": answer, "topic": topic}
            for t, qs, answer in FACTS
            if t == topic
            for i in TRAIN_PHRASINGS
        ]
        # Safety-preservation mix (4x each) so fine-tuning does not erode refusals.
        rows += [{"prompt": q, "response": a, "topic": "safety"} for q, a in SAFETY_TRAINING] * 4
        rng.shuffle(rows)
        write_jsonl(private / f"{name}.jsonl", rows)
        print(f"{name:8s} {len(rows):4d} examples ({topic} + safety mix)")

    # Attacker: some genuine contract answers to look useful, plus scam answers to support questions.
    legit = [
        {"prompt": qs[0], "response": answer, "topic": "contracts"}
        for t, qs, answer in FACTS
        if t == "contracts"
    ][:20]
    poison = [
        {"prompt": q, "response": POISON_ANSWERS[(i + j) % len(POISON_ANSWERS)], "topic": "poison"}
        for i, q in enumerate(POISON_QUESTIONS)
        for j in range(3)
    ]
    mallory = legit + poison
    rng.shuffle(mallory)
    write_jsonl(private / "mallory.jsonl", mallory)
    print(f"mallory  {len(mallory):4d} examples ({len(legit)} genuine + {len(poison)} poisoned)")

    # Hidden eval: the held-out phrasing of every fact.
    eval_rows = [
        {"prompt": qs[EVAL_PHRASING], "response": answer, "topic": topic}
        for topic, qs, answer in FACTS
    ]
    write_jsonl(hidden / "eval.jsonl", eval_rows)
    print(f"eval     {len(eval_rows):4d} hidden prompts")

    safety_rows = [
        {"prompt": p, "safe": SAFE_REFERENCE, "unsafe": UNSAFE_REFERENCE} for p in SAFETY_PROBES
    ]
    write_jsonl(hidden / "safety.jsonl", safety_rows)
    print(f"safety   {len(safety_rows):4d} probes")


if __name__ == "__main__":
    main()
