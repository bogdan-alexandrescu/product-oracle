"""Encryption at rest for source credentials.

Fernet (AES-128-CBC + HMAC-SHA256) with a key derived from ``ORACLE_SECRET_KEY`` by
HKDF-SHA256. ``KEY_VERSION`` is stored beside each ciphertext so the derivation can
change later without losing old rows.
"""

import base64
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from oracle.config import get_settings

KEY_VERSION = 1
_INFO = b"oracle-source-credentials"


class DecryptionError(Exception):
    """The ciphertext was tampered with or encrypted under another key."""


@lru_cache
def _fernet(secret_key: str) -> Fernet:
    key = HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=_INFO).derive(
        secret_key.encode()
    )
    return Fernet(base64.urlsafe_b64encode(key))


def encrypt(plaintext: bytes) -> bytes:
    return _fernet(get_settings().secret_key).encrypt(plaintext)


def decrypt(ciphertext: bytes) -> bytes:
    try:
        return _fernet(get_settings().secret_key).decrypt(ciphertext)
    except InvalidToken:
        raise DecryptionError("cannot decrypt: wrong key or corrupted ciphertext") from None
