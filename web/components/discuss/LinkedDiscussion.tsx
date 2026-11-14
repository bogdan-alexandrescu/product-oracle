"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useSyncExternalStore } from "react";

import { Sheet } from "@/components/ds";
import { askThread, usePanelOpen } from "@/components/hop/open-state";

import { DiscussionThread } from "./DiscussionThread";

/**
 * G5/G6: a discussion link (`?discussion=<id>`, the Inbox's and the run's agents') opens its
 * thread on the subject's page; `&changes=1` (the Inbox's Review changes) scrolls to its
 * changes card. A run's page, the Ground Truth, a brief, the plan and the priorities mount it
 * (the API's changes.THREAD_PAGES); a document's version opens its own panel.
 * ask-phone-12: from md up it opens in the right Ask panel, the one place for threads (closing
 * the panel clears the link); a phone keeps the bottom sheet.
 */
export function LinkedDiscussion({ testId = "linked-discussion-sheet" }: { testId?: string }) {
  return (
    <Suspense fallback={null}>
      <Linked testId={testId} />
    </Suspense>
  );
}

const WIDE = "(min-width: 768px)";
const subscribeWide = (l: () => void) => {
  const m = window.matchMedia(WIDE);
  m.addEventListener("change", l);
  return () => m.removeEventListener("change", l);
};
/** md and up; null before the window is known, so neither the sheet nor the panel flashes. */
const useWide = () => useSyncExternalStore<boolean | null>(subscribeWide, () => window.matchMedia(WIDE).matches, () => null);

function Linked({ testId }: { testId: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const id = params.get("discussion");
  const changes = params.get("changes") === "1";
  const wide = useWide();
  // Simple's Ask panel holds Simple's own chats: a linked thread there keeps the sheet.
  const inPanel = !!wide && !path.startsWith("/simple");
  const open = usePanelOpen();
  const shown = useRef(false);
  const close = () => {
    const rest = new URLSearchParams(params.toString());
    rest.delete("discussion");
    rest.delete("changes");
    router.replace(rest.size ? `${path}?${rest}` : path, { scroll: false });
  };
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });
  useEffect(() => {
    if (inPanel && id) askThread({ id, changes });
  }, [inPanel, id, changes]);
  useEffect(() => {
    if (!inPanel || !id) return;
    if (open) shown.current = true;
    else if (shown.current) {
      shown.current = false;
      closeRef.current();
    }
  }, [inPanel, id, open]);
  if (!id || wide === null || inPanel) return null;
  return (
    <Sheet open title="Discussion" onClose={close} testId={testId}>
      <div className="p-4">
        <DiscussionThread key={id} id={id} focusChanges={changes} />
      </div>
    </Sheet>
  );
}
