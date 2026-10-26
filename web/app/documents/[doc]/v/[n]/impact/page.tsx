import { Suspense } from "react";

import { ImpactExplorer } from "@/app/impact/_explorer";
import { Loading } from "@/components/ui";
import type { RouteProps } from "@/lib/route-props";

async function Explorer({ params }: { params: RouteProps<{ doc: string; n: string }>["params"] }) {
  const { doc, n } = await params;
  return <ImpactExplorer key={`${doc}/${n}`} source={{ kind: "version", doc, n: Number(n) }} />;
}

/** v2 screen 2: what a PRD version changes for the outputs built on earlier versions (a preview). */
export default function VersionImpactPage({ params }: RouteProps<{ doc: string; n: string }>) {
  return (
    <Suspense fallback={<div className="px-6 py-8"><Loading /></div>}>
      <Explorer params={params} />
    </Suspense>
  );
}
