import { Suspense } from "react";

import { DocumentOverview } from "@/components/DocumentOverview";
import type { RouteProps } from "@/lib/route-props";
import { PageSkeleton } from "@/components/ds";

async function Overview({ params }: { params: RouteProps<{ doc: string }>["params"] }) {
  const { doc } = await params;
  return <DocumentOverview doc={doc} />;
}

export default function DocumentPage({ params }: RouteProps<{ doc: string }>) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Overview params={params} />
    </Suspense>
  );
}
