import { Suspense } from "react";


import { RunDetail } from "../_run-detail";
import type { RouteProps } from "@/lib/route-props";
import { PageSkeleton } from "@/components/ds";

async function Detail({ params }: { params: RouteProps<{ id: string }>["params"] }) {
  const { id } = await params;
  return <RunDetail id={id} />;
}

export default function RunPage({ params }: RouteProps<{ id: string }>) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Detail params={params} />
    </Suspense>
  );
}
