import { Suspense } from "react";

import { PublicCheck } from "@/components/share/PublicCheck";
import { Loading } from "@/components/ui";
import type { RouteProps } from "@/lib/route-props";

async function Check({ params }: { params: RouteProps<{ doc: string }>["params"] }) {
  const { doc } = await params;
  return <PublicCheck doc={doc} />;
}

/** O5: the Public check, the review list beside the exact page a link holder sees. */
export default function PublicCheckPage({ params }: RouteProps<{ doc: string }>) {
  return (
    <Suspense fallback={<div className="px-6 py-8"><Loading /></div>}>
      <Check params={params} />
    </Suspense>
  );
}
