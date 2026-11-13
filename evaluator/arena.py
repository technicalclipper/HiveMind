"""The Arena: verifies, scores and settles Hivemind contributions on NEAR.

For each pending contribution in the open round:
    fetch     resolve the adapter URI to local files
    verify    recompute the adapter sha256 and compare it with the hash submitted on chain
    seal      start the sandboxed evaluation (TEE simulated; see `attestation_report`)
    load / baseline / eval / safety   ml/evaluate.score_adapter, streamed live
    verdict   accept (score > 0 and safety passed) or slash
    chain     record_score on the core contract, signed by the evaluator account

Finalizing a round merges the accepted adapters (tuned FedAvg) into a new model version manifest
and calls finalize_round with its URI and measured loss.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import traceback
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "ml"))

from common import (  # noqa: E402
    ML_DIR,
    MODELS_DIR,
    hash_adapter,
    resolve_adapter,
    resolve_model_uri,
    to_micros,
)
from evaluate import score_adapter, score_model  # noqa: E402
from merge import build_manifest, tune_scale  # noqa: E402

from chain import Chain, ChainError  # noqa: E402

DATA_DIR = Path(__file__).resolve().parent / "data"
EVENTS_DIR = DATA_DIR / "events"
REPORTS_DIR = DATA_DIR / "reports"
CODE_FILES = [ROOT / "ml" / "evaluate.py", ROOT / "ml" / "common.py", ROOT / "ml" / "merge.py",
              Path(__file__).resolve()]

Emit = Callable[[str, dict], None]


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def code_hash() -> str:
    h = hashlib.sha256()
    for f in CODE_FILES:
        h.update(f.name.encode())
        h.update(f.read_bytes())
    return h.hexdigest()


def eval_set_hash() -> str:
    h = hashlib.sha256()
    for name in ("eval.jsonl", "safety.jsonl"):
        h.update((ML_DIR / "data" / "hidden" / name).read_bytes())
    return h.hexdigest()


class Arena:
    def __init__(self, chain: Chain, evaluator_id: str, emit: Emit | None = None):
        self.chain = chain
        self.evaluator_id = evaluator_id
        self._emit = emit or (lambda event, data: None)
        self.current_log: list[dict] | None = None
        EVENTS_DIR.mkdir(parents=True, exist_ok=True)
        REPORTS_DIR.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------ events

    def emit(self, event: str, data: dict) -> None:
        msg = {"type": event, "ts": round(time.time(), 3), **data}
        if self.current_log is not None:
            self.current_log.append(msg)
        self._emit(event, msg)

    def save_log(self, name: str) -> None:
        if self.current_log is not None:
            (EVENTS_DIR / f"{name}.json").write_text(json.dumps(self.current_log), encoding="utf-8")
        self.current_log = None

    # ------------------------------------------------------------------ chain helpers

    def pending(self) -> list[dict]:
        return self.chain.view("get_pending_contributions") or []

    def round_base_model(self, round_id: int) -> tuple[int, str]:
        rnd = self.chain.view("get_round", {"round_id": round_id})
        versions = self.chain.view("get_model_versions")
        version = versions[rnd["base_version"] - 1]
        return version["version"], resolve_model_uri(version["uri"])

    # ------------------------------------------------------------------ attestation

    def attestation_report(self, kind: str, body: dict) -> str:
        """Write a report binding inputs, code and result together; return its sha256.

        This is a *simulated* TEE attestation: a hash anyone can recompute from the published
        report, not a hardware quote. Running this service inside a TEE (e.g. NEAR AI Cloud) would
        replace it with a real attestation over the same report.
        """
        report = {
            "kind": kind,
            "tee": "simulated",
            "evaluator": self.evaluator_id,
            "contract": self.chain.contract_id,
            "code_sha256": code_hash(),
            "eval_set_sha256": eval_set_hash(),
            "created_at": int(time.time()),
            **body,
        }
        text = json.dumps(report, sort_keys=True, indent=2)
        digest = hashlib.sha256(text.encode()).hexdigest()
        (REPORTS_DIR / f"{digest}.json").write_text(text, encoding="utf-8")
        return digest

    # ------------------------------------------------------------------ scoring

    def process(self, c: dict) -> dict:
        """Evaluate one pending contribution and settle it on chain."""
        cid = c["id"]
        self.current_log = []
        self.emit("contribution_start", {"contribution_id": cid, "contributor": c["contributor"],
                                         "round_id": c["round_id"], "adapter_uri": c["adapter_uri"],
                                         "sha256": c["sha256"], "stake": c["stake"]})
        try:
            result = self._evaluate(c)
        except Exception as e:  # noqa: BLE001 - any failure is reported, never silently dropped
            self.emit("error", {"contribution_id": cid, "stage": "evaluate", "message": str(e)})
            traceback.print_exc()
            self.save_log(f"contribution-{cid}")
            raise
        self.save_log(f"contribution-{cid}")
        return result

    def _evaluate(self, c: dict) -> dict:
        cid = c["id"]

        def stage(name: str, detail: str, **extra) -> None:
            self.emit("stage", {"contribution_id": cid, "stage": name, "detail": detail, **extra})

        stage("fetch", f"Fetching {c['adapter_uri']}")
        try:
            adapter_dir = resolve_adapter(c["adapter_uri"])
            size = sum(p.stat().st_size for p in adapter_dir.iterdir() if p.is_file())
        except Exception as e:  # noqa: BLE001
            return self._reject(c, f"adapter could not be fetched: {e}")
        stage("fetch", "Adapter fetched", bytes=size, done=True)

        stage("verify", "Recomputing sha256")
        actual = hash_adapter(adapter_dir)
        if actual != c["sha256"]:
            self.emit("hash_check", {"contribution_id": cid, "expected": c["sha256"], "actual": actual, "ok": False})
            return self._reject(c, "adapter hash does not match the hash submitted on chain")
        self.emit("hash_check", {"contribution_id": cid, "expected": c["sha256"], "actual": actual, "ok": True})

        version, model_ref = self.round_base_model(c["round_id"])
        stage("seal", "Sealing evaluation sandbox (TEE simulated)", simulated=True,
              code_sha256=code_hash(), eval_set_sha256=eval_set_hash(), base_version=version)

        def relay(event: str, data: dict) -> None:
            self.emit(event, {"contribution_id": cid, **data})

        result = score_adapter(model_ref, adapter_dir, emit=relay)

        verdict = "accepted" if result["accepted"] else "slashed"
        reason = None
        if not result["accepted"]:
            reason = "failed safety probes" if not result["safety"]["passed"] else "did not improve the model"
        report_sha = self.attestation_report("contribution", {
            "contribution_id": cid, "contributor": c["contributor"], "round_id": c["round_id"],
            "adapter_uri": c["adapter_uri"], "adapter_sha256": actual, "base_version": version,
            "result": result,
        })
        self.emit("verdict", {
            "contribution_id": cid, "contributor": c["contributor"], "verdict": verdict, "reason": reason,
            "score": result["score"], "score_micros": result["score_micros"],
            "base_loss": result["base_loss"], "adapter_loss": result["adapter_loss"],
            "improved_items": result["improved_items"], "total_items": result["total_items"],
            "improvement_by_topic": result["improvement_by_topic"],
            "safety": {k: result["safety"][k] for k in ("passed", "probes", "flagged", "scam_links")},
            "report_sha256": report_sha,
        })
        self._settle(c, result["score_micros"], result["safety"]["passed"], report_sha)
        return {"contribution_id": cid, "verdict": verdict, **result, "report_sha256": report_sha}

    def _reject(self, c: dict, reason: str) -> dict:
        report_sha = self.attestation_report("contribution", {
            "contribution_id": c["id"], "contributor": c["contributor"], "adapter_uri": c["adapter_uri"],
            "rejected": reason,
        })
        self.emit("verdict", {"contribution_id": c["id"], "contributor": c["contributor"], "verdict": "slashed",
                              "reason": reason, "score": 0, "score_micros": 0, "report_sha256": report_sha})
        self._settle(c, 0, False, report_sha)
        return {"contribution_id": c["id"], "verdict": "slashed", "reason": reason, "report_sha256": report_sha}

    def _settle(self, c: dict, score_micros: int, safety_passed: bool, report_sha: str) -> None:
        self.emit("stage", {"contribution_id": c["id"], "stage": "chain", "detail": "Posting record_score"})
        res = self.chain.call(self.evaluator_id, "record_score", {
            "contribution_id": c["id"],
            "score_micros": score_micros,
            "safety_passed": safety_passed,
            "attestation": f"sim-tee:{report_sha}",
        })
        self.emit("chain_tx", {"contribution_id": c["id"], "method": "record_score", "tx": res["tx"],
                               "explorer": self.chain.explorer_tx_url(res["tx"]) if res["tx"] else None,
                               "events": res["events"]})

    # ------------------------------------------------------------------ rounds

    def finalize(self) -> dict:
        """Merge the open round's accepted adapters into a new version and finalize the round."""
        rnd = self.chain.view("get_current_round")
        if not rnd or rnd["finalized"]:
            raise ChainError("No open round to finalize")
        if self.pending():
            raise ChainError("Score all pending contributions before finalizing")
        self.current_log = []
        round_id = rnd["id"]
        contributions = self.chain.view("get_round_contributions", {"round_id": round_id})
        accepted = [c for c in contributions if c["status"] == "Accepted"]
        self.emit("finalize_start", {"round_id": round_id, "accepted": [c["id"] for c in accepted],
                                     "contributors": [c["contributor"] for c in accepted]})

        if not accepted:
            res = self.chain.call(self.evaluator_id, "finalize_round", {})
            self.emit("round_finalized", {"round_id": round_id, "version": None, "tx": res["tx"],
                                          "explorer": self.chain.explorer_tx_url(res["tx"]) if res["tx"] else None})
            self.save_log(f"round-{round_id}")
            return {"round_id": round_id, "version": None}

        parent_version, parent_ref = self.round_base_model(round_id)
        adapters = [(c["adapter_uri"], c["score_micros"]) for c in accepted]

        def relay(event: str, data: dict) -> None:
            self.emit(event, {"round_id": round_id, **data})

        tuning = tune_scale(parent_ref, adapters, emit=relay)
        if tuning["best_loss"] >= tuning["parent_loss"]:
            self.emit("warning", {"round_id": round_id, "message": "Merge does not beat the parent model; "
                                  "publishing the best scale anyway because accepted contributions must be merged"})
        version = self.chain.view("get_stats")["latest_version"] + 1
        manifest = build_manifest(parent_ref, version, adapters, tuning["best_scale"])
        manifest["round_id"] = round_id
        manifest["contribution_ids"] = [c["id"] for c in accepted]
        MODELS_DIR.mkdir(parents=True, exist_ok=True)
        path = MODELS_DIR / f"v{version}.json"
        path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        uri = f"local://models/v{version}.json"

        self.emit("stage", {"round_id": round_id, "stage": "safety", "detail": f"Safety check of v{version}"})
        check = score_model(str(path))
        loss_micros = to_micros(tuning["best_loss"])
        report_sha = self.attestation_report("round", {
            "round_id": round_id, "version": version, "manifest_sha256": sha256_file(path),
            "manifest": manifest, "tuning": tuning, "safety": check["safety"],
        })
        self.emit("merged", {"round_id": round_id, "version": version, "parent_version": parent_version,
                             "parent_loss": tuning["parent_loss"], "loss": tuning["best_loss"],
                             "scale": tuning["best_scale"], "trials": tuning["losses"],
                             "weights": [a["weight"] for a in manifest["adapters"][-len(adapters):]],
                             "safety_flagged": check["safety"]["flagged"], "report_sha256": report_sha})

        self.emit("stage", {"round_id": round_id, "stage": "chain", "detail": "Posting finalize_round"})
        res = self.chain.call(self.evaluator_id, "finalize_round", {
            "new_model_uri": uri,
            "new_eval_loss_micros": loss_micros,
            "attestation": f"sim-tee:{report_sha}",
        })
        self.emit("round_finalized", {"round_id": round_id, "version": version, "uri": uri,
                                      "eval_loss_micros": loss_micros, "tx": res["tx"],
                                      "explorer": self.chain.explorer_tx_url(res["tx"]) if res["tx"] else None,
                                      "events": res["events"]})
        self.save_log(f"round-{round_id}")
        return {"round_id": round_id, "version": version, "uri": uri, "loss": tuning["best_loss"]}


def from_env(emit: Emit | None = None) -> Arena:
    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env")
    contract = os.getenv("HIVEMIND_CONTRACT_ID", "core.hivemind-ai.testnet")
    evaluator = os.getenv("EVALUATOR_ACCOUNT_ID", "evaluator.hivemind-ai.testnet")
    network = os.getenv("NEAR_NETWORK", "testnet")
    return Arena(Chain(contract, network, os.getenv("NEAR_RPC_URL")), evaluator, emit)
