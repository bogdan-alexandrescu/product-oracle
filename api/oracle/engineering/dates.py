"""The Engineering dates of Baseline to PRD (F4 Engineering review stop, lane B).

After the PRD review, once the approved version's draft roadmap items (E1) are ready, the
``eng_dates`` segment's architect writes ``eng_dates.yaml``: a proposed date (an estimate,
capacity plan or commitment and the date it supports) or a reason for none, per Now item.

- **When it starts** (:func:`start_state`): the items ``ready`` with a Now item: go; queued
  or running: wait; none yet (``off``, ``skipped``, ``superseded`` or no row): a person's
  Derive for the run's creator, then wait; ``failed`` or no Now item: the stop is skipped.
- **The file** (:func:`check`): ``unreadable``, ``wrong_prd``, ``unknown_item``,
  ``not_now``, ``bad_date``, ``missing_item``; any is a file-level problem (Send back).
- **What the screen reads** (``payload["dates_check"]``, :func:`summarize`)::

    {"prd": {document, version},
     "items": [{key, title, section, size, proposed: {kind, reference, supports_date} | None,
                confidence, assumptions, no_date_reason}],
     "others": [{key, title, horizon}], "problems": [{code, message}]}

- **Vocabulary** (D8, :func:`validate`): ``accept``; ``edit`` with field ``estimate``
  (``{kind, reference, supports_date}``) or ``no_date`` (``{reason}``); ``question``.
- **Blocking reason** (D3, :func:`reasons`, never waived): ``date_undecided``, a Now item
  with a proposed date that is neither accepted, changed nor marked No date.
- **Approve** (:func:`on_approved`, in the decision's transaction): each accepted or changed
  estimate becomes a verified schedule basis of the PRD for that item (one already verified
  with the same reference and date is reused), then the draft's items are re-checked
  (``items.recheck_date``) and its items check loses the date problems of the dated items.
"""

import uuid
from collections.abc import Iterable
from datetime import date
from typing import Any, Protocol

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import safe_yaml
from oracle.auth.deps import Principal
from oracle.authz import has_role
from oracle.baseline.models import Entity
from oracle.docs.models import Document, DocumentVersion
from oracle.members.leads import date_rights, engineering_leads
from oracle.roadmap.models import BASIS_KINDS, DraftRoadmap, RoadmapItem, ScheduleBasis
from oracle.runs.models import Checkpoint, Run, RunSegment

FILE = "eng_dates.yaml"
KIND = "eng_dates"
PAYLOAD_KEY = "dates_check"
CONFIDENCES = ("low", "medium", "high")
TEXT = 2000
NOT_WAIVED = "an engineering date is never waived: decide it, or send the dates back"
MISSING = {"code": "missing_file", "message": f"the segment left no {FILE}"}
# The draft's date problems a recorded basis answers (oracle.runs.roadmap).
DATE_PROBLEMS = frozenset({"unverified_date", "undated_source"})
NO_ITEMS_YET = ("off", "skipped", "superseded")
UNDER_WAY = ("queued", "running")


class Action(Protocol):
    item_key: str
    kind: str
    field: str | None
    value: Any
    state: str


def failed_note(n: int) -> str:
    return (
        f"Engineering dates skipped: roadmap items for v{n} could not be derived. "
        "Record dates from Plan › Dates."
    )


def no_now_note(n: int) -> str:
    return f"No Now items in v{n}: nothing to date"


def as_date(value: Any) -> date | None:
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value))
    except ValueError:
        return None


# --------------------------------------------------------------------------- the file


def _problem(code: str, message: str, item: str | None = None) -> dict[str, Any]:
    return {"code": code, "message": message, **({"item": item} if item else {})}


def parse(text: str) -> dict[str, Any] | None:
    try:
        data = safe_yaml.load(text)
    except safe_yaml.SafeYamlError:
        return None
    return data if isinstance(data, dict) and isinstance(data.get("items"), list) else None


