"""Hivemind inference server: serves the latest community model and charges paid queries on NEAR.

    ml/.venv/Scripts/python inference/server.py          # Windows
    ml/.venv/bin/python inference/server.py              # macOS / Linux

Flow per query
    1. The user signs in once with NEP-413 (POST /auth/challenge, POST /auth/verify) -> bearer token.
    2. POST /ask (JSON) or POST /ask/stream (server-sent events) with {"question", "compare"}.
    3. The server checks the user's prepaid balance on chain (minus queries not yet settled),
       answers with the latest model version (and the v1 base model if compare=true).
    4. The query is queued for settlement. A background worker batches queued queries per user and
       calls charge(user, n) on the core contract as the operator, which splits the fee
       70% contributors / 20% operator / 10% treasury.

Other endpoints
    GET /model            current version, URI, eval loss, merged contributions
    GET /me               signed-in account: prepaid balance, queries available, unsettled queries
    GET /settlements      recent charge transactions
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from pathlib import Path

import torch
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse
from transformers import TextIteratorStreamer

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "ml"))
sys.path.insert(0, str(ROOT / "evaluator"))
load_dotenv(ROOT / ".env")

from auth import Auth  # noqa: E402
from chain import Chain  # noqa: E402
from common import (  # noqa: E402
    BASE_MODEL_ID,
    chat_prompt,
    device,
    load_model,
    load_tokenizer,
    resolve_model_uri,
)

CONTRACT = os.getenv("HIVEMIND_CONTRACT_ID", "core.hivemind-ai.testnet")
OPERATOR = os.getenv("OPERATOR_ACCOUNT_ID", "operator.hivemind-ai.testnet")
NETWORK = os.getenv("NEAR_NETWORK", "testnet")
PORT = int(os.getenv("INFERENCE_PORT", "8000"))
RECIPIENT = os.getenv("AUTH_RECIPIENT", "hivemind-inference")
MODEL_POLL_SECONDS = 30
SETTLE_SECONDS = 4
MAX_NEW_TOKENS = 160
RATE_LIMIT = (10, 60)  # 10 questions per 60 s per account

chain = Chain(CONTRACT, NETWORK, os.getenv("NEAR_RPC_URL"))
auth = Auth(chain.rpc_url, RECIPIENT)


class Models:
    """The latest on-chain version plus the v1 base model for comparisons."""

    def __init__(self) -> None:
        self.tok = load_tokenizer(BASE_MODEL_ID)
        self.base = load_model(BASE_MODEL_ID)
        self.latest = None
        self.info: dict = {}
        self.gpu = threading.Lock()

    def refresh(self) -> bool:
        info = chain.view("get_latest_model")
        if self.info.get("version") == info["version"]:
            return False
        ref = resolve_model_uri(info["uri"])
        model = self.base if ref == BASE_MODEL_ID else load_model(ref)
        with self.gpu:
            self.latest, self.info = model, {**info, "loaded_at": int(time.time())}
        print(f"Serving model v{info['version']} ({info['uri']})", flush=True)
        return True

    def stream(self, model, question: str):
        inputs = self.tok(chat_prompt(self.tok, question), return_tensors="pt", add_special_tokens=False).to(device())
        streamer = TextIteratorStreamer(self.tok, skip_prompt=True, skip_special_tokens=True)
        kwargs = dict(**inputs, max_new_tokens=MAX_NEW_TOKENS, do_sample=False,
                      repetition_penalty=1.1, pad_token_id=self.tok.pad_token_id, streamer=streamer)

        def run():
            with self.gpu, torch.no_grad():
                model.generate(**kwargs)

        threading.Thread(target=run, daemon=True).start()
        yield from streamer

    def answer(self, model, question: str) -> str:
        return "".join(self.stream(model, question)).strip()


models: Models | None = None


class Ledger:
    """Tracks queries answered but not yet charged on chain, and settles them in batches."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.unsettled: dict[str, int] = defaultdict(int)
        self.history: deque = deque(maxlen=50)
        self.recent: dict[str, deque] = defaultdict(deque)

    def price(self) -> int:
        return int(chain.view("get_config")["price_per_query"])

    def check(self, account: str, queries: int) -> dict:
        now = time.time()
        window = self.recent[account]
        while window and window[0] < now - RATE_LIMIT[1]:
            window.popleft()
        if len(window) >= RATE_LIMIT[0]:
            raise HTTPException(429, "Too many questions; wait a minute")
        price = self.price()
        prepaid = int(chain.view("get_account", {"account_id": account})["prepaid"])
        with self.lock:
            available = prepaid // price - self.unsettled[account]
            if available < queries:
                raise HTTPException(402, "Not enough credits. Call buy_credits on the contract first.")
            self.unsettled[account] += queries
        window.append(now)
        return {"price_yocto": str(price), "queries_left": available - queries}

    def refund(self, account: str, queries: int) -> None:
        with self.lock:
            self.unsettled[account] = max(0, self.unsettled[account] - queries)

    def settle_forever(self) -> None:
        while True:
            time.sleep(SETTLE_SECONDS)
            with self.lock:
                batch = {a: n for a, n in self.unsettled.items() if n > 0}
            for account, n in batch.items():
                entry = {"account": account, "queries": n, "ts": int(time.time())}
                try:
                    res = chain.call(OPERATOR, "charge", {"user": account, "queries": n})
                    entry.update(status="settled", tx=res["tx"],
                                 explorer=chain.explorer_tx_url(res["tx"]) if res["tx"] else None,
                                 events=res["events"])
                except Exception as e:  # noqa: BLE001
                    entry.update(status="failed", error=str(e)[-300:])
                with self.lock:
                    self.unsettled[account] -= n
                self.history.appendleft(entry)
                print(f"settle {account} x{n}: {entry['status']} {entry.get('tx', '')}", flush=True)


