"""A meeting's chat has its own discussion key (oracle.simple.chat, meet-chat-own-key)

A meeting's chat was the oldest panel discussion keyed by the meeting's screen
(``screen:/simple/meetings/<id>``), the key Oracle's Ask panel on that page also uses, so
whichever came first became the chat. The chat is now keyed ``meeting_chat:<id>``.

Upgrade: on each meeting screen key, the discussion the chat used (the oldest panel
discussion there) moves to the new key when the chat wrote in it (it holds a line of the
chat's own, ``model = 'oracle.simple.chat'``); an Ask discussion the chat adopted keeps
being the chat, as it holds the meeting's lines. A key whose oldest discussion holds no
chat line is an Ask discussion only and stays the Ask panel's.

Downgrade: the chats go back to the meeting's screen key.

Revision ID: 0095_meeting_chat_key
Revises: 0094_generation_checks
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0095_meeting_chat_key"
down_revision: str | None = "0094_generation_checks"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCREEN = "screen:/simple/meetings/"
OWN = "meeting_chat:"


def upgrade() -> None:
    op.execute(
        f"""
        UPDATE discussions d
        SET subject_key = '{OWN}' || substr(d.subject_key, {len(SCREEN) + 1})
        FROM (
            SELECT DISTINCT ON (tenant_id, subject_key) id
            FROM discussions
            WHERE origin = 'panel'
              AND subject_key ~ '^{SCREEN}[0-9a-f-]{{36}}$'
            ORDER BY tenant_id, subject_key, created_at, id
        ) chat
        WHERE d.id = chat.id
          AND EXISTS (
            SELECT 1 FROM discussion_messages m
            WHERE m.discussion_id = d.id AND m.model = 'oracle.simple.chat'
          )
        """
    )


def downgrade() -> None:
    op.execute(
        f"""
        UPDATE discussions
        SET subject_key = '{SCREEN}' || substr(subject_key, {len(OWN) + 1})
        WHERE origin = 'panel' AND subject_key LIKE '{OWN}%'
        """
    )
