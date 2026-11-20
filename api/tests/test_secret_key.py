"""#1571: a real deployment refuses the default or a short ORACLE_SECRET_KEY at startup."""

import pytest
from pydantic import ValidationError

from oracle.config import Settings

REAL_KEY = "an-example-key-made-up-for-this-test-0123456789"
REAL = [
    {"env": "production"},
    {"cookie_secure": True},
    {"iap_audiences": ["/projects/1/global/backendServices/2"]},
]


@pytest.mark.parametrize("real", REAL)
def test_a_real_deployment_refuses_the_default_secret_key(real):
    """protects=#1571 (the default key signs cookies and OAuth state and derives the
    credentials key); fails_when=a deployment that forgets ORACLE_SECRET_KEY starts."""
    with pytest.raises(ValidationError, match="ORACLE_SECRET_KEY"):
        Settings(allow_reserved_email_domains=False, **real)


@pytest.mark.parametrize("real", REAL)
def test_a_real_deployment_refuses_a_short_secret_key(real):
    """protects=#1571; fails_when=a key under 32 characters is accepted in production."""
    with pytest.raises(ValidationError, match="ORACLE_SECRET_KEY"):
        Settings(allow_reserved_email_domains=False, secret_key="short-example-key", **real)


@pytest.mark.parametrize("real", REAL)
def test_a_real_deployment_starts_with_a_real_secret_key(real):
    """protects=#1571; fails_when=a real key is refused."""
    s = Settings(allow_reserved_email_domains=False, secret_key=REAL_KEY, **real)
    assert s.secret_key == REAL_KEY


def test_local_development_keeps_the_default_secret_key():
    """protects=#1571 scope (local dev and tests); fails_when=the default is refused there."""
    assert Settings().secret_key == "dev-insecure-change-me"
