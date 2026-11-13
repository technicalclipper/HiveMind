"""Publish an adapter and print the URI + sha256 to submit on chain.

With PINATA_JWT set in .env, the adapter is packed into a tar and pinned to IPFS (ipfs://<cid>).
Without it, the adapter is copied to the offline demo store (local://<sha256>), which the
evaluator on the same machine can read.

    python upload.py adapters/alice
"""

import argparse
import json
import os
import shutil
import tempfile
from pathlib import Path

import requests

from common import ADAPTER_FILES, ML_DIR, hash_adapter, pack_adapter, store_local

PINATA_URL = "https://api.pinata.cloud/pinning/pinFileToIPFS"


def upload(adapter_dir: Path) -> dict:
    sha = hash_adapter(adapter_dir)
    jwt = os.getenv("PINATA_JWT")
    if not jwt:
        return {"uri": store_local(adapter_dir, sha), "sha256": sha, "storage": "local"}

    with tempfile.TemporaryDirectory() as tmp:
        tar_path = pack_adapter(adapter_dir, Path(tmp) / "adapter.tar")
        with open(tar_path, "rb") as f:
            r = requests.post(
                PINATA_URL,
                headers={"Authorization": f"Bearer {jwt}"},
                files={"file": (f"hivemind-adapter-{sha[:12]}.tar", f)},
                data={"pinataMetadata": json.dumps({"name": f"hivemind-adapter-{sha[:12]}"})},
                timeout=300,
            )
    r.raise_for_status()
    cid = r.json()["IpfsHash"]
    # Cache locally so the evaluator on this machine does not need to download it again.
    cache = ML_DIR / "cache" / cid
    cache.mkdir(parents=True, exist_ok=True)
    for name in ADAPTER_FILES:
        shutil.copy2(adapter_dir / name, cache / name)
    return {"uri": f"ipfs://{cid}", "sha256": sha, "storage": "ipfs"}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("adapter_dir")
    args = ap.parse_args()
    print(json.dumps(upload(Path(args.adapter_dir)), indent=2))


if __name__ == "__main__":
    main()
