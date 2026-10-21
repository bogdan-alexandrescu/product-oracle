import { Suspense } from "react";

import { VersionView } from "@/components/VersionView";
import { Loading } from "@/components/ui";

/** A roadmap version's Items tab (E2); a PRD version's /items opens the version itself. */
async function Items({ params }: { params: PageProps<"/documents/[doc]/v/[n]/items">["params"] }) {
  const { doc, n } = await params;
  return <VersionView key={`${doc}/${n}/items`} doc={doc} n={Number(n)} pane="items" />;
}

export default function VersionItemsPage({ params }: PageProps<"/documents/[doc]/v/[n]/items">) {
  return (
    <Suspense fallback={<div className="px-6 py-8"><Loading /></div>}>
      <Items params={params} />
    </Suspense>
  );
}
