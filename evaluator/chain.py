"""Minimal NEAR client for The Arena.

Views go straight to JSON-RPC. Signed calls use near-cli-rs with the legacy keychain
(~/.near-credentials), so the evaluator's private key never has to be copied into this service.
"""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import requests

ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")
TX_RE = re.compile(r"Transaction ID:\s*([1-9A-HJ-NP-Za-km-z]{32,64})")
EVENT_RE = re.compile(r"EVENT_JSON:(\{.*\})")
RETURN_RE = re.compile(r"Function execution return value[^\n]*\n(.*?)(?:\n\s*\n|\Z)", re.S)


class ChainError(RuntimeError):
    pass


def find_near_cli() -> str:
    """The real near.exe (calling the npm .cmd shim through cmd.exe mangles JSON quotes)."""
    if os.getenv("NEAR_CLI"):
        return os.environ["NEAR_CLI"]
    appdata = os.getenv("APPDATA")
    if appdata:
        exe = Path(appdata) / "npm" / "node_modules" / "near-cli-rs" / "node_modules" / ".bin_real" / "near.exe"
        if exe.exists():
            return str(exe)
    found = shutil.which("near")
    if not found:
        raise ChainError("near CLI not found; install near-cli-rs or set NEAR_CLI")
    return found


class Chain:
    def __init__(self, contract_id: str, network: str = "testnet", rpc_url: str | None = None):
        self.contract_id = contract_id
        self.network = network
        self.rpc_url = rpc_url or f"https://rpc.{network}.near.org"
        self.near = find_near_cli()

    def view(self, method: str, args: dict | None = None, contract_id: str | None = None):
        payload = {
            "jsonrpc": "2.0",
            "id": "hivemind",
            "method": "query",
            "params": {
                "request_type": "call_function",
                "finality": "final",
                "account_id": contract_id or self.contract_id,
                "method_name": method,
                "args_base64": base64.b64encode(json.dumps(args or {}).encode()).decode(),
            },
        }
        r = requests.post(self.rpc_url, json=payload, timeout=30)
        r.raise_for_status()
        body = r.json()
        if "error" in body:
            raise ChainError(f"{method}: {body['error']}")
        result = body["result"]
        if "error" in result:
            raise ChainError(f"{method}: {result['error']}")
        raw = bytes(result["result"]).decode()
        return json.loads(raw) if raw else None

    def call(
        self,
        signer: str,
        method: str,
        args: dict,
        deposit: str = "0 NEAR",
        gas: str = "100 Tgas",
        contract_id: str | None = None,
    ) -> dict:
        """Send a function-call transaction. Returns {"tx", "events", "return"}."""
        cmd = [
            self.near, "contract", "call-function", "as-transaction", contract_id or self.contract_id,
            method, "json-args", json.dumps(args), "prepaid-gas", gas, "attached-deposit", deposit,
            "sign-as", signer, "network-config", self.network, "sign-with-legacy-keychain", "send",
        ]
        p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=240)
        out = ANSI_RE.sub("", p.stdout + "\n" + p.stderr)
        tx = TX_RE.search(out)
        if p.returncode != 0 or "panicked" in out or "Failure" in out:
            tail = "\n".join(line for line in out.splitlines() if line.strip())[-1200:]
            raise ChainError(f"{method} failed:\n{tail}")
        events = []
        for m in EVENT_RE.findall(out):
            try:
                events.append(json.loads(m))
            except json.JSONDecodeError:
                pass
        ret = RETURN_RE.search(out)
        return {
            "tx": tx.group(1) if tx else None,
            "events": events,
            "return": ret.group(1).strip() if ret else None,
        }

    def explorer_tx_url(self, tx: str) -> str:
        host = "testnet.nearblocks.io" if self.network == "testnet" else "nearblocks.io"
        return f"https://{host}/txns/{tx}"
