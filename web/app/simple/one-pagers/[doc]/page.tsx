import { Suspense } from "react";

import { Loading } from "@/components/ui";
import type { RouteProps } from "@/lib/route-props";

import { OnePager } from "./_one-pager";

async function Doc({ params }: { params: RouteProps<{ doc: string }>["params"] }) {
  const { doc } = await params;
  return <OnePager slug={doc} />;
}

export default function OnePagerPage({ params }: RouteProps<{ doc: string }>) {
  return (
    <Suspense fallback={<div className="px-6 py-8"><Loading /></div>}>
      <Doc params={params} />
    </Suspense>
  );
}
