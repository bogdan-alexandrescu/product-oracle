"use client";

import { useRef, type FormEvent, type ReactNode } from "react";

import { Button, useFocusTrap } from "@/components/ds";
import { ErrorNote } from "@/components/ui";

/** Who may plan launches and add tasks, notes and changelog entries (POST needs the approver role). */
export const APPROVERS_ONLY = "Approvers plan launches and add tasks, notes and changelog entries";

/**
 * A modal form for the launches and changelog screens (the New update dialog's shape): a
 * title, the fields, an error and Cancel beside the submit. Escape and Cancel close it.
 */
export function FormDialog({
  title,
  testId,
  submit,
  submitLabel,
  canSubmit,
  busy,
  error,
  onSubmit,
  onClose,
  children,
}: {
  title: string;
  testId: string;
  submit?: string;
  submitLabel: string;
  canSubmit: boolean;
  busy: boolean;
  error: string | null;
  onSubmit: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useFocusTrap(panel, true, onClose);
  const id = `${testId}-title`;
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-hero/50 px-4 py-10 max-[600px]:px-2 max-[600px]:py-4">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
        data-testid={testId}
        className="w-full max-w-xl min-w-0 rounded-inspector border border-line bg-surface text-text shadow-tip outline-none"
      >
        <div className="flex min-h-14 items-center gap-2 border-b border-line px-5 max-[600px]:px-4">
          <h2 id={id} className="font-display text-xl font-bold tracking-heading">
            {title}
          </h2>
        </div>
        <form
          className="flex flex-col gap-4 px-5 py-4 max-[600px]:px-4"
          noValidate
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (canSubmit && !busy) onSubmit();
          }}
        >
          {children}
          {error && <ErrorNote>{error}</ErrorNote>}
          <div className="flex justify-end gap-2 border-t border-line pt-3">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !canSubmit}>
              {busy && submit ? submit : submitLabel}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
