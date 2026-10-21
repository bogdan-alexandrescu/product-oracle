import { Suspense } from "react";

import { VersionView } from "@/components/VersionView";
import { Loading } from "@/components/ui";
import type { PageProps } from "@/lib/route-props";

async function Version({ params }: { params: PageProps<"/documents/[doc]/v/[n]">["params"] }) {
  const { doc, n } = await params;
  return <VersionView key={`${doc}/${n}`} doc={doc} n={Number(n)} />;
}

export default function VersionPage({ params }: PageProps<"/documents/[doc]/v/[n]">) {
  return (
    <Suspense fallback={<div className="px-6 py-8"><Loading /></div>}>
      <Version params={params} />
    </Suspense>
  );
}
