import { Suspense } from "react";

import { ImpactExplorer } from "@/app/impact/_explorer";
import type { RouteProps } from "@/lib/route-props";
import { PageSkeleton } from "@/components/ds";

async function Explorer({ params }: { params: RouteProps<{ id: string }>["params"] }) {
  const { id } = await params;
  return <ImpactExplorer key={id} source={{ kind: "entity", id }} />;
}

/** v2 screen 2: what-if from a baseline item: the outputs built on it (a preview). */
export default function EntityImpactPage({ params }: RouteProps<{ id: string }>) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Explorer params={params} />
    </Suspense>
  );
}
