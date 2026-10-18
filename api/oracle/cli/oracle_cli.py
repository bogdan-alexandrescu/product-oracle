"""``oracle``: the agent track's bridge to the API.

    oracle push <draft.md> [--doc slug]
    oracle pull <doc> --version N [--out dir]
    oracle sync [--source ID]
    oracle baseline push <graph.yaml>
    oracle baseline pull [--out graph.yaml]
    oracle tick [--every SECONDS]

Configuration comes from the environment (flags override it):
    ORACLE_URL        API base URL (default http://localhost:8000)
    ORACLE_API_TOKEN  API token from ``make seed`` (required)

Exit codes: 0 ok, 1 the API refused or failed, 2 usage or configuration error.
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, TextIO
from urllib.parse import quote

import httpx
import yaml

DEFAULT_URL = "http://localhost:8000"
TIMEOUT = httpx.Timeout(30.0, read=120.0)


class CliError(Exception):
    def __init__(self, message: str, code: int = 1):
        super().__init__(message)
        self.code = code


def _client(args: argparse.Namespace, transport: httpx.BaseTransport | None) -> httpx.Client:
    token = args.token or os.environ.get("ORACLE_API_TOKEN")
    if not token:
        raise CliError("ORACLE_API_TOKEN is not set (create one with `make seed`)", 2)
    url = (args.url or os.environ.get("ORACLE_URL") or DEFAULT_URL).rstrip("/")
    return httpx.Client(
        base_url=url,
        headers={"Authorization": f"Bearer {token}", "User-Agent": "oracle-cli"},
        timeout=TIMEOUT,
        transport=transport,
    )


def _send(client: httpx.Client, method: str, path: str, **kwargs: Any) -> httpx.Response:
    try:
        return client.request(method, path, **kwargs)
    except httpx.HTTPError as e:
        raise CliError(f"cannot reach {client.base_url}: {e}") from e


def _api_error(resp: httpx.Response) -> CliError:
    try:
        body = resp.json()
    except ValueError:
        body = None
    detail = body.get("detail") if isinstance(body, dict) else None
    if resp.status_code == 401:
        detail = "API token rejected (check ORACLE_API_TOKEN)"
    lines = [f"error {resp.status_code}: {detail or resp.text.strip() or resp.reason_phrase}"]
    for err in (body.get("errors") or []) if isinstance(body, dict) else []:
        where = err.get("section_key") or err.get("cite_key") or err.get("where")
        line = f"  - [{err.get('code')}] {err.get('message')}"
        if where:
            line += f" ({where})"
        if err.get("line"):
            line += f" line {err['line']}"
        lines.append(line)
    return CliError("\n".join(lines))


def _front_matter(text: str) -> dict[str, Any]:
    if not text.startswith("---"):
        return {}
    parts = text.split("\n---", 1)
    if len(parts) < 2:
        return {}
    try:
        data = yaml.safe_load(parts[0].removeprefix("---"))
    except yaml.YAMLError:
        return {}  # the API reports front matter problems properly
    return data if isinstance(data, dict) else {}


# --- commands ---------------------------------------------------------------------


def push(args: argparse.Namespace, transport: httpx.BaseTransport | None, out: TextIO) -> int:
    path = Path(args.draft)
    try:
        markdown = path.read_text(encoding="utf-8")
    except OSError as e:
        raise CliError(f"cannot read {path}: {e.strerror}", 2) from e
    slug = args.doc or _front_matter(markdown).get("document")
    if not slug:
        raise CliError("no document slug: pass --doc or set `document:` in the front matter", 2)

    with _client(args, transport) as client:
        resp = _send(
            client,
            "POST",
            f"/v1/documents/{quote(str(slug), safe='')}/versions",
            content=markdown.encode("utf-8"),
            headers={"Content-Type": "text/markdown; charset=utf-8"},
        )
    if resp.status_code not in (200, 201):
        raise _api_error(resp)

    version = resp.json()
    number = version["number"]
    if resp.status_code == 201:
        print(f"Imported {slug} version {number}", file=out)
    else:
        print(f"Unchanged: {slug} version {number} has the same content", file=out)
    warnings = version.get("warnings") or []
    for w in warnings:
        keys = ", ".join(w.get("section_keys") or [])
        print(
            f"warning [{w.get('code')}]: {w.get('message')}" + (f" ({keys})" if keys else ""),
            file=out,
        )
    if not warnings:
        print("No warnings", file=out)
    return 0


def pull(args: argparse.Namespace, transport: httpx.BaseTransport | None, out: TextIO) -> int:
    with _client(args, transport) as client:
        resp = _send(
            client,
            "GET",
            f"/v1/documents/{quote(args.doc, safe='')}/versions/{args.version}/feedback-package",
        )
    if resp.status_code != 200:
        raise _api_error(resp)
    package = resp.json()

    out_dir = Path(args.out)
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        stem = f"{package.get('slug') or args.doc}-v{package['version']}"
        files = {
            out_dir / f"{stem}.md": package["markdown"],
            out_dir / f"{stem}.open-items.json": _json(package["open_items"]),
            out_dir / f"{stem}.locked.json": _json(package["locked_section_keys"]),
            out_dir / f"{stem}.feedback-package.json": _json(package),
        }
        for file, content in files.items():
            file.write_text(content, encoding="utf-8")
    except OSError as e:
        raise CliError(f"cannot write to {out_dir}: {e.strerror}", 2) from e

    locked = package["locked_section_keys"]
    print(
        f"Pulled {stem}: {len(package['open_items'])} open item(s), "
        f"{len(locked)} locked section(s)" + (f" ({', '.join(locked)})" if locked else ""),
        file=out,
    )
    for file in files:
        print(f"  wrote {file}", file=out)
    return 0


def _sync_line(result: dict[str, Any]) -> str:
    source = result.get("source") or {}
    name = source.get("name") or result.get("source_id")
    counts = (
        f"{result.get('upserted', 0)} item(s) seen, {result.get('versions_written', 0)} new "
        f"version(s), {result.get('deleted', 0)} deleted"
    )
    outcome = result.get("outcome")
    if outcome == "rate_limited":
        wait = result.get("retry_after")
        after = f", retry after {wait:g}s" if isinstance(wait, int | float) else ""
        return f"{name}: rate limited, resumes from the saved position ({counts}{after})"
    if outcome == "error":
        return f"{name}: error: {result.get('error')}"
    return f"{name}: synced ({counts})"


def sync(args: argparse.Namespace, transport: httpx.BaseTransport | None, out: TextIO) -> int:
    with _client(args, transport) as client:
        if args.source:
            ids = [args.source]
        else:
            resp = _send(client, "GET", "/v1/sources")
            if resp.status_code != 200:
                raise _api_error(resp)
            sources = resp.json()
            # Uploads have nothing to pull; paused sources wait for a resume.
            ids = [s["id"] for s in sources if s["kind"] != "upload" and s["status"] != "paused"]
            if not ids:
                print("No sources to sync", file=out)
                return 0
        failed = 0
        for source_id in ids:
            resp = _send(client, "POST", f"/v1/sources/{quote(str(source_id), safe='')}/sync")
            if resp.status_code != 200:
                if args.source:
                    raise _api_error(resp)
                print(f"{source_id}: {_api_error(resp)}", file=out)
                failed += 1
                continue
            result = resp.json()
            print(_sync_line(result), file=out)
            failed += result.get("outcome") == "error"
    return 1 if failed else 0


def baseline_push(
    args: argparse.Namespace, transport: httpx.BaseTransport | None, out: TextIO
) -> int:
    path = Path(args.file)
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as e:
        raise CliError(f"cannot read {path}: {e.strerror}", 2) from e
    with _client(args, transport) as client:
        resp = _send(
            client,
            "POST",
            "/v1/baseline/yaml",
            content=text.encode("utf-8"),
            headers={"Content-Type": "application/yaml; charset=utf-8"},
        )
    if resp.status_code != 200:
        raise _api_error(resp)
    r = resp.json()
    print(
        f"Imported {path.name}: {r['created']} created, {r['updated']} updated, "
        f"{r['unchanged']} unchanged, {r['evidence_added']} evidence added",
        file=out,
    )
    if r["proposals"]:
        print(f"{r['proposals']} change(s) to locked items became proposals", file=out)
    for note in r.get("notes") or []:
        where = f" ({note['where']})" if note.get("where") else ""
        print(f"note [{note['code']}]: {note['message']}{where}", file=out)
    return 0


def baseline_pull(
    args: argparse.Namespace, transport: httpx.BaseTransport | None, out: TextIO
) -> int:
    with _client(args, transport) as client:
        resp = _send(client, "GET", "/v1/baseline/yaml")
    if resp.status_code != 200:
        raise _api_error(resp)
    if args.out == "-":
        out.write(resp.text)
        return 0
    path = Path(args.out)
    try:
        path.write_text(resp.text, encoding="utf-8")
    except OSError as e:
        raise CliError(f"cannot write {path}: {e.strerror}", 2) from e
    print(f"Pulled the baseline to {path}", file=out)
    return 0


def tick(args: argparse.Namespace, transport: httpx.BaseTransport | None, out: TextIO) -> int:
    """Advance active runs once, or every ``--every`` seconds until interrupted."""
    with _client(args, transport) as client:
        while True:
            resp = _send(client, "POST", "/v1/internal/tick")
            if resp.status_code != 200:
                raise _api_error(resp)
            r = resp.json()
            print(
                f"Checked {r['runs_checked']} run(s): {r['segments_finished']} segment(s) "
                f"finished, {r['runs_advanced']} advanced, {r['runs_paused']} paused on overrun",
                file=out,
            )
            for error in r.get("errors") or []:
                print(f"  error: {error}", file=out)
            if not args.every:
                return 0
            out.flush()
            time.sleep(args.every)


def _json(value: Any) -> str:
    return json.dumps(value, indent=2, ensure_ascii=False) + "\n"


# --- entry point ------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="oracle",
        description=(
            "Push PRD drafts and the baseline to Product Oracle, pull them back, sync "
            "sources, advance runs."
        ),
        epilog="Environment: ORACLE_URL (default http://localhost:8000), ORACLE_API_TOKEN.",
    )
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--url", help="API base URL (overrides ORACLE_URL)")
    common.add_argument("--token", help="API token (overrides ORACLE_API_TOKEN)")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("push", parents=[common], help="import a draft as the next version")
    p.add_argument("draft", help="draft markdown file with YAML front matter")
    p.add_argument("--doc", help="document slug (default: `document` from the front matter)")
    p.set_defaults(func=push)

    p = sub.add_parser("pull", parents=[common], help="write a version's feedback package")
    p.add_argument("doc", help="document slug or id")
    p.add_argument("--version", type=int, required=True, help="version number")
    p.add_argument("--out", "-o", default=".", help="output directory (default: .)")
    p.set_defaults(func=pull)

    p = sub.add_parser("sync", parents=[common], help="sync your sources now")
    p.add_argument("--source", help="source id (default: every active source of yours)")
    p.set_defaults(func=sync)

    p = sub.add_parser("baseline", help="push or pull the baseline graph as YAML")
    bsub = p.add_subparsers(dest="baseline_command", required=True)
    b = bsub.add_parser(
        "push", parents=[common], help="merge a YAML graph in (locked items get proposals)"
    )
    b.add_argument("file", help="baseline YAML file")
    b.set_defaults(func=baseline_push)
    b = bsub.add_parser("pull", parents=[common], help="write the whole graph as YAML")
    b.add_argument(
        "--out",
        "-o",
        default="baseline.yaml",
        help="output file, - for stdout (default: baseline.yaml)",
    )
    b.set_defaults(func=baseline_pull)

    p = sub.add_parser("tick", parents=[common], help="advance active runs (poll their agents)")
    p.add_argument("--every", type=float, metavar="SECONDS", help="repeat until interrupted")
    p.set_defaults(func=tick)
    return parser


def main(
    argv: list[str] | None = None,
    *,
    transport: httpx.BaseTransport | None = None,
    out: TextIO | None = None,
    err: TextIO | None = None,
) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args, transport, out or sys.stdout)
    except CliError as e:
        print(f"oracle: {e}", file=err or sys.stderr)
        return e.code


if __name__ == "__main__":
    sys.exit(main())
