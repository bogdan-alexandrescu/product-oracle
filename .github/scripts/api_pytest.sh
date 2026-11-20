#!/usr/bin/env bash
# One shard of the API suite (#1563): api_pytest.sh SHARD NUM_SHARDS. tests/_shard.py picks the
# shard's files by tests/shard_durations.json; the junit it writes (with each test's file) is
# what refreshes those durations: uv run python -m tests._shard refresh junit/*.xml
set -euo pipefail
cd "$(dirname "$0")/../../api"
shard=$1
shards=$2
mkdir -p junit
exec uv run pytest -n "${PYTEST_WORKERS:-$(nproc)}" -p no:cacheprovider -m "not timing" \
  --num-shards="$shards" --shard-id="$shard" \
  -o junit_family=xunit1 --junitxml="junit/api-$shard.xml"
