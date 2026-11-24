"""#1571: a real deployment refuses the default or a short ORACLE_SECRET_KEY at startup."""

import os

import pytest
from pydantic import ValidationError

from oracle.config import Settings

REAL_KEY = "an-example-key-made-up-for-this-test-0123456789"
DEFAULT_KEY = "dev-insecure-change-me"
REAL = [
    {"env": "production"},
    {"cookie_secure": True},
    {"iap_audiences": ["/projects/1/global/backendServices/2"]},
    # #1606: anything but an explicit local or test name is real, whatever its case or spaces.
    {"env": "staging"},
    {"env": "prod"},
    {"env": "Production"},
    {"env": " production"},
]


@pytest.fixture(autouse=True)
def _no_ambient_settings(monkeypatch):
    """#1606: the developer's shell and api/.env never reach these tests."""
    for name in list(os.environ):
        if name.upper().startswith("ORACLE_"):
            monkeypatch.delenv(name)


def _settings(**kwargs) -> Settings:
    return Settings(_env_file=None, allow_reserved_email_domains=False, **kwargs)  # type: ignore[call-arg]


@pytest.mark.parametrize("real", REAL)
def test_a_real_deployment_refuses_the_default_secret_key(real):
    """protects=#1571, #1606 (the default key signs cookies and OAuth state and derives the
    credentials key); fails_when=a deployment that forgets ORACLE_SECRET_KEY starts."""
    with pytest.raises(ValidationError, match="ORACLE_SECRET_KEY"):
        _settings(**real)


@pytest.mark.parametrize("real", REAL)
def test_a_real_deployment_refuses_a_short_secret_key(real):
    """protects=#1571; fails_when=a key under 32 characters is accepted in production."""
    with pytest.raises(ValidationError, match="ORACLE_SECRET_KEY"):
        _settings(secret_key="short-example-key", **real)


@pytest.mark.parametrize("key", [" " * 32, f"  {DEFAULT_KEY}  ", DEFAULT_KEY.ljust(40)])
def test_a_real_deployment_refuses_a_blank_or_padded_secret_key(key):
    """protects=#1606 (whitespace is not a secret); fails_when=32 spaces, or the default
    padded with spaces, passes the length check."""
    with pytest.raises(ValidationError, match="ORACLE_SECRET_KEY"):
        _settings(env="production", secret_key=key)


@pytest.mark.parametrize("real", REAL)
def test_a_real_deployment_starts_with_a_real_secret_key(real):
    """protects=#1571; fails_when=a real key is refused."""
    s = _settings(secret_key=REAL_KEY, **real)
    assert s.secret_key == REAL_KEY


@pytest.mark.parametrize("env", ["development", "test", " Development ", "TEST"])
def test_local_development_keeps_the_default_secret_key(env):
    """protects=#1571 scope (local dev and tests); fails_when=the default is refused there."""
    assert _settings(env=env).secret_key == DEFAULT_KEY
    assert _settings().secret_key == DEFAULT_KEY


def test_the_ambient_environment_does_not_reach_these_tests():
    """protects=#1606 (the tests read neither the shell nor api/.env); fails_when=a
    developer's ORACLE_SECRET_KEY changes what the tests see."""
    assert "ORACLE_SECRET_KEY" not in os.environ
    assert _settings().secret_key == DEFAULT_KEY


@pytest.mark.parametrize("env", ["prod", "staging", " Production"])
def test_the_loopback_switch_is_refused_outside_development_and_test(env):
    """protects=#1606 (the same allow-list guards the test-only switch); fails_when=a
    deployment named prod or staging starts with ORACLE_WEBHOOKS_ALLOW_LOOPBACK_FOR_TESTS."""
    with pytest.raises(ValidationError, match="LOOPBACK"):
        _settings(env=env, secret_key=REAL_KEY, webhooks_allow_loopback_for_tests=True)
