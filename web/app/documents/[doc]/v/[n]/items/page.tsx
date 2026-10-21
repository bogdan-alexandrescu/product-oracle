import { Suspense } from "react";

import { VersionView } from "@/components/VersionView";
import { Loading } from "@/components/ui";
import type { RouteProps } from "@/lib/route-props";

/** A roadmap version's Items tab (E2); a PRD version's /items opens the version itself. */
async function Items({ params }: { params: RouteProps<{ doc: string; n: string }>["params"] }) {
  const { doc, n } = await params;
  return <VersionView key={`${doc}/${n}/items`} doc={doc} n={Number(n)} pane="items" />;
}

export default function VersionItemsPage({ params }: RouteProps<{ doc: string; n: string }>) {
  return (
    <Suspense fallback={<div className="px-6 py-8"><Loading /></div>}>
      <Items params={params} />
    </Suspense>
  );
}
