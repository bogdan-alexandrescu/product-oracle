"""``launch.yaml``: what Oracle's ``launch_kit`` run writes for one launch, its schema,
and its import.

    version: 1
    launch: <id>
    changelog:
      - {category: added|changed|deprecated|removed|fixed|security,
         audience: internal|public, title: "...", body: "..."}
    tasks:
      release_notes: "..."            # markdown
      internal_announcement: "..."
      support_notes: "..."
      sales_briefing: "..."
      in_app_message: "..."
      customer_email: "..."
      help_docs: "..."                # an outline
      pre_mortem: {tigers: [...], paper_tigers: [...], elephants: [...]}
    notes:
      - {requester_ref: "request:<id>" | "member:<id>" | "note:<id>", body: "..."}

The parse is bounded (``oracle.safe_yaml``). A valid file moves each named task of the
launch that is still ``todo`` or ``drafted`` to ``drafted`` with its text, replaces the
launch's earlier Oracle draft changelog entries with the ones given (``draft``, never
published here), and drafts the notes it names. An invalid one changes nothing but
``kit_error`` on the launch.

#541 part 5: what the kit writes is read by every member (and some of it goes outside), so
the run reads as a commenter (oracle.runs.flows ``member_output``) and the import checks
its text the same way, whoever started it: a file whose text names a decision or a
document a commenter may not see (oracle.docs.visibility ``Hidden.names``) is refused as
an invalid one is. Its refs need no such check: a requester_ref names one of this
launch's own notes, or nothing is drafted for it.
"""

import re
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, safe_yaml
from oracle.docs import visibility
from oracle.launches.checklist import tasks_of
from oracle.launches.models import (
    CHANGELOG_AUDIENCES,
    CHANGELOG_CATEGORIES,
    ChangelogEntry,
    Launch,
    RequesterNote,
)

FILE = "launch.yaml"
TEXT_TASKS = (
    "release_notes",
    "internal_announcement",
    "support_notes",
    "sales_briefing",
    "in_app_message",
    "customer_email",
    "help_docs",
)
PRE_MORTEM = (
    ("tigers", "Tigers", "real threats to the launch"),
    ("paper_tigers", "Paper tigers", "worries that look real and are not"),
    ("elephants", "Elephants", "what nobody is saying"),
)
_REF = re.compile(r"^(request|member|note):([0-9a-fA-F-]{36})$")
MAX_TEXT = 20_000


def _text(value: Any, where: str, problems: list[str], *, empty: bool = True) -> str | None:
    if not isinstance(value, str) or (not empty and not value.strip()):
        problems.append(f"{where} must be {'text' if empty else 'non-empty text'}")
        return None
    if len(value) > MAX_TEXT:
        problems.append(f"{where} is longer than {MAX_TEXT} characters")
        return None
    return value


def validate(text: str, launch_id: uuid.UUID) -> tuple[dict[str, Any] | None, list[str]]:
    """(the file's data, []) or (None, problems)."""
    try:
        data = safe_yaml.load(text)
    except safe_yaml.SafeYamlError as e:
        return None, [f"{FILE} is not valid YAML: {e}"]
    if not isinstance(data, dict):
        return None, [f"{FILE} must be a mapping with version, launch, changelog, tasks, notes"]
    problems: list[str] = []
    if data.get("version") != 1:
        problems.append("version must be 1")
    if str(data.get("launch")) != str(launch_id):
        problems.append(f"launch is {data.get('launch')!r}, not this launch ({launch_id})")
    unknown = set(data) - {"version", "launch", "changelog", "tasks", "notes"}
    if unknown:
        problems.append(f"unknown keys: {', '.join(sorted(map(str, unknown)))}")
    changelog = data.get("changelog") or []
    if not isinstance(changelog, list):
        problems.append("changelog must be a list")
        changelog = []
    for i, e in enumerate(changelog):
        where = f"changelog[{i}]"
        if not isinstance(e, dict):
            problems.append(f"{where} must be a mapping")
            continue
        if e.get("category") not in CHANGELOG_CATEGORIES:
            problems.append(f"{where}.category must be one of {', '.join(CHANGELOG_CATEGORIES)}")
        if e.get("audience") not in CHANGELOG_AUDIENCES:
            problems.append(f"{where}.audience must be internal or public")
        _text(e.get("title"), f"{where}.title", problems, empty=False)
        _text(e.get("body", ""), f"{where}.body", problems)
    tasks = data.get("tasks") or {}
    if not isinstance(tasks, dict):
        problems.append("tasks must be a mapping")
        tasks = {}
    for key, value in tasks.items():
        if key == "pre_mortem":
            if not isinstance(value, dict):
                problems.append(
                    "tasks.pre_mortem must be a mapping of tigers, paper_tigers, elephants"
                )
                continue
            for part, _, _ in PRE_MORTEM:
                items = value.get(part, [])
                if not isinstance(items, list) or not all(isinstance(x, str) for x in items):
                    problems.append(f"tasks.pre_mortem.{part} must be a list of strings")
            extra = set(value) - {p for p, _, _ in PRE_MORTEM}
            if extra:
                problems.append(f"tasks.pre_mortem has unknown keys: {', '.join(map(str, extra))}")
        elif key in TEXT_TASKS:
            _text(value, f"tasks.{key}", problems)
        else:
            problems.append(f"tasks.{key}: Oracle drafts no task {key!r}")
    notes = data.get("notes") or []
    if not isinstance(notes, list):
        problems.append("notes must be a list")
        notes = []
    for i, n in enumerate(notes):
        where = f"notes[{i}]"
        if not isinstance(n, dict):
            problems.append(f"{where} must be a mapping")
            continue
        if not isinstance(n.get("requester_ref"), str) or not _REF.match(n["requester_ref"]):
            problems.append(f"{where}.requester_ref must be request:<id>, member:<id> or note:<id>")
        _text(n.get("body"), f"{where}.body", problems, empty=False)
    if problems:
        return None, problems
    return data, []


