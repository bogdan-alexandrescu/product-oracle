"use client";

import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";

import { Button } from "./Button";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * While `open`: focus moves to the `[data-autofocus]` element (else the dialog), Tab and
 * Shift+Tab stay inside `ref`, Escape calls `onClose`; on close, focus goes back to what
 * had it when the dialog opened.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (ref.current?.querySelector<HTMLElement>("[data-autofocus]") ?? ref.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close.current();
        return;
      }
      const root = ref.current;
      if (e.key !== "Tab" || !root) return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const at = document.activeElement;
      if (e.shiftKey && (at === first || !root.contains(at))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || !root.contains(at))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, [open, ref]);
}

export type ConfirmAsk = {
  /** The action as its button names it ("Cancel run"): the dialog's title and its confirm button. */
  action: string;
  /** The question, word for word. */
  message: string;
};

type Pending = ConfirmAsk & { resolve: (yes: boolean) => void };

/** The mounted host's way in (one per app: the shell mounts it). */
let show: ((ask: Pending) => void) | null = null;

/**
 * Asks before an action, in the page: the app's own dialog, never `window.confirm`, which
 * blocks the tab (UI test finding E5, 2026-10-20). Resolves true on the action's button;
 * false on Back, Escape or a click outside the dialog, as Cancel on a browser dialog.
 */
export function confirmInPage(ask: ConfirmAsk): Promise<boolean> {
  return new Promise((resolve) => {
    if (show) show({ ...ask, resolve });
    else resolve(false);
  });
}

/** Draws what `confirmInPage` asks, one question at a time (a new one answers the last no). */
export function ConfirmHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  const current = useRef<Pending | null>(null);
  useEffect(() => {
    show = (ask) => {
      current.current?.resolve(false);
      current.current = ask;
      setPending(ask);
    };
    return () => {
      show = null;
      current.current?.resolve(false);
      current.current = null;
    };
  }, []);
  const answer = useCallback((yes: boolean) => {
    const asked = current.current;
    current.current = null;
    setPending(null);
    asked?.resolve(yes);
  }, []);
  return pending ? <ConfirmDialog key={pending.action + pending.message} ask={pending} onAnswer={answer} /> : null;
}

function ConfirmDialog({ ask, onAnswer }: { ask: ConfirmAsk; onAnswer: (yes: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const title = useId();
  const body = useId();
  useFocusTrap(ref, true, () => onAnswer(false));
  return (
    <div
      data-testid="confirm-scrim"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-hero/50 px-4 py-10 max-[600px]:px-2 max-[600px]:py-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onAnswer(false);
      }}
    >
      <div
        ref={ref}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={title}
        aria-describedby={body}
        tabIndex={-1}
        className="w-full max-w-md min-w-0 rounded-inspector border border-line bg-surface text-text shadow-tip outline-none"
      >
        <div className="flex min-h-14 items-center border-b border-line px-5 max-[600px]:px-4">
          <h2 id={title} className="font-display text-lg font-bold tracking-heading">
            {ask.action}
          </h2>
        </div>
        <p id={body} className="px-5 py-3.5 text-[15px] leading-6 max-[600px]:px-4">
          {ask.message}
        </p>
        <div className="flex justify-end gap-2 border-t border-line px-5 py-3 max-[600px]:px-4">
          <Button variant="ghost" onClick={() => onAnswer(false)}>
            Back
          </Button>
          <Button variant="primary" data-autofocus onClick={() => onAnswer(true)}>
            {ask.action}
          </Button>
        </div>
      </div>
    </div>
  );
}