def check(text: str | None, slug: str, version: int, horizons: dict[str, str]) -> list[dict]:
    """The file's problems against the draft's items (``horizons``: key -> horizon)."""
    if text is None:
        return [MISSING]
    data = parse(text)
    if data is None:
        return [_problem("unreadable", f"{FILE} is not YAML with a list of items")]
    prd = data.get("prd") or {}
    if (
        not isinstance(prd, dict)
        or prd.get("document") not in (None, slug)
        or (prd.get("version") not in (None, version))
    ):
        return [_problem("wrong_prd", f"{FILE} is not for {slug} v{version}")]
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in data["items"]:
        key = str(entry.get("item") or "") if isinstance(entry, dict) else ""
        if key not in horizons:
            out.append(_problem("unknown_item", f"{key or 'an entry'} is not an item of the "
                                f"draft", key or None))  # fmt: skip
            continue
        if horizons[key] != "now":
            out.append(_problem("not_now", f"{key} is in {horizons[key]}: only Now items "
                                "take a date", key))  # fmt: skip
            continue
        seen.add(key)
        estimate = entry.get("estimate")
        if estimate is None:
            if not str(entry.get("no_date_reason") or "").strip():
                out.append(_problem("bad_date", f"{key}: an estimate or a no_date_reason", key))
            continue
        if (
            not isinstance(estimate, dict)
            or estimate.get("kind") not in BASIS_KINDS
            or not str(estimate.get("reference") or "").strip()
            or as_date(estimate.get("supports_date")) is None
        ):
            out.append(_problem("bad_date", f"{key}: the estimate needs kind, reference and "
                                "a YYYY-MM-DD supports_date", key))  # fmt: skip
    for key, horizon in horizons.items():
        if horizon == "now" and key not in seen:
            out.append(_problem("missing_item", f"{key} is a Now item with no entry", key))
    return out


# --------------------------------------------------------------------------- the draft


def approved_number(run: Run, segments: Iterable[RunSegment]) -> int | None:
    """The number of the PRD version the run's review approved: the one its latest PRD
    draft import recorded (a version saved since, during the wait or the review, is not
    it)."""
    numbers = [
        imported.get("version")
        for s in sorted(segments, key=lambda s: s.seq)
        if isinstance(imported := (s.artifacts or {}).get("import"), dict)
        and imported.get("document_id") == str(run.document_id)
        and isinstance(imported.get("version"), int)
    ]
    return numbers[-1] if numbers else None


async def _version(db: AsyncSession, run: Run) -> DocumentVersion | None:
    """The PRD version the run's review approved (:func:`approved_number`)."""
    if run.document_id is None:
        return None
    segments = await db.scalars(select(RunSegment).where(RunSegment.run_id == run.id))
    number = approved_number(run, segments)
    if number is None:
        return None
    return await db.scalar(
        select(DocumentVersion).where(
            DocumentVersion.document_id == run.document_id, DocumentVersion.number == number
        )
    )


async def _draft(db: AsyncSession, version: DocumentVersion) -> DraftRoadmap | None:
    return await db.scalar(select(DraftRoadmap).where(DraftRoadmap.prd_version_id == version.id))


async def _items(db: AsyncSession, row: DraftRoadmap) -> list[RoadmapItem]:
    return list(
        await db.scalars(
            select(RoadmapItem)
            .where(RoadmapItem.draft_roadmap_id == row.id)
            .order_by(RoadmapItem.position)
        )
    )


async def start_state(
    db: AsyncSession, run: Run, creator: Principal | None
) -> tuple[str, int, str | None]:
    """("go" | "wait" | "skip", the version's number, the skip's note). Asks for the items
    (a person's Derive for ``creator``) when the version has none under way."""
    from oracle.roadmap import draft_items

    version = await _version(db, run)
    if version is None:
        return "skip", 0, "Engineering dates skipped: the run imported no PRD version."
    n = version.number
    row = await _draft(db, version)
    if row is None or row.status in NO_ITEMS_YET:
        document = await db.get(Document, version.document_id)
        # A person's Derive, as its route asks: the creator's current role is an approver's.
        if creator is None or document is None or not has_role(creator.role, "approver"):
            return "skip", n, failed_note(n)
        await draft_items.derive(db, creator, document, version)
        return "wait", n, None
    if row.status in UNDER_WAY:
        return "wait", n, None
    if row.status != "ready":
        return "skip", n, failed_note(n)
    if not any(i.horizon == "now" for i in await _items(db, row)):
        return "skip", n, no_now_note(n)
    return "go", n, None


async def _sizes(db: AsyncSession, rows: list[RoadmapItem]) -> dict[uuid.UUID, str]:
    ids = [r.feature_id for r in rows if r.feature_id]
    if not ids:
        return {}
    found = await db.execute(select(Entity.id, Entity.attrs).where(Entity.id.in_(ids)))
    return {i: (a or {}).get("effort") for i, a in found.all() if (a or {}).get("effort")}


