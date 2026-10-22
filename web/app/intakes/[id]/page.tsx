import { Suspense } from "react";

import { Loading } from "@/components/ui";
import type { RouteProps } from "@/lib/route-props";

import { BeforeDrafting } from "./_shell";

async function Shell({ params }: { params: RouteProps<{ id: string }>["params"] }) {
  const { id } = await params;
  return <BeforeDrafting id={id} />;
}

/** Before drafting (C5): Oracle's questions about a brief, and whether it is ready to draft. */
export default function IntakePage({ params }: RouteProps<{ id: string }>) {
  return (
    <Suspense fallback={<div className="px-6 py-8"><Loading /></div>}>
      <Shell params={params} />
    </Suspense>
  );
}