def pre_mortem_markdown(value: dict[str, list[str]]) -> str:
    parts = []
    for key, title, meaning in PRE_MORTEM:
        items = value.get(key) or []
        lines = [f"**{title}** ({meaning})"]
        lines += [f"- {x}" for x in items] or ["- none named"]
        parts.append("\n".join(lines))
    return "\n\n".join(parts)


def _changelog_summary(entries: list[ChangelogEntry]) -> str:
    return "\n".join(f"- {e.category.capitalize()} ({e.audience}): {e.title}" for e in entries)


def _note_for(notes: list[RequesterNote], ref: str) -> RequesterNote | None:
    kind, raw = ref.split(":", 1)
    target = uuid.UUID(raw)
    for n in notes:
        if (
            (kind == "member" and n.member_id == target)
            or (kind == "request" and n.request_id == target)
            or (kind == "note" and n.id == target)
        ):
            return n
    return None


def _texts(data: dict[str, Any]) -> list[tuple[str, str]]:
    """(where, text) of every text the file would store."""
    out: list[tuple[str, str]] = []
    for i, e in enumerate(data.get("changelog") or []):
        out.append((f"changelog[{i}].title", e["title"]))
        out.append((f"changelog[{i}].body", e.get("body") or ""))
    for key, value in (data.get("tasks") or {}).items():
        out.append((f"tasks.{key}", pre_mortem_markdown(value) if key == "pre_mortem" else value))
    for i, n in enumerate(data.get("notes") or []):
        out.append((f"notes[{i}].body", n["body"]))
    return out


async def names_hidden(db: AsyncSession, data: dict[str, Any]) -> list[str]:
    """Where the file's text names something a commenter may not see."""
    hidden = await visibility.hidden_for_reader(db, as_member=True)
    if hidden is None:
        return []
    return [where for where, text in _texts(data) if hidden.names(text)]


async def import_kit(db: AsyncSession, launch: Launch, text: str | None) -> dict[str, Any]:
    """Import a launch.yaml into its launch (the caller commits). Returns what changed,
    or ``{"error": ...}`` (recorded as ``kit_error``)."""
    if text is None:
        launch.kit_error = f"the run left no {FILE}"
        return {"error": launch.kit_error}
    data, problems = validate(text, launch.id)
    if data is None:
        launch.kit_error = f"{FILE} was refused: " + "; ".join(problems[:5])
        return {"error": launch.kit_error, "problems": problems}
    named = await names_hidden(db, data)
    if named:
        problems = [
            f"{where} names a decision or a document only owners and approvers may see: leave "
            "it out (every member reads the kit)"
            for where in named
        ]
        launch.kit_error = f"{FILE} was refused: " + "; ".join(problems[:5])
        return {"error": launch.kit_error, "problems": problems}
    tasks = {t.key: t for t in await tasks_of(db, launch.id) if t.key}
    drafted: list[str] = []

    def draft(key: str, body: str) -> None:
        task = tasks.get(key)
        if task is not None and task.status in ("todo", "drafted"):
            task.body = body
            task.status = "drafted"
            drafted.append(key)

    for key, value in (data.get("tasks") or {}).items():
        draft(key, pre_mortem_markdown(value) if key == "pre_mortem" else value)

    await db.execute(
        delete(ChangelogEntry).where(
            ChangelogEntry.launch_id == launch.id,
            ChangelogEntry.status == "draft",
            ChangelogEntry.created_actor == audit.ORACLE,
        )
    )
    # The UTC day on purpose: released_on is a machine field (a stored date the changelog
    # API returns as ISO and the web words for people), never text an API builder writes.
    released = (launch.launched_at or datetime.now(UTC)).date()
    entries = [
        ChangelogEntry(
            launch_id=launch.id,
            category=e["category"],
            audience=e["audience"],
            title=e["title"].strip(),
            body=(e.get("body") or "").strip(),
            released_on=released,
            created_actor=audit.ORACLE,
        )
        for e in data.get("changelog") or []
    ]
    db.add_all(entries)
    if entries:
        draft("changelog_entry", _changelog_summary(entries))

    notes = list(
        await db.scalars(select(RequesterNote).where(RequesterNote.launch_id == launch.id))
    )
    noted = 0
    for n in data.get("notes") or []:
        note = _note_for(notes, n["requester_ref"])
        if note is not None and note.status == "drafted":
            note.body = n["body"].strip()
            noted += 1
    if noted:
        draft("requester_notes", f"{noted} personal notes drafted: see Notes.")
    launch.kit_error = None
    await db.flush()
    return {"tasks": drafted, "changelog": len(entries), "notes": noted}
