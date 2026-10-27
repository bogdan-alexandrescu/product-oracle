import { notFound } from "next/navigation";
import { Suspense } from "react";

import { OnePager } from "@/components/simple/OnePager";
import { Loading } from "@/components/ui";
import type { RouteProps } from "@/lib/route-props";
import { SIMPLE_MODE } from "@/lib/simple-mode";

async function Body({ params }: { params: RouteProps<{ doc: string }>["params"] }) {
  const { doc } = await params;
  return <OnePager doc={doc} />;
}

/** Simple S5: a PRD's one-pager ("A · Paper"). */
export default function OnePagerPage({ params }: RouteProps<{ doc: string }>) {
  if (!SIMPLE_MODE) notFound();
  return (
    <Suspense fallback={<div className="px-6 py-8"><Loading /></div>}>
      <Body params={params} />
    </Suspense>
  );
}
