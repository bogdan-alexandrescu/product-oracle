import { Suspense } from "react";

import type { RouteProps } from "@/lib/route-props";

import { BeforeDrafting } from "./_shell";
import { PageSkeleton } from "@/components/ds";

async function Shell({ params }: { params: RouteProps<{ id: string }>["params"] }) {
  const { id } = await params;
  return <BeforeDrafting id={id} />;
}

/** Before drafting (C5): Oracle's questions about a brief, and whether it is ready to draft. */
export default function IntakePage({ params }: RouteProps<{ id: string }>) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Shell params={params} />
    </Suspense>
  );
}
