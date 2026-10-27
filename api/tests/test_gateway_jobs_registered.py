"""Every built-in job the worker runs is a job the LLM gateway knows.

Production, 2026-10-27: train U's Simple jobs (item_draft and goal_suggestions for S7,
simple_visual for S10, meeting_minutes for S8) were missing from oracle.llm.gateway.JOBS, so
each one failed with "unknown built-in job" on its first real call while every fake-model test
passed.
"""

from oracle.jobs import kinds
from oracle.llm import gateway


def test_every_job_runner_is_a_gateway_job():
    missing = sorted(set(kinds.RUNNERS) - set(gateway.JOBS))
    assert missing == [], f"add these to oracle.llm.gateway.JOBS: {missing}"
