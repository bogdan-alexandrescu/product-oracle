"use client";

import { useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ds";
import { InlineError, Kbd, Quote, TEXTAREA } from "@/components/review/parts";
import type { TextQuoteSelector } from "@/lib/anchor";

export type PageRect = { top: number; left: number; bottom: number };

/** Floating "Comment" affordance shown next to a text selection. */
export function SelectionButton({ rect, onOpen }: { rect: PageRect; onOpen: () => void }) {
  return createPortal(
    <div className="absolute z-40" style={{ top: rect.bottom + 6, left: rect.left }}>
      <Button
        variant="primary"
        icon="comment"
        className="shadow-tip"
        // Keep the text selection alive while clicking.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onOpen}
      >
        Comment <kbd className="rounded border border-on-accent/40 px-1 font-mono text-[13px] leading-none">c</kbd>
      </Button>
    </div>,
    document.body,
  );
}

/** Comment composer anchored under the selected text. */
export function CommentPopover({
  rect,
  anchor,
  onCancel,
  onSubmit,
}: {
  rect: PageRect;
  anchor: TextQuoteSelector;
  onCancel: () => void;
  onSubmit: (body: string) => Promise<void>;
}) {
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!body.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit(body.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the comment.");
      setSaving(false);
    }
  }

  const left = Math.max(8, Math.min(rect.left, window.scrollX + window.innerWidth - 360 - 8));

  return createPortal(
    <div
      role="dialog"
      aria-label="New comment"
      className="absolute z-40 w-[22rem] max-w-[calc(100vw-16px)] rounded-panel border border-line bg-surface p-3 text-text shadow-tip"
      style={{ top: rect.bottom + 6, left }}
      onKeyDown={(e) => e.key === "Escape" && onCancel()}
    >
      <p className="mb-2">
        <Quote>{anchor.exact}</Quote>
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          autoFocus
          aria-label="Comment"
          placeholder="Add a comment…"
          rows={3}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          className={TEXTAREA}
        />
        {error && <InlineError>{error}</InlineError>}
        <div className="mt-2 flex items-center gap-2">
          <span className="flex items-center gap-1 text-[13px] text-text2">
            <Kbd>⌘</Kbd>
            <Kbd>↵</Kbd>
          </span>
          <Button variant="ghost" className="ml-auto" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="solid" disabled={!body.trim() || saving}>
            {saving ? "Saving…" : "Comment"}
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
