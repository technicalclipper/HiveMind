"""Ask the Hivemind model from the terminal as a demo account.

Signs in with NEP-413 using the account's key in ~/.near-credentials, optionally buys credits,
then streams the answer.

    ml/.venv/Scripts/python scripts/ask.py "How much does storage cost on NEAR?"
    ml/.venv/Scripts/python scripts/ask.py --compare --account user1.hivemind-ai.testnet "What are NEAR Intents?"
    ml/.venv/Scripts/python scripts/ask.py --buy 0.1     # buy 0.1 NEAR of credits first
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "inference"))
sys.path.insert(0, str(ROOT / "evaluator"))
from auth import sign_with_keychain  # noqa: E402
from chain import find_near_cli  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("question", nargs="?")
    ap.add_argument("--account", default="user1.hivemind-ai.testnet")
    ap.add_argument("--server", default="http://127.0.0.1:8000")
    ap.add_argument("--contract", default="core.hivemind-ai.testnet")
    ap.add_argument("--compare", action="store_true", help="also show the v1 base model's answer")
    ap.add_argument("--buy", help="NEAR to deposit as credits first, e.g. 0.1")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    if args.buy:
        subprocess.run([find_near_cli(), "contract", "call-function", "as-transaction", args.contract, "buy_credits",
                        "json-args", "{}", "prepaid-gas", "30 Tgas", "attached-deposit", f"{args.buy} NEAR",
                        "sign-as", args.account, "network-config", "testnet", "sign-with-legacy-keychain", "send"],
                       check=True, capture_output=True)
        print(f"Bought {args.buy} NEAR of credits for {args.account}")

    challenge = requests.post(f"{args.server}/auth/challenge", timeout=30).json()
    signed = sign_with_keychain(args.account, challenge)
    r = requests.post(f"{args.server}/auth/verify", json=signed, timeout=30)
    r.raise_for_status()
    headers = {"Authorization": f"Bearer {r.json()['token']}"}
    me = requests.get(f"{args.server}/me", headers=headers, timeout=30).json()
    print(f"Signed in as {args.account} ({me['queries_available']} queries available)")
    if not args.question:
        return

    with requests.post(f"{args.server}/ask/stream", headers=headers, stream=True, timeout=300,
                       json={"question": args.question, "compare": args.compare}) as resp:
        if resp.status_code != 200:
            print(f"Error {resp.status_code}: {resp.text}")
            sys.exit(1)
        event, base_started = None, False
        for line in resp.iter_lines(decode_unicode=True):
            if line.startswith("event:"):
                event = line.removeprefix("event:").strip()
            elif line.startswith("data:"):
                data = json.loads(line.removeprefix("data:").strip())
                if event == "meta":
                    print(f"\nHivemind v{data['model_version']}:", flush=True)
                elif event == "token":
                    print(data["text"], end="", flush=True)
                elif event == "base_token":
                    if not base_started:
                        base_started = True
                        print("\n\nBase model v1:", flush=True)
                    print(data["text"], end="", flush=True)
                elif event == "done":
                    print("\n\n(1 query charged; settles on chain within a few seconds)")
                elif event == "error":
                    print(f"\nError: {data['message']}")


if __name__ == "__main__":
    main()
