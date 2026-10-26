import { Suspense } from "react";

import { ImpactExplorer } from "@/app/impact/_explorer";
import { Loading } from "@/components/ui";
import type { RouteProps } from "@/lib/route-props";

async function Explorer({ params }: { params: RouteProps<{ id: string }>["params"] }) {
  const { id } = await params;
  return <ImpactExplorer key={id} source={{ kind: "entity", id }} />;
}

/** v2 screen 2: what-if from a baseline item: the outputs built on it (a preview). */
export default function EntityImpactPage({ params }: RouteProps<{ id: string }>) {
  return (
    <Suspense fallback={<div className="px-6 py-8"><Loading /></div>}>
      <Explorer params={params} />
    </Suspense>
  );
}