async def summarize(db: AsyncSession, run: Run, text: str | None) -> dict[str, Any]:
    """What the stop's screen and gate read, from the segment's file."""
    version = await _version(db, run)
    document = await db.get(Document, version.document_id) if version else None
    row = await _draft(db, version) if version else None
    rows = await _items(db, row) if row else []
    slug = document.slug if document else ""
    n = version.number if version else 0
    horizons = {r.item_key: r.horizon for r in rows}
    problems = check(text, slug, n, horizons)
    entries: dict[str, dict[str, Any]] = {}
    data = parse(text) if text else None
    for entry in (data or {}).get("items") or []:
        if isinstance(entry, dict) and entry.get("item"):
            entries[str(entry["item"])] = entry
    sizes = await _sizes(db, rows)
    items, others = [], []
    for r in rows:
        if r.horizon != "now":
            others.append({"key": r.item_key, "title": r.title, "horizon": r.horizon})
            continue
        e = entries.get(r.item_key) or {}
        est = e.get("estimate") if isinstance(e.get("estimate"), dict) else None
        when = as_date(est.get("supports_date")) if est else None
        items.append(
            {
                "key": r.item_key,
                "title": r.title,
                "section": r.prd_section_key,
                "size": sizes.get(r.feature_id) if r.feature_id else None,
                "proposed": {"kind": est.get("kind"), "reference": str(est.get("reference")),
                             "supports_date": when.isoformat()}
                if est and when else None,
                "confidence": e.get("confidence") if e.get("confidence") in CONFIDENCES
                else None,
                "assumptions": [str(a) for a in e.get("assumptions") or []][:20],
                "no_date_reason": e.get("no_date_reason"),
            }
        )  # fmt: skip
    return {
        "prd": {"document": slug, "version": n},
        "items": items,
        "others": others,
        "problems": problems,
    }


def _check(cp: Checkpoint) -> dict[str, Any] | None:
    check_ = (cp.payload or {}).get(PAYLOAD_KEY)
    return check_ if isinstance(check_, dict) else None


def item_keys(cp: Checkpoint) -> frozenset[str]:
    return frozenset(i["key"] for i in (_check(cp) or {}).get("items") or [])


def choices(actions: Iterable[Action]) -> dict[str, Action]:
    """item -> its staged date choice (the last one staged)."""
    out: dict[str, Action] = {}
    for a in actions:
        if a.state != "staged":
            continue
        if a.kind == "accept" or (a.kind == "edit" and a.field in ("estimate", "no_date")):
            out[a.item_key] = a
    return out


def reasons(cp: Checkpoint, actions: Iterable[Action]) -> tuple[list[dict[str, Any]], int]:
    check_ = _check(cp)
    if check_ is None:
        return [], 0
    chosen = choices(actions)
    out = [
        {"item": i["key"], "item_title": i.get("title"), "code": "date_undecided",
         "severity": "blocking", "label": "Date not decided yet"}
        for i in check_.get("items") or []
        if i.get("proposed") and i["key"] not in chosen
    ]  # fmt: skip
    return out, len(check_.get("problems") or [])


# --------------------------------------------------------------------------- vocabulary


class Invalid(ValueError):
    pass


def _estimate(value: Any) -> dict[str, Any]:
    v = value if isinstance(value, dict) else {}
    if v.get("kind") not in BASIS_KINDS:
        raise Invalid(f"an estimate's kind is one of {', '.join(BASIS_KINDS)}")
    reference = v.get("reference")
    if not isinstance(reference, str) or not reference.strip() or len(reference) > 200:
        raise Invalid("an estimate needs a reference of up to 200 characters")
    when = as_date(v.get("supports_date"))
    if when is None:
        raise Invalid("an estimate's supports_date is a date, YYYY-MM-DD")
    return {"kind": v["kind"], "reference": reference.strip(), "supports_date": when.isoformat()}


def items_of(cp: Checkpoint) -> dict[str, dict[str, Any]]:
    """Each Now item of the stored check, by key."""
    return {i["key"]: i for i in (_check(cp) or {}).get("items") or []}


def validate(
    kind: str, item_key: str, field: str | None, value: Any, items: dict[str, dict[str, Any]]
) -> None:
    """Raise :class:`Invalid` unless the action is in the Engineering dates' vocabulary."""
    if item_key not in items:
        raise Invalid(f"{item_key} is not a Now item of the draft")
    if kind == "question":
        return
    if kind == "accept":
        if not items[item_key].get("proposed"):
            raise Invalid(f"{item_key} has no proposed date to accept: change it instead")
        return
    if kind != "edit":
        raise Invalid("engineering dates take accept, edit (estimate, no_date) or question")
    if field == "estimate":
        _estimate(value)
    elif field == "no_date":
        reason = (value or {}).get("reason") if isinstance(value, dict) else None
        if not isinstance(reason, str) or not reason.strip() or len(reason) > TEXT:
            raise Invalid("No date needs a reason")
    else:
        raise Invalid("edit takes the field estimate or no_date")


# --------------------------------------------------------------------------- approve


