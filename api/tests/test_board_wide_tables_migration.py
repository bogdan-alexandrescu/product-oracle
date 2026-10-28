"""Migration 0076_board_wide_tables: a company's unedited roadmap-board theme takes the
full-width goal table rule; an edited copy is left alone.

Card: protects=the revision chains on 0075_live_tokens as the single head, swaps the CSS
of built-in roadmap-board rows still exactly as seeded (and back on downgrade), and leaves
an owner's edited copy and other themes untouched; fails_when=an unedited copy keeps the
old CSS, an edited copy or another theme is overwritten, or the downgrade does not restore
it; no_claim=how the rule lays the page out (tests/test_board_goal_tables_span.py)."""

import importlib.util
import uuid

from alembic import command
from alembic.script import ScriptDirectory

from oracle.templates.builtins import BUILTIN_DIR
from tests.conftest import API_DIR
from tests.test_migrations import _cfg, _run, scratch_db  # noqa: F401

REVISION = "0076_board_wide_tables"
PREVIOUS = "0075_live_tokens"


def _migration():
    path = API_DIR / "migrations" / "versions" / f"{REVISION}.py"
    spec = importlib.util.spec_from_file_location(REVISION, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_chains_on_the_single_head():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0089_ritual_attendees_edited_at"]


def test_the_new_css_is_the_packaged_theme():
    m = _migration()
    assert m.NEW_CSS == (BUILTIN_DIR / "themes" / "roadmap-board.css").read_text("utf-8")
    assert "section-wide" in m.NEW_CSS and "section-wide" not in m.OLD_CSS


def test_upgrade_swaps_unedited_copies_and_downgrade_restores(scratch_db):  # noqa: F811
    m = _migration()
    cfg = _cfg()
    command.upgrade(cfg, PREVIOUS)
    seeded, edited, other = (uuid.uuid4() for _ in range(3))
    rows = [(seeded, m.OLD_CSS, "roadmap-board", True)]
    rows += [(edited, m.OLD_CSS + "\nh2 { color: teal; }", "roadmap-board", True)]
    rows += [(other, m.OLD_CSS, "clean-document", True)]
    for tenant, css, key, builtin in rows:
        _run("INSERT INTO tenants (id, name) VALUES (:id, 'Example Labs')", id=tenant)
        _run(
            "INSERT INTO themes (id, tenant_id, key, name, css, builtin) "
            "VALUES (:i, :t, :k, 'Theme', :c, :b)",
            i=uuid.uuid4(), t=tenant, k=key, c=css, b=builtin,
        )  # fmt: skip

    def css_of(tenant):
        return _run("SELECT css FROM themes WHERE tenant_id = :t", t=tenant)[0][0]

    command.upgrade(cfg, REVISION)
    assert css_of(seeded) == m.NEW_CSS
    assert css_of(edited) == m.OLD_CSS + "\nh2 { color: teal; }"
    assert css_of(other) == m.OLD_CSS
    command.downgrade(cfg, PREVIOUS)
    assert css_of(seeded) == m.OLD_CSS
    command.upgrade(cfg, REVISION)
    assert css_of(seeded) == m.NEW_CSS
