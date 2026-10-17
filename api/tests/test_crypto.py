import pytest

from oracle import crypto
from oracle.config import get_settings


def test_round_trip():
    secret = b'{"token": "example-value"}'
    ciphertext = crypto.encrypt(secret)
    assert secret not in ciphertext
    assert crypto.decrypt(ciphertext) == secret
    assert crypto.encrypt(secret) != ciphertext  # random IV per message
    assert crypto.KEY_VERSION == 1


def test_wrong_key_fails(monkeypatch):
    ciphertext = crypto.encrypt(b"secret")
    monkeypatch.setattr(get_settings(), "secret_key", "another-secret-key")
    with pytest.raises(crypto.DecryptionError):
        crypto.decrypt(ciphertext)


def test_tampered_ciphertext_fails():
    ciphertext = bytearray(crypto.encrypt(b"secret"))
    ciphertext[-5] ^= 1
    with pytest.raises(crypto.DecryptionError):
        crypto.decrypt(bytes(ciphertext))


def test_key_depends_on_the_secret():
    a = crypto._fernet("secret-a").encrypt(b"x")
    assert crypto._fernet("secret-a").decrypt(a) == b"x"
    with pytest.raises(Exception):  # noqa: B017
        crypto._fernet("secret-b").decrypt(a)
