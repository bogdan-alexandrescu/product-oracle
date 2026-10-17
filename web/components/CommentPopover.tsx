"use client";

import { useState } from "react";
import { createPortal } from "react-dom";

import { Button, Kbd } from "@/components/ui";
import type { TextQuoteSelector } from "@/lib/anchor";

export type PageRect = { top: number; left: number; bottom: number };

/** Floating "Comment" affordance shown next to a text selection. */
export function SelectionButton({ rect, onOpen }: { rect: PageRect; onOpen: () => void }) {
  return createPortal(
    <div className="absolute z-40" style={{ top: rect.bottom + 6, left: rect.left }}>
      <Button
        size="sm"
        variant="primary"
        className="shadow-md"
        // Keep the text selection alive while clicking.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onOpen}
      >
        Comment <Kbd>c</Kbd>
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
      className="absolute z-40 w-[22rem] rounded-lg border border-neutral-200 bg-white p-3 shadow-xl"
      style={{ top: rect.bottom + 6, left }}
      onKeyDown={(e) => e.key === "Escape" && onCancel()}
    >
      <p className="mb-2 line-clamp-2 border-l-2 border-amber-300 pl-2 text-xs text-neutral-600">{anchor.exact}</p>
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
          className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
        />
        {error && <p className="mt-1 text-xs text-rose-700">{error}</p>}
        <div className="mt-2 flex items-center gap-2">
          <span className="text-xs text-neutral-400">Ctrl/⌘ + Enter</span>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm" disabled={!body.trim() || saving}>
            {saving ? "Saving…" : "Comment"}
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
