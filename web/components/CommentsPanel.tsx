"use client";

import { useEffect, useRef, useState } from "react";

import { Button, LayerBadge } from "@/components/ui";
import type { CommentOut } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";

export type PlacedComment = CommentOut & { heading: string; anchored: boolean };

function Reply({ onReply }: { onReply: (body: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  if (!open) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Reply
      </Button>
    );
  }
  const submit = async () => {
    if (!body.trim()) return;
    setSaving(true);
    try {
      await onReply(body.trim());
      setBody("");
      setOpen(false);
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      className="mt-2 flex w-full flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        autoFocus
        aria-label="Reply"
        rows={2}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          if (e.key === "Escape") setOpen(false);
        }}
        className="rounded-md border border-neutral-300 px-2 py-1 text-sm"
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={saving || !body.trim()}>
          Reply
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function CommentsPanel({
  comments,
  activeId,
  readOnly,
  canComment,
  canResolveAny,
  userId,
  onSelect,
  onReply,
  onResolve,
  showLayer = false,
}: {
  /** Say whether each comment is on a brief or a detail section (O1f). */
  showLayer?: boolean;
  comments: PlacedComment[];
  activeId: string | null;
  /** The version is approved: no replies or resolving. */
  readOnly: boolean;
  /** Commenter or above: may reply, and resolve their own threads. */
  canComment: boolean;
  /** Approver or above: may resolve anyone's thread. */
  canResolveAny: boolean;
  userId: string | null;
  onSelect: (c: PlacedComment) => void;
  onReply: (id: string, body: string) => Promise<void>;
  onResolve: (id: string, resolved: boolean) => Promise<void>;
}) {
  const [showResolved, setShowResolved] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const visible = comments.filter((c) => showResolved || !c.resolved_at);
  const resolvedCount = comments.filter((c) => c.resolved_at).length;

  useEffect(() => {
    if (!activeId) return;
    listRef.current
      ?.querySelector(`[data-comment-id="${activeId}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeId]);

  return (
    <div className="flex flex-col gap-3">
      {comments.length === 0 && (
        <p className="text-sm text-neutral-500">
          No comments on this version yet.{canComment && !readOnly && " Select text in a section to comment on it."}
        </p>
      )}
      <ol ref={listRef} className="flex flex-col gap-2" aria-label="Comments">
        {visible.map((c) => (
          <li
            key={c.id}
            data-comment-id={c.id}
            data-testid="comment"
            className={`rounded-md border px-3 py-2 text-sm transition-colors ${
              c.id === activeId ? "border-neutral-400 bg-white shadow-sm" : "border-neutral-200 bg-white"
            } ${c.resolved_at ? "opacity-60" : ""}`}
          >
            <button
              type="button"
              className="block w-full text-left"
              onClick={() => onSelect(c)}
              aria-label={`Show comment in ${c.heading}`}
            >
              <span className="flex items-center gap-1.5 text-xs text-neutral-500">
                {c.heading}
                {showLayer && <LayerBadge layer={c.layer} />}
              </span>
              {c.anchor && (
                <span className="mt-1 line-clamp-2 block border-l-2 border-amber-300 pl-2 text-xs text-neutral-600">
                  {c.anchor.exact}
                </span>
              )}
              {!c.anchored && (
                <span className="mt-1 block text-xs text-amber-800">Quoted text not found in this version.</span>
              )}
            </button>
            <p className="mt-1.5 whitespace-pre-wrap text-neutral-900">{c.body}</p>
            <p className="mt-1 text-xs text-neutral-400">
              {formatDateTime(c.created_at)}
              {c.resolved_at && " · resolved"}
            </p>
            {c.replies.length > 0 && (
              <ol className="mt-2 flex flex-col gap-1.5 border-l border-neutral-200 pl-3">
                {c.replies.map((r) => (
                  <li key={r.id}>
                    <p className="whitespace-pre-wrap text-neutral-800">{r.body}</p>
                    <p className="text-xs text-neutral-400">{formatDateTime(r.created_at)}</p>
                  </li>
                ))}
              </ol>
            )}
            {!readOnly && canComment && (
              <div className="mt-1 flex flex-wrap items-center gap-1">
                <Reply onReply={(body) => onReply(c.id, body)} />
                {(canResolveAny || (userId !== null && c.author_id === userId)) && (
                  <Button size="sm" variant="ghost" onClick={() => onResolve(c.id, !c.resolved_at)}>
                    {c.resolved_at ? "Reopen" : "Resolve"}
                  </Button>
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
      {resolvedCount > 0 && (
        <button
          type="button"
          className="self-start text-xs text-neutral-500 underline underline-offset-2 hover:text-neutral-800"
          onClick={() => setShowResolved((s) => !s)}
        >
          {showResolved ? "Hide resolved" : `Show ${resolvedCount} resolved`}
        </button>
      )}
    </div>
  );
}
