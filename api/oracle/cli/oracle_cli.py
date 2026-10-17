"""``oracle``: the agent track's bridge to the API.

    oracle push <draft.md> [--doc slug]
    oracle pull <doc> --version N [--out dir]

Configuration comes from the environment (flags override it):
    ORACLE_URL        API base URL (default http://localhost:8000)
    ORACLE_API_TOKEN  API token from ``make seed`` (required)

Exit codes: 0 ok, 1 the API refused or failed, 2 usage or configuration error.
"""

import argparse
import json
import os
import sys
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
        where = err.get("section_key") or err.get("cite_key")
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


def _json(value: Any) -> str:
    return json.dumps(value, indent=2, ensure_ascii=False) + "\n"


# --- entry point ------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="oracle",
        description="Push PRD drafts to Product Oracle and pull review feedback.",
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
