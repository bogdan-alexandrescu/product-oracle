import { Suspense } from "react";

import { VersionView } from "@/components/VersionView";
import type { RouteProps } from "@/lib/route-props";
import { PageSkeleton } from "@/components/ds";

/** A roadmap version's Items tab (E2); a PRD version's /items opens the version itself. */
async function Items({ params }: { params: RouteProps<{ doc: string; n: string }>["params"] }) {
  const { doc, n } = await params;
  return <VersionView key={`${doc}/${n}/items`} doc={doc} n={Number(n)} pane="items" />;
}

export default function VersionItemsPage({ params }: RouteProps<{ doc: string; n: string }>) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Items params={params} />
    </Suspense>
  );
}
