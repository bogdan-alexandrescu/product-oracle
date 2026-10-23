"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ds";

/**
 * A row's ⋯ menu. Its panel is fixed to the viewport under the button, so the table's
 * clipping never cuts it off; it opens upward when the room below (above a phone's tab bar)
 * is too short. Escape, a click outside or a scroll closes it.
 */
export function RowMenu({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [at, setAt] = useState<{ top: number; right: number; above: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = panel.current;
    if (!at || !el) return;
    const h = el.offsetHeight;
    // The phone's tab bar covers the bottom 80 px.
    if (at.top + h > window.innerHeight - 80 && at.above - h - 6 >= 8) el.style.top = `${at.above - h - 6}px`;
  }, [at]);
  useEffect(() => {
    if (!at) return;
    const close = () => setAt(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!root.current?.contains(t) && !panel.current?.contains(t)) close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [at]);
  return (
    <div ref={root} className="flex justify-end">
      <Button
        icon="more"
        aria-label={label}
        title={label}
        aria-expanded={!!at}
        aria-haspopup="menu"
        className="w-8 px-0"
        onClick={(e) => {
          if (at) return setAt(null);
          const r = e.currentTarget.getBoundingClientRect();
          setAt({ top: r.bottom + 6, right: Math.max(12, window.innerWidth - r.right), above: r.top });
        }}
      />
      {at && (
        <div
          ref={panel}
          role="menu"
          aria-label={label}
          style={{ top: at.top, right: at.right }}
          className="fixed z-40 flex w-max max-w-[calc(100vw-24px)] min-w-44 flex-col gap-0.5 rounded-panel border border-line bg-surface p-2 shadow-tip"
        >
          {children(() => setAt(null))}
        </div>
      )}
    </div>
  );
}

export function RowMenuItem({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex h-9 items-center rounded-lg px-2.5 text-left text-sm font-medium whitespace-nowrap text-text hover:bg-surface2"
    >
      {children}
    </button>
  );
}
