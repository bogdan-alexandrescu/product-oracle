import { Suspense } from "react";

import { VersionView } from "@/components/VersionView";
import type { RouteProps } from "@/lib/route-props";
import { PageSkeleton } from "@/components/ds";

async function Version({ params }: { params: RouteProps<{ doc: string; n: string }>["params"] }) {
  const { doc, n } = await params;
  return <VersionView key={`${doc}/${n}`} doc={doc} n={Number(n)} />;
}

export default function VersionPage({ params }: RouteProps<{ doc: string; n: string }>) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Version params={params} />
    </Suspense>
  );
}