def decisions(cp: Checkpoint, actions: Iterable[Action]) -> dict[str, dict[str, Any]]:
    chosen = choices(actions)
    out: dict[str, dict[str, Any]] = {}
    for i in (_check(cp) or {}).get("items") or []:
        a = chosen.get(i["key"])
        if a is None:
            if i.get("no_date_reason"):
                out[i["key"]] = {"decision": "no_date", "reason": i["no_date_reason"]}
            continue
        if a.kind == "accept":
            out[i["key"]] = {"decision": "accepted", "estimate": i["proposed"]}
        elif a.field == "estimate":
            out[i["key"]] = {"decision": "changed", "estimate": _estimate(a.value)}
        else:
            out[i["key"]] = {"decision": "no_date", "reason": a.value["reason"]}
    return out


async def _basis(
    db: AsyncSession, principal: Principal, prd: Document, key: str, est: dict[str, Any], run: Run
) -> ScheduleBasis | None:
    from oracle.roadmap import router as roadmap

    when = as_date(est["supports_date"])
    found = await db.scalar(
        select(ScheduleBasis)
        .where(
            ScheduleBasis.prd_document_id == prd.id,
            ScheduleBasis.reference == est["reference"],
            ScheduleBasis.supports_date == when,
            ScheduleBasis.status == "verified",
            ScheduleBasis.withdrawn_at.is_(None),
            (ScheduleBasis.item_key == key) | ScheduleBasis.item_key.is_(None),
        )
        .limit(1)
    )
    if found is not None:
        return found
    row = ScheduleBasis(
        kind=est["kind"], reference=est["reference"], supports_date=when,
        prd_document_id=prd.id, item_key=key,
        detail=f"Engineering dates of run {str(run.id)[:8]}",
    )  # fmt: skip
    # F3 "Who verifies": the stop's decider holds verify rights; the one rule says so.
    rights = date_rights(principal, await engineering_leads(db))
    if rights is None:
        return None
    return await roadmap.record_basis(db, principal, rights, row, prd)


async def on_approved(
    db: AsyncSession, principal: Principal, run: Run, cp: Checkpoint, actions: Iterable[Action]
) -> None:
    """Approve at the dates (the caller commits): record the choices, the verified bases,
    and re-check the draft's items."""
    from oracle.roadmap import items as items_mod
    from oracle.roadmap import schedule

    recorded = decisions(cp, actions)
    cp.payload = {**(cp.payload or {}), "dates": recorded}
    version = await _version(db, run)
    prd = await db.get(Document, version.document_id) if version else None
    row = await _draft(db, version) if version else None
    if prd is None or row is None:
        return
    dated: dict[str, dict[str, Any]] = {}
    for key, choice in recorded.items():
        if choice.get("estimate"):
            basis = await _basis(db, principal, prd, key, choice["estimate"], run)
            if basis is not None and basis.status == "verified":
                dated[key] = choice["estimate"]
    bases = await schedule.verified_bases(db, prd.id)
    for item in await _items(db, row):
        milestone = dict(item.milestone or {})
        if item.item_key in dated and item.horizon == "now":
            est = dated[item.item_key]
            milestone.setdefault("name", None)
            milestone.update(date=est["supports_date"], date_source=est["reference"])
            milestone.pop("refused_date", None)
            milestone.pop("refused", None)
        item.milestone = items_mod.recheck_date(milestone or None, bases, item.item_key,
                                                item.horizon)  # fmt: skip
    if dated and isinstance(row.items_check, dict):
        problems = [
            p
            for p in row.items_check.get("problems") or []
            if not (p.get("code") in DATE_PROBLEMS and p.get("item") in dated)
        ]
        row.items_check = {**row.items_check, "problems": problems}


async def prompt_lines(db: AsyncSession, run: Run, segment: str) -> list[str]:
    """What the dates segment reads: the approved version's draft items and the PRD's
    verified bases."""
    from oracle.roadmap import schedule

    if segment != "eng_dates":
        return []
    version = await _version(db, run)
    row = await _draft(db, version) if version else None
    if version is None or row is None:
        return []
    document = await db.get(Document, version.document_id)
    rows = await _items(db, row)
    sizes = await _sizes(db, rows)
    lines = [f"Draft roadmap items of {document.slug if document else ''} v{version.number}:"]
    for r in rows:
        source = (r.milestone or {}).get("date_source")
        size = sizes.get(r.feature_id) if r.feature_id else None
        lines.append(
            f"- {r.item_key} ({r.horizon}): {r.title}"
            + (f"; size {str(size).upper()}" if size else "")
            + (f"; milestone date_source {source}" if source else "")
        )
    bases = await schedule.verified_bases(db, version.document_id)
    if bases:
        lines.append("Verified bases on this PRD:")
        lines += [f"- {b.reference} ({b.kind}) supports {b.supports_date}" for b in bases]
    return lines
