import { Suspense } from "react";

import { PublishView } from "@/components/PublishView";
import { Loading } from "@/components/ui";
import type { RouteProps } from "@/lib/route-props";

async function Publish({ params }: { params: RouteProps<{ doc: string }>["params"] }) {
  const { doc } = await params;
  return <PublishView key={doc} doc={doc} />;
}

export default function PublishPage({ params }: RouteProps<{ doc: string }>) {
  return (
    <Suspense fallback={<div className="px-6 py-8"><Loading /></div>}>
      <Publish params={params} />
    </Suspense>
  );
}
