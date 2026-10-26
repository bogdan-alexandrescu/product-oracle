"use client";

import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";

import { Button } from "./Button";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Makes everything outside `root` inert (each sibling of `root` and of its ancestors up to
 * the body). Returns the undo, which clears only what it set: a dialog opened from another
 * keeps that one's background inert.
 */
function inertOutside(root: HTMLElement): () => void {
  const set: HTMLElement[] = [];
  for (let at: HTMLElement | null = root; at && at !== document.body; at = at.parentElement) {
    for (const sib of at.parentElement?.children ?? []) {
      if (sib === at || !(sib instanceof HTMLElement) || sib.inert) continue;
      sib.inert = true;
      set.push(sib);
    }
  }
  return () => set.forEach((el) => (el.inert = false));
}

/**
 * While `open`: the page behind the dialog is inert (no clicks, hidden from assistive
 * technology), focus moves to the `[data-autofocus]` element (else the dialog), Tab and
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
    // Its ancestors, the scrim among them (a click on it closes the dialog), stay live.
    const restore = ref.current ? inertOutside(ref.current) : () => {};
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
      // Live again first: an inert opener cannot take the focus back.
      restore();
      if (opener?.isConnected) opener.focus();
    };
  }, [open, ref]);
}

export type ConfirmAsk = {
  /** The action as its button names it ("Cancel run"): the dialog's title and its confirm button. */
  action: string;
  /** The question, word for word. */
  message: string;
  /** Cancels or deletes something: Back has the focus (Enter does not confirm) and the action is drawn as danger. */
  destructive?: boolean;
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
          <Button variant="ghost" data-autofocus={ask.destructive ? true : undefined} onClick={() => onAnswer(false)}>
            Back
          </Button>
          <Button
            variant={ask.destructive ? "danger" : "primary"}
            data-autofocus={ask.destructive ? undefined : true}
            onClick={() => onAnswer(true)}
          >
            {ask.action}
          </Button>
        </div>
      </div>
    </div>
  );
}
