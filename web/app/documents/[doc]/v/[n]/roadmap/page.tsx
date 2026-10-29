import { Suspense } from "react";

import { VersionView } from "@/components/VersionView";
import type { RouteProps } from "@/lib/route-props";
import { PageSkeleton } from "@/components/ds";

/** A PRD version's Roadmap tab (E1); a roadmap version's /roadmap opens its Items tab. */
async function Roadmap({ params }: { params: RouteProps<{ doc: string; n: string }>["params"] }) {
  const { doc, n } = await params;
  return <VersionView key={`${doc}/${n}/roadmap`} doc={doc} n={Number(n)} pane="roadmap" />;
}

export default function VersionRoadmapPage({ params }: RouteProps<{ doc: string; n: string }>) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Roadmap params={params} />
    </Suspense>
  );
}
