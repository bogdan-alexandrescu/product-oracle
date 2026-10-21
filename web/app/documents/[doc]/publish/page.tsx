import { Suspense } from "react";

import { PublishView } from "@/components/PublishView";
import { Loading } from "@/components/ui";
import type { PageProps } from "@/lib/route-props";

async function Publish({ params }: { params: PageProps<"/documents/[doc]/publish">["params"] }) {
  const { doc } = await params;
  return <PublishView key={doc} doc={doc} />;
}

export default function PublishPage({ params }: PageProps<"/documents/[doc]/publish">) {
  return (
    <Suspense fallback={<div className="px-6 py-8"><Loading /></div>}>
      <Publish params={params} />
    </Suspense>
  );
}
