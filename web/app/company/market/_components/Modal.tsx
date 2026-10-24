"use client";

import { useRef, type ReactNode } from "react";

import { useFocusTrap } from "@/components/ds";

/** A Market dialog: the same frame as New update (H8), titled, Escape closes it. */
export function Modal({ id, title, testId, onClose, children }: { id: string; title: string; testId: string; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  useFocusTrap(panel, true, onClose);
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
        {children}
      </div>
    </div>
  );
}
