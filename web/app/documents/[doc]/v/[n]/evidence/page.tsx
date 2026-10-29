import { Suspense } from "react";

import { VersionView } from "@/components/VersionView";
import type { RouteProps } from "@/lib/route-props";
import { PageSkeleton } from "@/components/ds";

/** A PRD version's Evidence tab (v2 screen 3: the evidence inspector). */
async function Evidence({ params }: { params: RouteProps<{ doc: string; n: string }>["params"] }) {
  const { doc, n } = await params;
  return <VersionView key={`${doc}/${n}/evidence`} doc={doc} n={Number(n)} pane="evidence" />;
}

export default function VersionEvidencePage({ params }: RouteProps<{ doc: string; n: string }>) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Evidence params={params} />
    </Suspense>
  );
}
