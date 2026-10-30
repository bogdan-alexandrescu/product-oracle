import { Suspense } from "react";

import { ImpactExplorer } from "@/app/impact/_explorer";
import type { RouteProps } from "@/lib/route-props";
import { PageSkeleton } from "@/components/ds";

async function Explorer({ params }: { params: RouteProps<{ id: string }>["params"] }) {
  const { id } = await params;
  return <ImpactExplorer key={id} source={{ kind: "change", id }} />;
}

/** v2 screen 2: the outputs a recorded change marked Potentially stale. */
export default function ChangeImpactPage({ params }: RouteProps<{ id: string }>) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Explorer params={params} />
    </Suspense>
  );
}
