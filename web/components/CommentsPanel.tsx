"use client";

import { useEffect, useRef, useState } from "react";

import { Avatar, Button, Chip, Empty } from "@/components/ds";
import { LayerChip, Quote, TEXTAREA } from "@/components/review/parts";
import type { CommentOut } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";

export type PlacedComment = CommentOut & { heading: string; anchored: boolean };

function Reply({ onReply }: { onReply: (body: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  if (!open) {
    return (
      <Button variant="ghost" icon="comment" onClick={() => setOpen(true)}>
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
        className={TEXTAREA}
      />
      <div className="flex gap-2">
        <Button type="submit" variant="solid" disabled={saving || !body.trim()}>
          Reply
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
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
        <div className="flex items-center justify-center gap-1.5">
          <Empty>No comments</Empty>
          {canComment && !readOnly && <span className="sr-only">Select text in a section to comment on it.</span>}
        </div>
      )}
      <ol ref={listRef} className="-mx-5 flex flex-col max-[600px]:-mx-4" aria-label="Comments">
        {visible.map((c) => {
          const mine = userId !== null && c.author_id === userId;
          return (
            <li
              key={c.id}
              data-comment-id={c.id}
              data-testid="comment"
              className={`border-b border-line px-5 py-3 last:border-b-0 max-[600px]:px-4 ${
                c.id === activeId ? "bg-accent-soft shadow-[inset_4px_0_0_var(--accent)]" : ""
              } ${c.resolved_at ? "opacity-70" : ""}`}
            >
              <div className="flex items-start gap-2.5">
                <Avatar name={mine ? "You" : "Reviewer"} initials={mine ? "Me" : "R"} tone={mine ? "me" : "default"} />
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    className="block w-full text-left"
                    onClick={() => onSelect(c)}
                    aria-label={`Show comment in ${c.heading}`}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="min-w-0 truncate text-sm font-semibold text-accent-ink hover:underline">{c.heading}</span>
                      {showLayer && <LayerChip layer={c.layer} />}
                    </span>
                    {c.anchor && <Quote>{c.anchor.exact}</Quote>}
                    {!c.anchored && (
                      <span className="mt-1 block">
                        <Chip kind="warn">Quote not found</Chip>
                      </span>
                    )}
                  </button>
                  <p className="mt-1.5 text-[15px] leading-[22px] whitespace-pre-wrap text-text">{c.body}</p>
                  <p className="tnum mt-1 flex items-center gap-2 text-[13px] text-text2">
                    {formatDateTime(c.created_at)}
                    {c.resolved_at && <Chip kind="pass">Resolved</Chip>}
                  </p>
                  {c.replies.length > 0 && (
                    <ol className="mt-2 flex flex-col gap-2 border-l-2 border-line pl-3">
                      {c.replies.map((r) => (
                        <li key={r.id}>
                          <p className="text-[15px] leading-[22px] whitespace-pre-wrap text-text">{r.body}</p>
                          <p className="tnum text-[13px] text-text2">{formatDateTime(r.created_at)}</p>
                        </li>
                      ))}
                    </ol>
                  )}
                  {!readOnly && canComment && (
                    <div className="mt-1.5 -ml-2.5 flex flex-wrap items-center gap-1">
                      <Reply onReply={(body) => onReply(c.id, body)} />
                      {(canResolveAny || mine) && (
                        <Button variant="ghost" icon="check" onClick={() => onResolve(c.id, !c.resolved_at)}>
                          {c.resolved_at ? "Reopen" : "Resolve"}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {resolvedCount > 0 && (
        <Button variant="ghost" className="self-start" onClick={() => setShowResolved((s) => !s)}>
          {showResolved ? "Hide resolved" : `Show ${resolvedCount} resolved`}
        </Button>
      )}
    </div>
  );
}
