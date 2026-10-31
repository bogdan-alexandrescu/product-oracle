"use client";

import { useEffect, useState } from "react";

/**
 * e2e-pdf-export: what a download says ("PDF downloaded", and its pages past one), shown a few
 * seconds, then gone (qa-simple-prd-25). Shared by Detailed's Export and the one-pager's.
 */
export function useDownloadNote(): [string | null, (note: string | null) => void] {
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!note) return;
    const t = window.setTimeout(() => setNote(null), 4000);
    return () => window.clearTimeout(t);
  }, [note]);
  return [note, setNote];
}

/** The note, bottom right; `className` adds to it (the one-pager's simple-noprint). */
export function DownloadNote({ note, className = "" }: { note: string | null; className?: string }) {
  if (!note) return null;
  return (
    <p role="status" className={`${className} fixed right-4 bottom-4 z-50 rounded-[10px] border border-line-strong bg-surface px-4 py-2 text-[15px] font-semibold shadow-md`.trim()}>
      {note}
    </p>
  );
}
