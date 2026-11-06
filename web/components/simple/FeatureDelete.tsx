"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";

import { toast as dsToast, type ToastAsk } from "@/components/ds";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/use-query";

/**
 * trash-features-goals: a roadmap feature's Delete from its row (the Gantt or Timeline row's
 * context menu, the Priorities row's ⋯). It goes to Settings › Trash, never deleted for good
 * here; the note's Undo restores it with its links, goal and milestone. Shown to who decides
 * on the feature (its own `can_decide`, or a Priorities row's `applies`). `onGone`: the feature
 * went to Trash (the page closes its panel).
 */
export function useFeatureDelete(reload: () => Promise<unknown>, toast: (ask: ToastAsk) => void = dsToast, onGone?: (id: string) => void) {
  return async (f: { id: string; title: string }): Promise<void> => {
    try {
      const out = await unwrap(api.DELETE("/v1/simple/roadmap/items/{item_id}", { params: { path: { item_id: f.id } } }));
      // In Trash: its panel, if open, closes with it.
      if (out.entry) onGone?.(f.id);
      await reload();
      if (!out.entry) {
        toast({ message: `Sent: delete ${f.title}. Its decider decides.` });
        return;
      }
      toast({
        message: `Moved ${f.title} to Trash.`,
        action: out.can_restore
          ? {
              label: "Undo",
              onClick: async () => {
                try {
                  await unwrap(api.POST("/v1/simple/roadmap/items/{item_id}/restore", { params: { path: { item_id: f.id } } }));
                  toast({ message: `Undone: ${f.title} and its links are back.` });
                } catch (e) {
                  toast({ message: errorMessage(e) });
                }
                await reload();
              },
            }
          : undefined,
      });
    } catch (e) {
      toast({ message: errorMessage(e) });
    }
  };
}

const ITEM = "flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-warn hover:bg-surface2";

/** The menu itself: at a point (a context menu) or under its ⋯ button. Escape or a click away closes it. */
function Menu({ title, onDelete, onClose, style, className }: { title: string; onDelete: () => void; onClose: () => void; style?: CSSProperties; className: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close.current();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    document.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    ref.current?.querySelector("button")?.focus();
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
    };
  }, []);
  return (
    <div ref={ref} role="menu" aria-label={`More for ${title}`} data-testid="feature-menu" style={style} className={`z-40 w-56 rounded-lg border border-line bg-surface p-1 text-[15px] shadow-lg ${className}`}>
      <button
        type="button"
        role="menuitem"
        className={ITEM}
        onClick={() => {
          onClose();
          onDelete();
        }}
      >
        Delete feature
      </button>
    </div>
  );
}

/** A row's context menu, opened where the person right-clicked (or pressed the menu key). */
export function FeatureContextMenu({ at, title, onDelete, onClose }: { at: { x: number; y: number }; title: string; onDelete: () => void; onClose: () => void }) {
  return <Menu title={title} onDelete={onDelete} onClose={onClose} className="fixed" style={{ left: Math.min(at.x, window.innerWidth - 232), top: Math.min(at.y, window.innerHeight - 56) }} />;
}

/** A row's ⋯ button and its menu. */
export function FeatureMenu({ title, onDelete }: { title: string; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative flex-none">
      <button
        type="button"
        aria-label={`More for ${title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border border-transparent text-[16px] text-text hover:border-line-strong hover:bg-surface2 ${open ? "border-line-strong bg-surface2" : ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        ⋯
      </button>
      {open && <Menu title={title} onDelete={onDelete} onClose={() => setOpen(false)} className="absolute right-0 top-9" />}
    </span>
  );
}
