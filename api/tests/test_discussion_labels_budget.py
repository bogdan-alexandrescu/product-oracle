"""small-fixes: a list of discussion labels (``Labels.of``, what the inbox and a run's
discussions read) costs the same SQL statements for 3 roadmap items as for 12. Against
Postgres; invented example data only (an "Example Checkout" roadmap and its items).

Test cards (protects / fails_when / no_claim):

- test_item_labels_read_in_a_fixed_budget: protects=N roadmap-item labels read each item's
  title and its feature's code and name with one query per kind, on one roadmap (``of``
  alone) and across roadmaps (``prime`` first), and still read "F-03 Bulk address edit 3";
  fails_when=a feature or a roadmap item is read once per label; no_claim=the subject's
  own document row (one per document, already cached).
"""

import uuid

from oracle.discussions.models import Discussion
from oracle.discussions.service import Labels
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.coverage_helpers import count_statements
from tests.test_simple_roadmap_api import Seed


def _subject(rv, key: str) -> Discussion:
    subject = {"document_id": str(rv.document_id), "version": rv.number, "item_key": key}
    return Discussion(id=uuid.uuid4(), subject_kind="roadmap_item", subject=subject)


async def _labels(slug: str, n: int, roadmaps: int = 1) -> tuple:
    """Statements and labels of ``n`` item discussions on each of ``roadmaps`` new roadmaps,
    in a new company."""
    ctx = await make_ctx("Example Co")
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        ds = []
        for r in range(roadmaps):
            _, pv, _rm, rv = await seed.roadmap(f"{slug}-{r}")
            for i in range(n):
                key = f"F-{r * n + i + 1:02d}"
                await seed.entity("feature", key)
                await seed.item(rv, pv, key, position=i, title=f"Bulk address edit {i + 1}")
                ds.append(_subject(rv, key))
        await s.commit()
        labels = Labels(s)
        with count_statements() as seen:
            if roadmaps > 1:
                await labels.prime(ds)
            out = [(await labels.of(d))[0] for d in ds]
        return len(seen), out


async def test_item_labels_read_in_a_fixed_budget():
    few, labels = await _labels("example-checkout", 3)
    assert labels[2] == "Example Checkout 0 · F-03 Bulk address edit 3", labels
    many, labels = await _labels("example-billing", 12)
    assert labels[11].endswith("· F-12 Bulk address edit 12"), labels
    assert many == few, (few, many)

    few, _ = await _labels("example-checkout", 3, roadmaps=2)
    many, labels = await _labels("example-billing", 3, roadmaps=6)
    assert labels[-1].endswith("· F-18 Bulk address edit 3"), labels
    # Four more roadmaps cost their four document rows, not a query per item.
    assert many == few + 4, (few, many)
