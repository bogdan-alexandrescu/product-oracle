"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { Sheet } from "@/components/ds";

import { DiscussionThread } from "./DiscussionThread";

/**
 * G5/G6: a discussion link (`?discussion=<id>`, the Inbox's and the run's agents') opens its
 * thread in a sheet on the subject's page; `&changes=1` (the Inbox's Review changes) scrolls
 * to its changes card. A run's page, the Ground Truth, a brief, the plan and the priorities
 * mount it (the API's changes.THREAD_PAGES); a document's version opens its own panel.
 */
export function LinkedDiscussion({ testId = "linked-discussion-sheet" }: { testId?: string }) {
  return (
    <Suspense fallback={null}>
      <Linked testId={testId} />
    </Suspense>
  );
}

function Linked({ testId }: { testId: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const id = params.get("discussion");
  if (!id) return null;
  const close = () => {
    const rest = new URLSearchParams(params.toString());
    rest.delete("discussion");
    rest.delete("changes");
    router.replace(rest.size ? `${path}?${rest}` : path, { scroll: false });
  };
  return (
    <Sheet open title="Discussion" onClose={close} testId={testId}>
      <div className="p-4">
        <DiscussionThread key={id} id={id} focusChanges={params.get("changes") === "1"} />
      </div>
    </Sheet>
  );
}
