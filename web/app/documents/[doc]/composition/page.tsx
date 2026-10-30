import { Suspense } from "react";

import type { RouteProps } from "@/lib/route-props";

import { CompositionView } from "./_view";
import { PageSkeleton } from "@/components/ds";

async function Composition({ params }: { params: RouteProps<{ doc: string }>["params"] }) {
  const { doc } = await params;
  return <CompositionView key={doc} doc={doc} />;
}

export default function CompositionPage({ params }: RouteProps<{ doc: string }>) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Composition params={params} />
    </Suspense>
  );
}
