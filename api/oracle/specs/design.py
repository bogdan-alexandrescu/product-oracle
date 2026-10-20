"""``design.json``: the SVG flows and low-fidelity wireframes a spec run hands back (O2).

    {
      "version": 1,
      "flows": [{"name": "checkout-flow.svg", "title": "Checkout", "svg": "<svg ...>",
                 "section_keys": ["s-5-2"], "requirement_ids": ["<uuid>"],
                 "annotations": [{"id": "a1", "target": "step-cost", "note": "...",
                                  "section_key": "s-5-2", "requirement_ids": ["<uuid>"]}]}],
      "wireframes": [{"name": "cart.html", "title": "Cart", "screen": "cart", "html": "...",
                      "section_keys": [...], "requirement_ids": [...], "annotations": [...]}]
    }

:func:`check_design` lists every problem at once. It checks names, sizes and types, that
each artifact and annotation points at sections of the PRD version and requirements of
the request (the exact links a reviewer follows), that each annotation's target is in the
content, and sanitises every file (:mod:`oracle.specs.sanitize`). Any error refuses the
whole bundle: nothing half-checked is stored. Pure functions, no database.
"""

import hashlib
import json
import re
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from oracle.specs.contract import Problem
from oracle.specs.sanitize import MAX_FILE_BYTES, Sanitized, sanitize_svg, sanitize_wireframe

MAX_BUNDLE_BYTES = 1_000_000
# O2: 2-4 key screens; at least one flow, at most four.
MIN_SCREENS, MAX_SCREENS = 2, 4
MAX_FLOWS = 4
NAME = {"svg": re.compile(r"^[a-z0-9][a-z0-9-]{0,62}\.svg$"),
        "html": re.compile(r"^[a-z0-9][a-z0-9-]{0,62}\.html$")}  # fmt: skip
MEDIA_TYPE = {"svg": "image/svg+xml", "html": "text/html"}


class AnnotationIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,39}$")
    # An element id (or data-annotation value) in the file.
    target: str = Field(min_length=1, max_length=80)
    note: str = Field(min_length=1, max_length=1000)
    section_key: str | None = Field(default=None, max_length=200)
    requirement_ids: list[uuid.UUID] = Field(default_factory=list, max_length=20)


class _ArtifactIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=80)
    title: str = Field(min_length=1, max_length=200)
    section_keys: list[str] = Field(min_length=1, max_length=20)
    requirement_ids: list[uuid.UUID] = Field(min_length=1, max_length=50)
    annotations: list[AnnotationIn] = Field(default_factory=list, max_length=30)


class FlowIn(_ArtifactIn):
    svg: str = Field(min_length=1)


class WireframeIn(_ArtifactIn):
    screen: str | None = Field(default=None, max_length=80)
    html: str = Field(min_length=1)


class DesignBundle(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: Literal[1]
    flows: list[FlowIn] = Field(default_factory=list, max_length=MAX_FLOWS)
    wireframes: list[WireframeIn] = Field(default_factory=list, max_length=MAX_SCREENS)


@dataclass
class CheckedOutput:
    """A validated, sanitised design file, ready to store as an artifact output."""

    kind: Literal["user_flow", "wireframe"]
    name: str
    title: str
    media_type: str
    content: str
    section_keys: list[str]
    requirement_ids: list[str]
    annotations: list[dict[str, Any]]
    removed: list[str]
    screen: str | None = None

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.content.encode("utf-8")).hexdigest()

    @property
    def size_bytes(self) -> int:
        return len(self.content.encode("utf-8"))

    def meta(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "screen": self.screen,
            "section_keys": self.section_keys,
            "requirement_ids": self.requirement_ids,
            "annotations": self.annotations,
            "sanitized": {"removed": self.removed},
            "static": True,
        }


@dataclass
class DesignCheck:
    flows: list[CheckedOutput] = field(default_factory=list)
    wireframes: list[CheckedOutput] = field(default_factory=list)
    problems: list[Problem] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not any(p.severity == "error" for p in self.problems)

    def as_json(self) -> dict[str, Any]:
        return {
            "flows": [o.name for o in self.flows],
            "wireframes": [o.name for o in self.wireframes],
            "problems": [p.as_json() for p in self.problems],
        }


def _err(out: DesignCheck, code: str, message: str, where: str | None = None) -> None:
    out.problems.append(Problem(code, message, where))


