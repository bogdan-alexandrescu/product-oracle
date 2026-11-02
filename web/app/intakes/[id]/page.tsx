import { Suspense } from "react";

import type { RouteProps } from "@/lib/route-props";

import { BeforeDrafting } from "./_shell";
import { PageSkeleton } from "@/components/ds";

async function Shell({ params }: { params: RouteProps<{ id: string }>["params"] }) {
  const { id } = await params;
  // Keyed by the brief: a kept page never shows the previous brief's counts under this one (walk-brief).
  return <BeforeDrafting key={id} id={id} />;
}

/** Before drafting (C5): Oracle's questions about a brief, and whether it is ready to draft. */
export default function IntakePage({ params }: RouteProps<{ id: string }>) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Shell params={params} />
    </Suspense>
  );
}
