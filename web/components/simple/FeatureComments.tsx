/**
 * Comments on a feature (#1553): the feature panel's Comments, oldest first, with a field at the
 * end (Enter sends, Shift+Enter a new line). A comment shows at once and is taken back, with the
 * error, when refused. Everyone who can open the app comments; a person edits and deletes their
 * own, an owner deletes any (each comment's can_* fields). Plain text, links shown as links.
 */
import { useEffect, useState } from 'react';
import { toast } from '@/components/ds';
import { api, unwrap, type Schemas } from '@/lib/api/client';
import { formatInZone, useCompanyZone } from '@/lib/dates';
import { useMe } from '@/lib/me';
import { errorMessage, useQuery } from '@/lib/use-query';

type Comment = Schemas['FeatureCommentOut'];
type Count = Schemas['FeatureCommentCount'];
export type CommentedItem = { id: string; key: string; roadmap: { id: string } };

const MAX = 2000;
/** The count shows only near the cap. */
const NEAR = MAX - 200;
const CHANGED = 'po:comments-changed';
const changed = () => window.dispatchEvent(new Event(CHANGED));

function Linked({ text }: { text: string }) {
  return (
    <>
      {text.split(/(https?:\/\/[^\s<>"]+)/g).map((part, i) =>
        i % 2 ? (
          <a
            key={i}
            href={part}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-accent-ink underline break-all"
          >
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  );
}

function Field({
  value,
  onChange,
  onSend,
  onCancel,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onCancel?: () => void;
  label: string;
}) {
  return (
    <div>
      <textarea
        aria-label={label}
        placeholder={label}
        rows={2}
        maxLength={MAX}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onSend();
          } else if (e.key === 'Escape' && onCancel) {
            e.stopPropagation();
            onCancel();
          }
        }}
        className="w-full resize-y rounded-lg border border-line-strong bg-surface px-2 py-1.5 text-sm"
      />
      {value.length >= NEAR && (
        <p data-testid="comment-count-left" className="text-right text-xs text-text2">
          {value.length}/{MAX}
        </p>
      )}
    </div>
  );
}

/** The panel's Comments section, for the feature `item` (the row the panel shows). */
export function FeatureComments({ item }: { item: CommentedItem }) {
  const zone = useCompanyZone();
  const { can } = useMe();
  const path = { params: { path: { item_id: item.id } } };
  const list = useQuery(`feature-comments:${item.id}`, () =>
    unwrap(api.GET('/v1/simple/roadmap/items/{item_id}/comments', path)),
  );
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);

  const send = async () => {
    const body = draft.trim();
    if (!body) return;
    const temp: Comment = {
      id: `pending-${Date.now()}`,
      author: { id: '', name: 'You' },
      body,
      created_at: new Date().toISOString(),
      edited_at: null,
      can_edit: false,
      can_delete: false,
    };
    setDraft('');
    list.setData((prev) => [...(prev ?? []), temp]);
    try {
      const made = await unwrap(
        api.POST('/v1/simple/roadmap/items/{item_id}/comments', { ...path, body: { body } }),
      );
      list.setData((prev) => (prev ?? []).map((c) => (c.id === temp.id ? made : c)));
      changed();
    } catch (e) {
      list.setData((prev) => (prev ?? []).filter((c) => c.id !== temp.id));
      setDraft(body);
      toast({ message: errorMessage(e) });
    }
  };

  const save = async () => {
    if (!editing) return;
    const body = editing.body.trim();
    const was = list.data?.find((c) => c.id === editing.id);
    if (!body || !was) return;
    setEditing(null);
    list.setData((prev) => (prev ?? []).map((c) => (c.id === was.id ? { ...c, body } : c)));
    try {
      const saved = await unwrap(
        api.PATCH('/v1/simple/roadmap/items/{item_id}/comments/{comment_id}', {
          params: { path: { item_id: item.id, comment_id: was.id } },
          body: { body },
        }),
      );
      list.setData((prev) => (prev ?? []).map((c) => (c.id === was.id ? saved : c)));
    } catch (e) {
      list.setData((prev) => (prev ?? []).map((c) => (c.id === was.id ? was : c)));
      toast({ message: errorMessage(e) });
    }
  };

  const remove = async (c: Comment) => {
    const before = list.data ?? [];
    list.setData((prev) => (prev ?? []).filter((x) => x.id !== c.id));
    try {
      await unwrap(
        api.DELETE('/v1/simple/roadmap/items/{item_id}/comments/{comment_id}', {
          params: { path: { item_id: item.id, comment_id: c.id } },
        }),
      );
      changed();
    } catch (e) {
      list.setData(() => before);
      toast({ message: errorMessage(e) });
    }
  };

  return (
    <section data-testid="feature-comments" className="mt-4 border-t border-line pt-3">
      <h3 className="text-sm font-semibold text-text2">Comments</h3>
      {list.error && !list.data && <p className="mt-1 text-sm text-text2">{list.error}</p>}
      <ul className="mt-2 space-y-3">
        {(list.data ?? []).map((c) => (
          <li key={c.id} data-testid="feature-comment" className="text-sm">
            <div className="flex items-baseline gap-2">
              <span className="font-semibold">{c.author.name}</span>
              <span className="text-xs text-text2">
                {formatInZone(c.created_at, zone, {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
                {c.edited_at ? ' · edited' : ''}
              </span>
              <span className="ml-auto flex gap-2 text-xs">
                {c.can_edit && (
                  <button
                    type="button"
                    className="text-text2 hover:underline"
                    onClick={() => setEditing({ id: c.id, body: c.body })}
                  >
                    Edit
                  </button>
                )}
                {c.can_delete && (
                  <button
                    type="button"
                    className="text-text2 hover:underline"
                    onClick={() => void remove(c)}
                  >
                    Delete
                  </button>
                )}
              </span>
            </div>
            {editing?.id === c.id ? (
              <Field
                label="Edit comment"
                value={editing.body}
                onChange={(body) => setEditing({ id: c.id, body })}
                onSend={() => void save()}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <p data-user-content className="whitespace-pre-wrap break-words">
                <Linked text={c.body} />
              </p>
            )}
          </li>
        ))}
      </ul>
      {can('add_feature_comment', true) && (
        <div className="mt-2">
          <Field
            label="Add a comment"
            value={draft}
            onChange={setDraft}
            onSend={() => void send()}
          />
        </div>
      )}
    </section>
  );
}

/** The feature's comment count on its row or card, shown only when it has one. */
export function CommentCount({ item }: { item: CommentedItem }) {
  const counts = useQuery('feature-comment-counts', () =>
    unwrap(api.GET('/v1/simple/comment-counts', {})),
  );
  const { reload } = counts;
  useEffect(() => {
    const on = () => void reload();
    window.addEventListener(CHANGED, on);
    return () => window.removeEventListener(CHANGED, on);
  }, [reload]);
  const n =
    counts.data?.find((c: Count) => c.roadmap_id === item.roadmap.id && c.key === item.key)
      ?.count ?? 0;
  if (!n) return null;
  return (
    <span
      data-testid="comment-count"
      aria-label={`${n} comment${n === 1 ? '' : 's'}`}
      title={`${n} comment${n === 1 ? '' : 's'}`}
      className="ml-1.5 inline-flex items-center gap-0.5 align-middle text-xs text-text2"
    >
      <svg
        aria-hidden
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      {n}
    </span>
  );
}
