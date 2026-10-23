"use client";

import { useEffect, useRef, type PointerEvent, type ReactNode } from "react";

import { Icon } from "./Icon";

/*
 * The control last pressed: a tap on some browsers (Safari) does not focus the button, so
 * the sheet it opens finds <body> focused and returns focus here instead.
 */
let lastPressed: HTMLElement | null = null;
if (typeof document !== "undefined") {
  document.addEventListener(
    "pointerdown",
    (e) => {
      const el = e.target instanceof Element ? e.target.closest<HTMLElement>("button, a[href], [role=button], [tabindex]") : null;
      if (el) lastPressed = el;
    },
    true,
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A phone bottom sheet: a scrim, a handle, a title and a scrolling body. Escape, a tap on
 * the scrim, the close button and a swipe down on the handle close it; focus stays inside
 * while it is open and returns to what opened it.
 */
export function Sheet({
  open,
  title,
  onClose,
  children,
  testId,
  tools,
  scroll = true,
  full = false,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
  /** Right of the title, before the close button. */
  tools?: ReactNode;
  /** The body scrolls (default); false: the content scrolls a part of itself (a list under its filters). */
  scroll?: boolean;
  /** Full height (the head-of-product panel on a phone). */
  full?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; dy: number } | null>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const active = document.activeElement as HTMLElement | null;
    // Focus returns to what opened the sheet: the focused control, else the one just pressed.
    const opener = active && active !== document.body ? active : lastPressed;
    const p = panel.current;
    (p?.querySelector<HTMLElement>("[data-autofocus]") ?? p)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close.current();
        return;
      }
      if (e.key !== "Tab" || !p) return;
      const els = [...p.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.checkVisibility());
      if (els.length === 0) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === p)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    const html = document.documentElement;
    const overflow = html.style.overflow;
    html.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey, true);
      html.style.overflow = overflow;
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);

  if (!open) return null;

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { y: e.clientY, dy: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || !panel.current) return;
    drag.current.dy = Math.max(0, e.clientY - drag.current.y);
    panel.current.style.transform = `translateY(${drag.current.dy}px)`;
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (panel.current) panel.current.style.transform = "";
    if (d && d.dy > 60) onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" data-testid={testId}>
      <div data-testid="sheet-scrim" aria-hidden className="absolute inset-0 bg-hero/50" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`relative flex ${full ? "h-dvh max-h-dvh" : "max-h-[85dvh]"} min-h-0 touch-44 flex-col rounded-t-inspector border-t border-line bg-surface text-text shadow-tip outline-none`}
      >
        <div
          data-testid="sheet-handle"
          aria-hidden
          className="flex h-6 flex-none cursor-grab touch-none items-center justify-center"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          <span className="h-1 w-10 rounded-full bg-line-strong" />
        </div>
        <div className="flex min-h-11 flex-none items-center gap-2 border-b border-line pr-1 pl-4">
          <h2 className="min-w-0 flex-1 truncate font-display text-lg font-bold tracking-heading">{title}</h2>
          {tools}
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${title}`}
            className="grid size-11 flex-none place-items-center rounded-button text-text2 hover:bg-surface2 hover:text-text"
          >
            <Icon name="x" size={20} />
          </button>
        </div>
        <div
          className={`relative min-h-0 flex-1 pb-[env(safe-area-inset-bottom)] ${scroll ? "overflow-y-auto overscroll-contain" : "flex flex-col"}`}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