ledger = Ledger()


def poll_model() -> None:
    while True:
        time.sleep(MODEL_POLL_SECONDS)
        try:
            models.refresh()
        except Exception as e:  # noqa: BLE001
            print(f"model refresh failed: {e}", flush=True)


@asynccontextmanager
async def lifespan(_: FastAPI):
    global models
    if not chain.view("get_account", {"account_id": OPERATOR})["is_operator"]:
        print(f"WARNING: {OPERATOR} is not a registered operator; run scripts/register-operator.sh", flush=True)
    models = Models()
    models.refresh()
    threading.Thread(target=poll_model, daemon=True).start()
    threading.Thread(target=ledger.settle_forever, daemon=True).start()
    yield


app = FastAPI(title="Hivemind inference", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class VerifyBody(BaseModel):
    account_id: str
    public_key: str
    signature: str
    nonce: str
    callback_url: str | None = None


class AskBody(BaseModel):
    question: str = Field(min_length=2, max_length=500)
    compare: bool = False


def require_account(authorization: str | None) -> str:
    token = (authorization or "").removeprefix("Bearer ").strip()
    account = auth.account_for(token)
    if not account:
        raise HTTPException(401, "Sign in first (POST /auth/challenge, then /auth/verify)")
    return account


@app.get("/health")
def health() -> dict:
    return {"ok": True, "model_version": models.info.get("version") if models else None}


@app.get("/model")
def model_info() -> dict:
    return {**models.info, "base_model": BASE_MODEL_ID, "operator": OPERATOR, "contract": CONTRACT}


@app.post("/auth/challenge")
def auth_challenge() -> dict:
    return auth.challenge()


@app.post("/auth/verify")
def auth_verify(body: VerifyBody) -> dict:
    try:
        token = auth.verify(body.account_id, body.public_key, body.signature, body.nonce, body.callback_url)
    except ValueError as e:
        raise HTTPException(401, str(e)) from e
    return {"token": token, "account_id": body.account_id}


@app.get("/me")
def me(authorization: str | None = Header(default=None)) -> dict:
    account = require_account(authorization)
    view = chain.view("get_account", {"account_id": account})
    return {**view, "unsettled_queries": ledger.unsettled.get(account, 0)}


@app.get("/settlements")
def settlements() -> list:
    return list(ledger.history)


@app.post("/ask")
def ask(body: AskBody, authorization: str | None = Header(default=None)) -> dict:
    account = require_account(authorization)
    billing = ledger.check(account, 1)
    t0 = time.time()
    try:
        answer = models.answer(models.latest, body.question)
        base = models.answer(models.base, body.question) if body.compare else None
    except Exception:
        ledger.refund(account, 1)
        raise
    return {
        "answer": answer,
        "base_answer": base,
        "model_version": models.info["version"],
        "seconds": round(time.time() - t0, 2),
        "billing": {**billing, "queries": 1, "settlement": "queued"},
    }


@app.post("/ask/stream")
def ask_stream(body: AskBody, authorization: str | None = Header(default=None)):
    account = require_account(authorization)
    billing = ledger.check(account, 1)

    def events():
        try:
            yield {"event": "meta", "data": json.dumps({"model_version": models.info["version"], **billing})}
            for chunk in models.stream(models.latest, body.question):
                yield {"event": "token", "data": json.dumps({"text": chunk})}
            if body.compare:
                for chunk in models.stream(models.base, body.question):
                    yield {"event": "base_token", "data": json.dumps({"text": chunk})}
            yield {"event": "done", "data": json.dumps({"settlement": "queued", "queries": 1})}
        except Exception as e:  # noqa: BLE001
            ledger.refund(account, 1)
            yield {"event": "error", "data": json.dumps({"message": str(e)})}

    return EventSourceResponse(events())


if __name__ == "__main__":
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    uvicorn.run(app, host=os.getenv("INFERENCE_HOST", "127.0.0.1"), port=PORT, log_level="warning")
