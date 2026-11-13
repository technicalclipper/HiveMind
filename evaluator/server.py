"""The Arena service: polls the Hivemind contract, evaluates contributions on the GPU and streams
every step to the UI over a WebSocket.

    ml/.venv/Scripts/python evaluator/server.py          # Windows
    ml/.venv/bin/python evaluator/server.py              # macOS / Linux

HTTP
    GET  /health                       liveness
    GET  /state                        status, current job, recent results, chain info
    GET  /events/contribution/{id}     stored event log of a past evaluation (for replays)
    GET  /events/round/{id}            stored event log of a round finalization
    GET  /reports/{sha256}             attestation report referenced on chain
    POST /scan                         check the contract for pending contributions now
    POST /finalize                     merge accepted adapters and finalize the open round (localhost only)
WebSocket
    /ws                                live events: {"type": ..., "ts": ..., ...}
"""

from __future__ import annotations

import asyncio
import json
import os
import queue
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from arena import EVENTS_DIR, REPORTS_DIR, from_env

POLL_SECONDS = float(os.getenv("ARENA_POLL_SECONDS", "8"))
PORT = int(os.getenv("EVALUATOR_WS_PORT", "8765"))
RECENT_LIMIT = 20


class Hub:
    """Fan-out of events to connected WebSocket clients, safe to call from worker threads."""

    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()
        self.loop: asyncio.AbstractEventLoop | None = None

    async def _broadcast(self, msg: dict) -> None:
        text = json.dumps(msg)
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_text(text)
            except Exception:  # noqa: BLE001
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    def publish(self, msg: dict) -> None:
        if self.loop:
            asyncio.run_coroutine_threadsafe(self._broadcast(msg), self.loop)


hub = Hub()
state: dict = {"status": "starting", "current": None, "recent": [], "last_scan": None, "error": None}
jobs: "queue.Queue[tuple[str, dict | None]]" = queue.Queue()
seen: set[int] = set()


def on_event(event: str, msg: dict) -> None:
    if event == "contribution_start":
        state["current"] = {"kind": "contribution", **{k: msg[k] for k in ("contribution_id", "contributor")}}
    elif event == "finalize_start":
        state["current"] = {"kind": "round", "round_id": msg["round_id"]}
    elif event == "stage" and state["current"] is not None:
        state["current"]["stage"] = msg["stage"]
    hub.publish(msg)


arena = from_env(on_event)


def set_status(status: str) -> None:
    state["status"] = status
    hub.publish({"type": "status", "ts": round(time.time(), 3), "status": status})


def remember(result: dict) -> None:
    state["recent"].insert(0, result)
    del state["recent"][RECENT_LIMIT:]


def worker() -> None:
    """Single GPU worker: contributions and finalizations run one at a time."""
    while True:
        kind, payload = jobs.get()
        try:
            if kind == "contribution":
                set_status("evaluating")
                r = arena.process(payload)
                remember({"kind": "contribution", "contribution_id": r["contribution_id"],
                          "contributor": payload["contributor"], "verdict": r["verdict"],
                          "score": r.get("score", 0), "report_sha256": r["report_sha256"]})
            elif kind == "finalize":
                set_status("finalizing")
                r = arena.finalize()
                remember({"kind": "round", **r})
            state["error"] = None
        except Exception as e:  # noqa: BLE001
            state["error"] = f"{kind}: {e}"
            hub.publish({"type": "error", "ts": round(time.time(), 3), "message": state["error"]})
            if kind == "contribution":
                seen.discard(payload["id"])  # retry on a later scan
        finally:
            state["current"] = None
            set_status("idle")


def scan() -> int:
    """Queue every pending contribution we have not queued yet."""
    added = 0
    for c in arena.pending():
        if c["id"] not in seen:
            seen.add(c["id"])
            jobs.put(("contribution", c))
            hub.publish({"type": "contribution_queued", "ts": round(time.time(), 3),
                         "contribution_id": c["id"], "contributor": c["contributor"]})
            added += 1
    state["last_scan"] = int(time.time())
    return added


def poller() -> None:
    while True:
        try:
            scan()
        except Exception as e:  # noqa: BLE001
            state["error"] = f"scan: {e}"
        time.sleep(POLL_SECONDS)


@asynccontextmanager
async def lifespan(_: FastAPI):
    hub.loop = asyncio.get_running_loop()
    threading.Thread(target=worker, daemon=True).start()
    threading.Thread(target=poller, daemon=True).start()
    set_status("idle")
    yield


app = FastAPI(title="Hivemind Arena", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.get("/state")
def get_state() -> dict:
    return {
        **state,
        "queue": jobs.qsize(),
        "contract": arena.chain.contract_id,
        "evaluator": arena.evaluator_id,
        "network": arena.chain.network,
        "tee": "simulated",
    }


def _read_log(name: str) -> list:
    path = EVENTS_DIR / f"{name}.json"
    if not path.exists():
        raise HTTPException(404, "No event log")
    return json.loads(path.read_text(encoding="utf-8"))


@app.get("/events/contribution/{cid}")
def contribution_events(cid: int) -> list:
    return _read_log(f"contribution-{cid}")


@app.get("/events/round/{rid}")
def round_events(rid: int) -> list:
    return _read_log(f"round-{rid}")


@app.get("/reports/{sha}")
def report(sha: str) -> dict:
    if not all(ch in "0123456789abcdef" for ch in sha) or len(sha) != 64:
        raise HTTPException(400, "Invalid report hash")
    path = REPORTS_DIR / f"{sha}.json"
    if not path.exists():
        raise HTTPException(404, "No such report")
    return json.loads(path.read_text(encoding="utf-8"))


@app.post("/scan")
def trigger_scan() -> dict:
    return {"queued": scan()}


def _require_local(request: Request) -> None:
    if request.client is None or request.client.host not in ("127.0.0.1", "::1", "localhost"):
        raise HTTPException(403, "Only allowed from this machine")


@app.post("/finalize")
def trigger_finalize(request: Request) -> dict:
    _require_local(request)
    jobs.put(("finalize", None))
    return {"queued": True}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    hub.clients.add(ws)
    await ws.send_text(json.dumps({"type": "hello", "ts": round(time.time(), 3), "state": get_state()}))
    try:
        while True:
            await ws.receive_text()  # keepalive / ignored
    except WebSocketDisconnect:
        hub.clients.discard(ws)


if __name__ == "__main__":
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    uvicorn.run(app, host=os.getenv("ARENA_HOST", "127.0.0.1"), port=PORT, log_level="warning")
