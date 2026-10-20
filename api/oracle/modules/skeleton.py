"""Render a composition onto a template body: the template's own sections, untouched and
in their order, plus a section for each included module the template does not already
have.

The result is still an ordinary template body, so the existing conventions hold:
``{#id}`` headings, front matter with ``brief: [...]`` markers (O1f), the final
``Sources and data points`` section (O1c), and ``oracle.templates.service.draft_skeleton``
turns it into a first draft that ``oracle.docs.parser.parse_draft`` accepts. Template
sections are never removed or renamed, including ones mapped to a module the composition
excluded and ones no module claims (custom sections are preserved as-is).
"""

import re

from oracle.docs.parser import split_front_matter
from oracle.modules.composer import Composition, OutlineEntry
from oracle.templates.validation import check_template
from oracle.v2.contract import ModuleContract

_BRIEF_LINE = re.compile(r"^brief:\s*\[(.*)\]\s*$", re.M)


def _comment(text: str) -> str:
    return "<!-- " + " ".join(text.replace("--", "-").split()) + " -->"


def _safe_heading(text: str) -> str:
    return text.replace("{", "(").replace("}", ")").replace("\n", " ").strip()


def _module_block(entry: OutlineEntry, contract: ModuleContract | None) -> list[str]:
    guidance = contract.instructions if contract else ""
    if entry.layer == "brief":
        guidance = "Brief: fits one slide; plain language for an all-hands. " + guidance
    lines = [f"{'#' * entry.level} {_safe_heading(entry.heading)} {{#{entry.section_id}}}"]
    if guidance.strip():
        lines.append(_comment(guidance))
    return lines + [""]


def render_body(
    template_body: str, composition: Composition, contracts: dict[str, ModuleContract]
) -> str:
    """The template body with the composition's new module sections inserted."""
    text = template_body.replace("\r\n", "\n")
    check = check_template(text)
    lines = text.split("\n")
    headings = check.headings
    blocks: dict[str, list[str]] = {}
    first_line = headings[0].line - 1 if headings else len(lines)
    preamble = lines[:first_line]
    current: str | None = None
    for i, h in enumerate(headings):
        end = headings[i + 1].line - 1 if i + 1 < len(headings) else len(lines)
        chunk = lines[h.line - 1 : end]
        if h.key is None and current is not None:
            blocks[current].extend(chunk)  # a heading without an id stays with its parent
            continue
        current = h.key or f"__untitled_{i}"
        blocks[current] = chunk

    out = list(preamble)
    emitted: set[str] = set()
    new_brief: list[str] = []
    for entry in composition.outline:
        if entry.origin == "template":
            out.extend(blocks.get(entry.section_id, []))
            emitted.add(entry.section_id)
            continue
        if entry.layer == "brief":
            new_brief.append(entry.section_id)
        block = _module_block(entry, contracts.get(entry.module or ""))
        if out and out[-1].strip():
            out.append("")
        out.extend(block)
    for key, chunk in blocks.items():  # anything the outline did not list stays, at the end
        if key not in emitted:
            out.extend(chunk)
    body = "\n".join(out).rstrip("\n") + "\n"

    yaml_text, _, _ = split_front_matter(body)
    if new_brief and yaml_text is not None:
        match = _BRIEF_LINE.search(yaml_text)
        if match:
            items = [s.strip() for s in match.group(1).split(",") if s.strip()]
            updated = (
                yaml_text[: match.start()]
                + ("brief: [" + ", ".join(items + new_brief) + "]")
                + yaml_text[match.end() :]
            )
            body = body.replace(yaml_text, updated, 1)
    return body


__all__ = ["render_body"]
