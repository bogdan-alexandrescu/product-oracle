"""Simple's unvalidated response-model builder (oracle.simple.service._built), no database.

Test cards (protects / fails_when / no_claim):

- test_built_refuses_a_misspelled_or_missing_field_under_tests: protects=with the test
  suite's check on (ORACLE_CHECK_BUILT, set by conftest), a misspelled keyword and a
  missing required field are refused at the call, not dropped or left to fail at
  serialization; fails_when=either is built silently; no_claim=production, where the
  check is off and costs nothing.
- test_built_fields_set_are_the_models_fields: protects=with the check off, the fields
  set are the given names that are fields, as model_construct has them;
  fails_when=an unknown keyword lands in model_fields_set; no_claim=validation.
"""

import datetime as dt

import pytest

from oracle.simple import service
from oracle.simple.schemas import SimpleDate

DAY = dt.date(2026, 10, 31)


def test_built_refuses_a_misspelled_or_missing_field_under_tests():
    ok = service._built(SimpleDate, date=DAY, source="typed", estimated=False)
    assert ok.model_dump() == {"date": DAY, "source": "typed", "estimated": False}
    with pytest.raises(TypeError, match="estimatd"):
        service._built(SimpleDate, date=DAY, source="typed", estimatd=False)
    with pytest.raises(TypeError, match="source"):
        service._built(SimpleDate, date=DAY, estimated=False)


def test_built_fields_set_are_the_models_fields(monkeypatch):
    monkeypatch.setattr(service, "_CHECK_BUILT", False, raising=False)
    m = service._built(SimpleDate, date=DAY, source="typed", estimated=True, bogus=1)
    assert m.model_fields_set == {"date", "source", "estimated"}
