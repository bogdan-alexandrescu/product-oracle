"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Button } from "./Button";
import { useFocusTrap } from "./ConfirmDialog";
import { Icon } from "./Icon";

const FIELD = "input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled])";
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const SIZE = { md: "max-w-xl", lg: "max-w-3xl" } as const;

/**
 * The app's one modal dialog (qa-plan-29): a dimmed backdrop, a head row with the title and
 * a close X, the body, and a footer with Cancel (a bordered secondary button) before the
 * dialog's own actions. Focus moves to the first field (else the first control) on open,
 * Tab stays inside, and focus returns to what opened it on close.
 *
 * Escape, the X and a click on the backdrop close it; while `dirty` (the person typed
 * something) they first ask "Discard your changes?" inside the dialog, with Keep editing
 * and Discard. Cancel always closes: it is the explicit choice. While `busy` (saving) none
 * of them closes it, and Cancel and the X are disabled.
 *
 * With `onSubmit` the body and footer are one form, so Enter in a field submits it; give
 * the primary action `type="submit"`.
 */
export function Dialog({
  title,
  onClose,
  dirty = false,
  askOnCancel = false,
  testId,
  head,
  actions,
  cancelLabel = "Cancel",
  busy = false,
  onSubmit,
  size = "md",
  phoneSheet = false,
  scrollBody = false,
  closeButton = true,
  children,
}: {
  title: string;
  onClose: () => void;
  /** The person changed something: closing (bar Cancel) asks before it throws it away. */
  dirty?: boolean;
  /** Cancel asks too while `dirty` (a dialog whose typed work is all it holds, qa-onboarding-1). */
  askOnCancel?: boolean;
  testId?: string;
  /** Under the title, inside the head row's block (the PRD a dialog is about). */
  head?: ReactNode;
  /** The footer's actions after Cancel, the primary one last; none: no footer. */
  actions?: ReactNode;
  cancelLabel?: string;
  /** Saving: closing waits until it is done. */
  busy?: boolean;
  onSubmit?: () => void;
  size?: keyof typeof SIZE;
  /** On a phone the dialog fills the screen (a full-height sheet, #329 rule 5). */
  phoneSheet?: boolean;
  /**
   * fix4 qa-plan-24: the dialog is at most the window's height, its head and footer pinned and
   * the body scrolling between them (a tall form whose actions must stay in view). Opt-in: a
   * scrolling body clips popovers opened inside it.
   */
  scrollBody?: boolean;
  /** false: no close X in the head row; Cancel, Escape and the backdrop close it (qa-company-24). */
  closeButton?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [asking, setAsking] = useState(false);
  /** Where focus was when the question opened: Keep editing puts it back. */
  const before = useRef<HTMLElement | null>(null);

  const state = useRef({ dirty, asking, busy, onClose });
  useEffect(() => {
    state.current = { dirty, asking, busy, onClose };
  });

  const keepEditing = () => {
    setAsking(false);
    const back = before.current;
    const refocus = () => (back?.isConnected ? back : panel.current)?.focus();
    // Focus goes back at once (the pressed Keep editing button is about to go, which would
    // leave focus on the page for a frame, where a sheet under the dialog takes the next
    // Escape), and again after the question has gone.
    refocus();
    requestAnimationFrame(refocus);
  };
  /** Escape, the X or the backdrop: asks first while there are changes. */
  const requestClose = () => {
    const s = state.current;
    if (s.busy) return;
    if (s.asking) return keepEditing();
    if (!s.dirty) return s.onClose();
    before.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setAsking(true);
  };

  useFocusTrap(panel, true, requestClose);

  // The first field takes focus (useFocusTrap has focused [data-autofocus] or the dialog).
  useEffect(() => {
    const p = panel.current;
    if (!p || p.querySelector("[data-autofocus]")) return;
    const visible = (el: HTMLElement) => el.checkVisibility();
    const body = p.querySelector<HTMLElement>("[data-dialog-body]");
    const first =
      [...(body?.querySelectorAll<HTMLElement>(FIELD) ?? [])].find(visible) ??
      [...(body?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].find(visible) ??
      [...p.querySelectorAll<HTMLElement>(FOCUSABLE)].find(visible);
    first?.focus();
  }, []);

  useEffect(() => {
    if (asking) panel.current?.querySelector<HTMLElement>("[data-keep-editing]")?.focus();
  }, [asking]);

  const titleId = `${id}-title`;
  const footer =
    actions !== undefined ? (
      <div className={`flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3 max-[600px]:px-4 ${scrollBody ? "flex-none" : ""}`} data-testid="dialog-footer">
        <Button variant="secondary" onClick={askOnCancel ? requestClose : onClose} disabled={busy}>
          {cancelLabel}
        </Button>
        {actions}
      </div>
    ) : null;
  const body = (
    <div data-dialog-body className={`space-y-4 px-5 py-4 text-[15px] max-[600px]:px-4 ${scrollBody ? "min-h-0 flex-1 overflow-y-auto" : ""}`}>
      {children}
    </div>
  );

  return createPortal(
    // A portal still bubbles React events to the opener's row: keep clicks and keys (bar
    // Escape and Tab, which the dialog handles) from selecting or moving rows underneath.
    // qa-plan-36: z-[45] puts the backdrop over the phone tab bar and the rail (z-40) whatever
    // the DOM order, so a tap there cannot leave the page and drop a draft; a ConfirmDialog or
    // a Sheet (z-50) still sits above it.
    <div
      data-testid="dialog-backdrop"
      className={`fixed inset-0 z-[45] flex items-start justify-center overflow-y-auto bg-hero/50 px-4 py-10 ${phoneSheet ? "max-[600px]:p-0" : "max-[600px]:px-2 max-[600px]:py-4"}`}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.key !== "Escape" && e.key !== "Tab" && e.stopPropagation()}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid={testId}
        className={`w-full ${SIZE[size]} min-w-0 rounded-inspector border border-line bg-surface text-text shadow-tip outline-none ${phoneSheet ? "max-[600px]:min-h-full max-[600px]:max-w-none max-[600px]:rounded-none max-[600px]:border-0" : ""} ${
          scrollBody ? `flex max-h-[calc(100dvh-5rem)] flex-col ${phoneSheet ? "max-[600px]:max-h-dvh" : "max-[600px]:max-h-[calc(100dvh-2rem)]"}` : ""
        }`}
      >
        <div className="flex min-h-14 flex-none items-start gap-3 border-b border-line py-3 pr-3 pl-5 max-[600px]:pl-4">
          <div className="min-w-0 flex-1 self-center">
            <h2 id={titleId} className="font-display text-xl font-bold tracking-heading">
              {title}
            </h2>
            {head}
          </div>
          {closeButton && (
            <button
              type="button"
              onClick={requestClose}
              disabled={busy}
              aria-label="Close"
              className="grid size-8 flex-none place-items-center rounded-lg text-text2 hover:bg-surface2 hover:text-text disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
            >
              <Icon name="x" size={20} />
            </button>
          )}
        </div>
        {asking && (
          <div
            role="alert"
            data-testid="dialog-discard"
            className="flex flex-wrap items-center gap-2 border-b border-line bg-warn-bg px-5 py-3 text-warn max-[600px]:px-4"
          >
            <span className="min-w-0 flex-1 font-semibold">Discard your changes?</span>
            <Button variant="secondary" data-keep-editing="" onClick={keepEditing}>
              Keep editing
            </Button>
            <Button variant="danger" onClick={onClose}>
              Discard
            </Button>
          </div>
        )}
        {onSubmit ? (
          <form
            noValidate
            className={scrollBody ? "flex min-h-0 flex-1 flex-col" : undefined}
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              onSubmit();
            }}
          >
            {body}
            {footer}
          </form>
        ) : (
          <>
            {body}
            {footer}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
