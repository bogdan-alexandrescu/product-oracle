"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

import { Button, Icon, type IconName, Notice } from "@/components/ds";

export type Consequence = { icon?: IconName; text: ReactNode };

/**
 * The in-app confirm for a destructive action (never window.confirm): a modal <dialog>
 * that names the action and lists what happens, one short line each (I3: no prose).
 * Escape and Cancel close it; the confirm button shows progress and an error stays in
 * the dialog so the person can retry or cancel.
 */
export function ConfirmDialog({
  open,
  title,
  subject,
  consequences,
  confirmLabel,
  pendingLabel,
  pending = false,
  error,
  onConfirm,
  onClose,
  testId,
}: {
  open: boolean;
  title: string;
  /** What it acts on, under the title: an email, a token's name. */
  subject?: ReactNode;
  consequences: Consequence[];
  confirmLabel: string;
  pendingLabel?: string;
  pending?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
  testId?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      data-testid={testId}
      onCancel={(e) => {
        e.preventDefault();
        if (!pending) onClose();
      }}
      className="m-auto w-[min(460px,calc(100vw-24px))] rounded-panel border border-line bg-surface p-0 text-text shadow-tip backdrop:bg-[rgba(6,16,30,0.55)]"
    >
      {open && (
        <div className="flex flex-col gap-4 p-5">
          <div className="flex items-start gap-3">
            <span aria-hidden className="grid size-10 flex-none place-items-center rounded-full bg-crit-bg text-crit">
              <Icon name="alert" size={20} />
            </span>
            <div className="min-w-0">
              <h2 id={titleId} className="font-display text-lg leading-6 font-bold tracking-heading">
                {title}
              </h2>
              {subject && <p className="mt-0.5 truncate text-[15px] font-medium text-text2">{subject}</p>}
            </div>
          </div>
          <ul aria-label="What happens" className="flex flex-col gap-2 text-[15px] leading-[22px]">
            {consequences.map((c, i) => (
              <li key={i} className="flex items-start gap-2.5">
                <span aria-hidden className="mt-0.5 flex-none text-text2">
                  <Icon name={c.icon ?? "check"} size={16} />
                </span>
                <span className="min-w-0">{c.text}</span>
              </li>
            ))}
          </ul>
          {error && <Notice tone="error">{error}</Notice>}
          <div className="flex flex-wrap justify-end gap-2">
            {/* The safe choice has focus, so Enter never confirms by accident. */}
            <Button variant="secondary" autoFocus disabled={pending} onClick={onClose}>
              Cancel
            </Button>
            <Button variant="danger" disabled={pending} onClick={onConfirm} data-testid="confirm-action">
              {pending ? (pendingLabel ?? `${confirmLabel}…`) : confirmLabel}
            </Button>
          </div>
        </div>
      )}
    </dialog>
  );
}
