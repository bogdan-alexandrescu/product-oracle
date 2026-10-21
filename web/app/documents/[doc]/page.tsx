import { Suspense } from "react";

import { DocumentOverview } from "@/components/DocumentOverview";
import { Loading } from "@/components/ui";
import type { RouteProps } from "@/lib/route-props";

async function Overview({ params }: { params: RouteProps<{ doc: string }>["params"] }) {
  const { doc } = await params;
  return <DocumentOverview doc={doc} />;
}

export default function DocumentPage({ params }: RouteProps<{ doc: string }>) {
  return (
    <Suspense fallback={<div className="px-6 py-8"><Loading /></div>}>
      <Overview params={params} />
    </Suspense>
  );
}
