import { Suspense } from "react";

import { Loading } from "@/components/ui";

import { BriefDetail } from "../_brief-detail";

/** Spelled out rather than Next's generated PageProps, so tsc passes without a build first. */
type Params = { params: Promise<{ id: string }> };

async function Detail({ params }: Params) {
  const { id } = await params;
  return <BriefDetail id={id} />;
}

export default function BriefPage({ params }: Params) {
  return (
    <Suspense fallback={<div className="px-6 py-8"><Loading /></div>}>
      <Detail params={params} />
    </Suspense>
  );
}
