import { Suspense } from "react";

import { VersionView } from "@/components/VersionView";
import { Loading } from "@/components/ui";
import type { RouteProps } from "@/lib/route-props";

async function Version({ params }: { params: RouteProps<{ doc: string; n: string }>["params"] }) {
  const { doc, n } = await params;
  return <VersionView key={`${doc}/${n}`} doc={doc} n={Number(n)} />;
}

export default function VersionPage({ params }: RouteProps<{ doc: string; n: string }>) {
  return (
    <Suspense fallback={<div className="px-6 py-8"><Loading /></div>}>
      <Version params={params} />
    </Suspense>
  );
}
