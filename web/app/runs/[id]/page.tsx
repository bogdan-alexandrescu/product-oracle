import { Suspense } from "react";

import { Loading } from "@/components/ui";

import { RunDetail } from "../_run-detail";
import type { RouteProps } from "@/lib/route-props";

async function Detail({ params }: { params: RouteProps<{ id: string }>["params"] }) {
  const { id } = await params;
  return <RunDetail id={id} />;
}

export default function RunPage({ params }: RouteProps<{ id: string }>) {
  return (
    <Suspense fallback={<div className="px-6 py-8"><Loading /></div>}>
      <Detail params={params} />
    </Suspense>
  );
}