def check_design(
    text: str | None,
    *,
    prd_sections: set[str],
    requirement_ids: set[str],
    screens: int = 3,
) -> DesignCheck:
    """Parse and check ``design.json`` against the PRD version's sections and the request's
    requirements; ``screens`` is how many key screens the request asked for (2-4)."""
    out = DesignCheck()
    if text is None:
        _err(out, "missing_file", "the run left no design.json")
        return out
    if len(text.encode("utf-8")) > MAX_BUNDLE_BYTES:
        _err(out, "too_large", f"design.json is over {MAX_BUNDLE_BYTES} bytes")
        return out
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as exc:
        _err(out, "invalid_json", f"design.json is not valid JSON: {exc}")
        return out
    try:
        bundle = DesignBundle.model_validate(raw)
    except ValidationError as exc:
        for e in exc.errors()[:20]:
            where = ".".join(str(p) for p in e["loc"])
            _err(out, "invalid_shape", f"design.json {where}: {e['msg']}", where)
        return out
    if not bundle.flows:
        _err(out, "no_flows", "design.json has no flow: at least one SVG flow is needed")
    if not MIN_SCREENS <= len(bundle.wireframes) <= MAX_SCREENS:
        _err(
            out,
            "screen_count",
            f"design.json has {len(bundle.wireframes)} wireframes; O2 asks for "
            f"{MIN_SCREENS}-{MAX_SCREENS} key screens",
        )
    elif len(bundle.wireframes) != screens:
        out.problems.append(
            Problem(
                "screen_count",
                f"the request asked for {screens} key screens; the run drew "
                f"{len(bundle.wireframes)}",
                severity="warning",
            )
        )
    seen: set[str] = set()
    items: list[tuple[str, _ArtifactIn]] = [("svg", f) for f in bundle.flows] + [
        ("html", w) for w in bundle.wireframes
    ]
    for ext, item in items:
        where = item.name
        if not NAME[ext].fullmatch(item.name):
            _err(
                out,
                "invalid_name",
                f"{item.name!r}: a name is lowercase letters, digits and dashes ending .{ext}",
                where,
            )
        if item.name in seen:
            _err(out, "duplicate_name", f"{item.name!r} is used twice", where)
        seen.add(item.name)
        body = item.svg if isinstance(item, FlowIn) else item.html  # type: ignore[attr-defined]
        if len(body.encode("utf-8")) > MAX_FILE_BYTES:
            _err(out, "file_too_large", f"{item.name} is over {MAX_FILE_BYTES} bytes", where)
            continue
        unknown_sections = [k for k in item.section_keys if k not in prd_sections]
        if unknown_sections:
            _err(
                out,
                "unknown_section",
                f"{item.name}: PRD sections {', '.join(unknown_sections)} are not in the PRD "
                "version",
                where,
            )
        unknown_reqs = [str(r) for r in item.requirement_ids if str(r) not in requirement_ids]
        if unknown_reqs:
            _err(
                out,
                "unknown_requirement",
                f"{item.name}: requirements {', '.join(unknown_reqs)} are not in the spec request",
                where,
            )
        labels = [
            (f"{n}. {a.id}" + (f" [{a.section_key}]" if a.section_key else ""), a.note)
            for n, a in enumerate(item.annotations, start=1)
        ]
        sanitized: Sanitized = (
            sanitize_svg(body, title=item.title)
            if ext == "svg"
            else sanitize_wireframe(body, title=item.title, annotations=labels)
        )
        if sanitized.too_large:
            _err(
                out,
                "file_too_large",
                f"{item.name} is over {MAX_FILE_BYTES} bytes once sanitised",
                where,
            )
            continue
        for b in sanitized.blocked:
            _err(out, "unsafe_content", f"{item.name}: {b}", where)
        ids: set[str] = set()
        for a in item.annotations:
            if a.id in ids:
                _err(out, "duplicate_annotation", f"{item.name}: annotation {a.id} twice", where)
            ids.add(a.id)
            if a.target not in sanitized.targets:
                _err(
                    out,
                    "unknown_target",
                    f"{item.name}: annotation {a.id} points at {a.target!r}, which is not an "
                    "element id or data-annotation in the file",
                    where,
                )
            if a.section_key is not None and a.section_key not in prd_sections:
                _err(
                    out,
                    "unknown_section",
                    f"{item.name}: annotation {a.id} names PRD section {a.section_key!r}, "
                    "which is not in the PRD version",
                    where,
                )
            bad = [str(r) for r in a.requirement_ids if str(r) not in requirement_ids]
            if bad:
                _err(
                    out,
                    "unknown_requirement",
                    f"{item.name}: annotation {a.id} names requirements outside the request",
                    where,
                )
        if not sanitized.safe:
            continue
        # What is stored is what is served: escaping and Oracle's page can grow a file.
        if len(sanitized.content.encode("utf-8")) > MAX_FILE_BYTES:
            _err(
                out,
                "file_too_large",
                f"{item.name} is over {MAX_FILE_BYTES} bytes once sanitised",
                where,
            )
            continue
        checked = CheckedOutput(
            kind="user_flow" if ext == "svg" else "wireframe",
            name=item.name,
            title=item.title,
            media_type=MEDIA_TYPE[ext],
            content=sanitized.content,
            section_keys=list(dict.fromkeys(item.section_keys)),
            requirement_ids=[str(r) for r in dict.fromkeys(item.requirement_ids)],
            annotations=[a.model_dump(mode="json") for a in item.annotations],
            removed=sanitized.removed,
            screen=getattr(item, "screen", None),
        )
        (out.flows if ext == "svg" else out.wireframes).append(checked)
    return out
