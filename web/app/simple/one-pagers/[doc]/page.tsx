import { Suspense } from "react";

import type { RouteProps } from "@/lib/route-props";

import { OnePager } from "./_one-pager";
import { PageSkeleton } from "@/components/ds";

async function Doc({ params }: { params: RouteProps<{ doc: string }>["params"] }) {
  const { doc } = await params;
  return <OnePager slug={doc} />;
}

export default function OnePagerPage({ params }: RouteProps<{ doc: string }>) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Doc params={params} />
    </Suspense>
  );
}
