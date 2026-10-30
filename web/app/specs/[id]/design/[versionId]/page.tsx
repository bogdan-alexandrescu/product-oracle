import { Suspense } from "react";

import { DesignReview } from "@/components/DesignReview";
import { PageSkeleton } from "@/components/ds";

/** Spelled out rather than Next's generated PageProps, so tsc passes without a build first. */
type Params = { params: Promise<{ id: string; versionId: string }> };

async function Detail({ params }: Params) {
  const { id, versionId } = await params;
  return <DesignReview specId={id} versionId={versionId} />;
}

/** v2 screen 4: a spec's user flow or wireframes, and their review. */
export default function DesignArtifactPage({ params }: Params) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Detail params={params} />
    </Suspense>
  );
}
