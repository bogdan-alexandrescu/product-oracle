import { Suspense } from "react";

import { Loading } from "@/components/ui";
import type { RouteProps } from "@/lib/route-props";

import { CompositionView } from "./_view";

async function Composition({ params }: { params: RouteProps<{ doc: string }>["params"] }) {
  const { doc } = await params;
  return <CompositionView key={doc} doc={doc} />;
}

export default function CompositionPage({ params }: RouteProps<{ doc: string }>) {
  return (
    <Suspense fallback={<div className="px-6 py-8"><Loading /></div>}>
      <Composition params={params} />
    </Suspense>
  );
}
