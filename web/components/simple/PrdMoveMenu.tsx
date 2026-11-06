"use client";

import { useEffect, useRef, useState } from "react";

const ICON = "inline-flex h-8 w-8 flex-none items-center justify-center rounded-lg border border-transparent text-[16px] text-text hover:border-line-strong hover:bg-surface2";
const MENU = "absolute right-0 top-9 z-30 w-48 rounded-lg border border-line bg-surface p-1 text-[15px] shadow-lg";
const ITEM = "flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left hover:bg-surface2";

/** prd-order: the ⋯ menu on a PRD, as on a goal: Move up and Move down (none on the first or the last PRD). */
export function PrdMoveMenu({ title, onUp, onDown, busy }: { title: string; onUp?: () => void; onDown?: () => void; busy?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  const items: [string, () => void][] = [];
  if (onUp) items.push(["Move up", onUp]);
  if (onDown) items.push(["Move down", onDown]);
  if (!items.length) return null;
  return (
    <span ref={ref} className="relative z-10">
      <button type="button" aria-label={`More for ${title}`} aria-haspopup="menu" aria-expanded={open} disabled={busy} className={`${ICON} ${open ? "border-line-strong bg-surface2" : ""}`} onClick={() => setOpen((o) => !o)}>
        ⋯
      </button>
      {open && (
        <div role="menu" className={MENU}>
          {items.map(([label, go]) => (
            <button
              key={label}
              type="button"
              role="menuitem"
              className={ITEM}
              onClick={() => {
                setOpen(false);
                go();
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
