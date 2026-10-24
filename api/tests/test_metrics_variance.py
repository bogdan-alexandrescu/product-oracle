"""H5 Metrics review, lane 1: the variance rule, week bounds across DST, the HogQL
placeholder fill and the provider's error text redaction (deterministic, no database
row needed)."""

from datetime import UTC, date, datetime

from oracle.metrics import posthog, pull, variance


def _zigzag(start: float = 100.0, changes: int = 12, step: float = 10.0) -> list[float]:
    values = [start]
    for i in range(changes):
        values.append(values[-1] + (step if i % 2 == 0 else -step))
    return values


# protects=criterion 1 (rule 1): 12 changes of +-10 then +40 is a variance, Better for an
# up metric, with the band prev +- 2 x typical; fails_when=the median of the absolute
# history is not used, or the band is not 2 x typical; no_claim=storage of the row.
def test_rule_one_flags_a_jump_better_with_the_band():
    values = _zigzag() + [_zigzag()[-1] + 40]
    got = variance.check(values, "up", None)
    assert got.variance == "better"
    assert got.typical == 10
    assert got.change == 40
    prev = values[-2]
    assert got.band == (prev - 20, prev + 20)
    assert got.no_value is False


# protects=criterion 1 (direction): the same series on a down metric is Worse;
# fails_when=the direction is ignored; no_claim=the words on screen.
def test_rule_one_is_worse_for_a_down_metric():
    values = _zigzag() + [_zigzag()[-1] + 40]
    assert variance.check(values, "down", None).variance == "worse"


# protects=criterion 1 (rule 2): with fewer than 6 changes, a 12% move on 100 is a
# variance at the 10% default and a 9% move is not; fails_when=rule 1 is used on a short
# history, or the threshold is off by one; no_claim=an owner's threshold.
def test_rule_two_with_a_short_history():
    base = [100, 101, 100, 101, 100]
    assert variance.check([*base, 112], "up", None).variance == "better"
    assert variance.check([*base, 109], "up", None).variance is None


# protects=rule 2 at zero: with v[w-1] = 0 any change counts, and none is no variance;
# fails_when=a division by zero raises or a flat zero is flagged; no_claim=negative values.
def test_rule_two_from_zero():
    assert variance.check([0, 0, 3], "up", None).variance == "better"
    assert variance.check([0, 0, 0], "up", None).variance is None


# protects=criterion 1 (rule 3): an owner's threshold_pct 5 flags +6 on 100 even when
# rule 1 says none; fails_when=the owner's threshold applies only to short histories;
# no_claim=the threshold's 1-500 bounds (API test).
def test_an_owners_threshold_always_applies():
    values = _zigzag() + [_zigzag()[-1] + 6]
    assert values[-2] == 100
    assert variance.check(values, "up", None).variance is None
    assert variance.check(values, "up", 5).variance == "better"


# protects=criterion 1 (missing week): a week with no value is no variance and reads "No
# value this week"; fails_when=a missing week raises or is flagged; no_claim=the review.
def test_a_missing_week_is_no_variance():
    got = variance.check([*_zigzag(), None], "up", None)
    assert got.variance is None
    assert got.no_value is True
    assert got.label == "No value this week"


# protects=criterion 2: in America/Los_Angeles the week of 2026-10-26 runs
# 2026-10-26T07:00Z to 2026-11-02T08:00Z (the DST change), and the query's placeholders
# carry those instants; fails_when=a fixed offset or UTC midnight is used;
# no_claim=PostHog's parsing of the timestamps.
def test_week_bounds_across_dst_and_the_placeholders():
    start, end = pull.week_bounds(date(2026, 10, 26), "America/Los_Angeles")
    assert start == datetime(2026, 10, 26, 7, tzinfo=UTC)
    assert end == datetime(2026, 11, 2, 8, tzinfo=UTC)
    q = pull.fill_query("SELECT 1 WHERE t >= '{period_start}' AND t < '{period_end}'", start,
                        end, "America/Los_Angeles")  # fmt: skip
    first, second = q.split("'")[1], q.split("'")[3]
    assert datetime.fromisoformat(first) == start
    assert datetime.fromisoformat(second) == end
    assert "{period" not in q


# protects=the last complete week is the company's: Monday 05:00 in Los Angeles is still
# in the new week, so the last complete one is the week before; fails_when=UTC dates pick
# the week; no_claim=other zones.
def test_last_complete_week():
    at = datetime(2026, 10, 19, 12, tzinfo=UTC)
    assert pull.last_complete_week(at, "America/Los_Angeles") == date(2026, 10, 12)
    sunday_night = datetime(2026, 10, 19, 6, tzinfo=UTC)  # Sun 23:00 in Los Angeles
    assert pull.last_complete_week(sunday_night, "America/Los_Angeles") == date(2026, 10, 5)


# protects=the provider's message never carries the key and is capped at 300 characters;
# fails_when=the key is echoed or a long message passes whole; no_claim=logging.
def test_error_text_redaction():
    key = "phx_secret_value_123"
    got = posthog.redact(f"Invalid key {key}. " + "x" * 400, key)
    assert key not in got
    assert len(got) <= 300
    assert got.startswith("Invalid key")
