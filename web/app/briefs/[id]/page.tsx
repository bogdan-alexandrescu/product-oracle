import { Suspense } from "react";

import { BriefDetail } from "../_brief-detail";
import { PageSkeleton } from "@/components/ds";

/** Spelled out rather than Next's generated PageProps, so tsc passes without a build first. */
type Params = { params: Promise<{ id: string }> };

async function Detail({ params }: Params) {
  const { id } = await params;
  return <BriefDetail id={id} />;
}

export default function BriefPage({ params }: Params) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Detail params={params} />
    </Suspense>
  );
}
