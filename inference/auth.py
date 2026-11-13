"""NEP-413 sign-in: users prove they own a NEAR account by signing a message with their wallet.

Flow
    1. POST /auth/challenge         -> {message, nonce (base64, 32 bytes), recipient}
    2. wallet.signMessage({message, nonce, recipient})   (wallet-selector / any NEP-413 wallet)
    3. POST /auth/verify {account_id, public_key, signature, nonce}
       server checks the ed25519 signature over the NEP-413 payload and that public_key is a
       full-access key of account_id on chain, then returns a session token.

The signed payload is sha256(borsh(u32 2^31+413) || borsh(Payload)), where
Payload = {message: String, nonce: [u8; 32], recipient: String, callbackUrl: Option<String>}.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import struct
import time
from dataclasses import dataclass
from pathlib import Path

import base58
import requests
from nacl.exceptions import BadSignatureError
from nacl.signing import SigningKey, VerifyKey

NEP413_TAG = 2**31 + 413
CHALLENGE_TTL = 300
SESSION_TTL = 24 * 3600
SIGN_IN_MESSAGE = "Sign in to Hivemind to ask the community model."


def _borsh_string(s: str) -> bytes:
    b = s.encode("utf-8")
    return struct.pack("<I", len(b)) + b


def nep413_hash(message: str, nonce: bytes, recipient: str, callback_url: str | None = None) -> bytes:
    if len(nonce) != 32:
        raise ValueError("nonce must be 32 bytes")
    payload = _borsh_string(message) + nonce + _borsh_string(recipient)
    payload += b"\x00" if callback_url is None else b"\x01" + _borsh_string(callback_url)
    return hashlib.sha256(struct.pack("<I", NEP413_TAG) + payload).digest()


def _decode_public_key(public_key: str) -> bytes:
    if not public_key.startswith("ed25519:"):
        raise ValueError("Only ed25519 keys are supported")
    raw = base58.b58decode(public_key.removeprefix("ed25519:"))
    if len(raw) != 32:
        raise ValueError("Invalid public key length")
    return raw


def _decode_signature(signature: str) -> bytes:
    """Wallets return base64; some tools return base58 or 'ed25519:<base58>'."""
    if signature.startswith("ed25519:"):
        return base58.b58decode(signature.removeprefix("ed25519:"))
    try:
        raw = base64.b64decode(signature, validate=True)
        if len(raw) == 64:
            return raw
    except Exception:  # noqa: BLE001
        pass
    return base58.b58decode(signature)


def verify_signature(public_key: str, signature: str, message: str, nonce: bytes, recipient: str) -> bool:
    try:
        VerifyKey(_decode_public_key(public_key)).verify(
            nep413_hash(message, nonce, recipient), _decode_signature(signature)
        )
        return True
    except (BadSignatureError, ValueError):
        return False


def is_full_access_key(rpc_url: str, account_id: str, public_key: str) -> bool:
    body = requests.post(rpc_url, json={
        "jsonrpc": "2.0", "id": "hivemind", "method": "query",
        "params": {"request_type": "view_access_key", "finality": "final",
                   "account_id": account_id, "public_key": public_key},
    }, timeout=20).json()
    result = body.get("result") or {}
    return result.get("permission") == "FullAccess"


@dataclass
class Session:
    account_id: str
    expires: float


class Auth:
    def __init__(self, rpc_url: str, recipient: str):
        self.rpc_url = rpc_url
        self.recipient = recipient
        self.challenges: dict[str, float] = {}
        self.sessions: dict[str, Session] = {}

    def challenge(self) -> dict:
        now = time.time()
        self.challenges = {n: t for n, t in self.challenges.items() if t > now}
        nonce = base64.b64encode(secrets.token_bytes(32)).decode()
        self.challenges[nonce] = now + CHALLENGE_TTL
        return {"message": SIGN_IN_MESSAGE, "nonce": nonce, "recipient": self.recipient}

    def verify(self, account_id: str, public_key: str, signature: str, nonce: str) -> str:
        """Returns a session token, or raises ValueError."""
        if self.challenges.pop(nonce, 0) < time.time():
            raise ValueError("Unknown or expired challenge")
        if not verify_signature(public_key, signature, SIGN_IN_MESSAGE, base64.b64decode(nonce), self.recipient):
            raise ValueError("Invalid signature")
        if not is_full_access_key(self.rpc_url, account_id, public_key):
            raise ValueError("Key is not a full-access key of this account")
        token = secrets.token_urlsafe(32)
        self.sessions[token] = Session(account_id, time.time() + SESSION_TTL)
        return token

    def account_for(self, token: str | None) -> str | None:
        s = self.sessions.get(token or "")
        if not s or s.expires < time.time():
            return None
        return s.account_id


# --------------------------------------------------------------------------- dev helper


def sign_with_keychain(account_id: str, challenge: dict, network: str = "testnet") -> dict:
    """Sign a challenge with a key from ~/.near-credentials (for CLI demos and tests)."""
    path = Path(os.path.expanduser("~")) / ".near-credentials" / network / f"{account_id}.json"
    creds = json.loads(path.read_text())
    secret = base58.b58decode(creds["private_key"].removeprefix("ed25519:"))
    key = SigningKey(secret[:32])
    nonce = base64.b64decode(challenge["nonce"])
    sig = key.sign(nep413_hash(challenge["message"], nonce, challenge["recipient"])).signature
    public_key = "ed25519:" + base58.b58encode(bytes(key.verify_key)).decode()
    return {"account_id": account_id, "public_key": public_key,
            "signature": base64.b64encode(sig).decode(), "nonce": challenge["nonce"]}
