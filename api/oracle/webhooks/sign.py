"""Signing a webhook call (I1 "Signing"), as the open Standard Webhooks spec does, so
receivers can check it with that spec's libraries.

``webhook-signature: v1,<base64 HMAC-SHA256(key, "<id>.<timestamp>.<body>")>``, where the
key is the secret's base64 part after ``whsec_`` (as those libraries read it). During a
rotation's 24-hour overlap the header carries two space-separated signatures, the new
secret's first. The secrets are decrypted here, for the call, and never logged.
"""

import base64
import hashlib
import hmac
from datetime import datetime

from oracle import crypto
from oracle.webhooks.models import Webhook

USER_AGENT = "ProductOracle-Webhooks/1"
PREFIX = "whsec_"


def sign(secret: str, msg_id: str, timestamp: int, body: bytes) -> str:
    key = base64.b64decode(secret.removeprefix(PREFIX))
    signed = f"{msg_id}.{timestamp}.".encode() + body
    return "v1," + base64.b64encode(hmac.new(key, signed, hashlib.sha256).digest()).decode()


def secrets_of(hook: Webhook, now: datetime) -> list[str]:
    """The secrets that sign now: the current one, and the previous one in its overlap."""
    out = [crypto.decrypt(hook.ciphertext).decode()]
    if (
        hook.previous_ciphertext is not None
        and hook.previous_expires_at is not None
        and hook.previous_expires_at > now
    ):
        out.append(crypto.decrypt(hook.previous_ciphertext).decode())
    return out


def headers(hook: Webhook, msg_id: str, body: bytes, now: datetime) -> dict[str, str]:
    timestamp = int(now.timestamp())
    return {
        "webhook-id": msg_id,
        "webhook-timestamp": str(timestamp),
        "webhook-signature": " ".join(
            sign(s, msg_id, timestamp, body) for s in secrets_of(hook, now)
        ),
        "user-agent": USER_AGENT,
        "content-type": "application/json",
    }
