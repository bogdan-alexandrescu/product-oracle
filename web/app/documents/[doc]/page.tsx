import { Suspense } from "react";

import { DocumentOverview } from "@/components/DocumentOverview";
import { Loading } from "@/components/ui";

async function Overview({ params }: { params: PageProps<"/documents/[doc]">["params"] }) {
  const { doc } = await params;
  return <DocumentOverview doc={doc} />;
}

export default function DocumentPage({ params }: PageProps<"/documents/[doc]">) {
  return (
    <Suspense fallback={<div className="px-6 py-8"><Loading /></div>}>
      <Overview params={params} />
    </Suspense>
  );
}
