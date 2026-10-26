import { Suspense } from "react";

import { QualityView } from "@/components/QualityView";
import { Loading } from "@/components/ui";
import type { RouteProps } from "@/lib/route-props";

/** v2 screen 5: the quality evaluation of a PRD version (criteria, ratings, History). */
async function Quality({ params }: { params: RouteProps<{ doc: string; n: string }>["params"] }) {
  const { doc, n } = await params;
  return <QualityView key={`${doc}/${n}`} doc={doc} n={Number(n)} />;
}

export default function VersionQualityPage({ params }: RouteProps<{ doc: string; n: string }>) {
  return (
    <Suspense fallback={<div className="px-6 py-8"><Loading /></div>}>
      <Quality params={params} />
    </Suspense>
  );
}
