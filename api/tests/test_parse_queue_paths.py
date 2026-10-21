"""The parse queue policy covers every pool parse of untrusted text, not only run_parse_within."""

import asyncio
import threading

import pytest

from oracle import safe_yaml


async def test_run_parse_is_limited_per_person():
    release = threading.Event()
    try:
        with safe_yaml.parse_owner("alice"):
            first = [asyncio.create_task(safe_yaml.run_parse(release.wait, 10)) for _ in range(2)]
            await asyncio.sleep(0.05)
            with pytest.raises(safe_yaml.ParseBusy) as caught:
                await safe_yaml.run_parse(len, "abc")
            assert caught.value.status == 429 and caught.value.code == "parse_busy_you"
        with safe_yaml.parse_owner("bob"):
            assert await safe_yaml.run_parse(len, "abc") == 3
    finally:
        release.set()
    await asyncio.gather(*first)
    with safe_yaml.parse_owner("alice"):
        assert await safe_yaml.run_parse(len, "abc") == 3


async def test_run_parse_waits_at_most_the_queue_limit(monkeypatch):
    monkeypatch.setattr(safe_yaml, "QUEUE_SECONDS", 0.3)
    release = threading.Event()
    try:
        holders = []
        for i in range(4):
            with safe_yaml.parse_owner(f"p{i}"):
                holders.append(asyncio.create_task(safe_yaml.run_parse(release.wait, 10)))
        await asyncio.sleep(0.05)
        with safe_yaml.parse_owner("late"), pytest.raises(safe_yaml.ParseBusy) as caught:
            await safe_yaml.run_parse(len, "abc")
        assert caught.value.status == 503 and caught.value.code == "parse_busy"
    finally:
        release.set()
    await asyncio.gather(*holders)
