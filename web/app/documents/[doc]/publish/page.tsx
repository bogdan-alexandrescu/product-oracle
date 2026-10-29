import { Suspense } from "react";

import { PublishView } from "@/components/PublishView";
import type { RouteProps } from "@/lib/route-props";
import { PageSkeleton } from "@/components/ds";

async function Publish({ params }: { params: RouteProps<{ doc: string }>["params"] }) {
  const { doc } = await params;
  return <PublishView key={doc} doc={doc} />;
}

export default function PublishPage({ params }: RouteProps<{ doc: string }>) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Publish params={params} />
    </Suspense>
  );
}
