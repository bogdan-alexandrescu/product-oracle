import { notFound } from "next/navigation";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/ds";
import { OnePager } from "@/components/simple/OnePager";
import type { RouteProps } from "@/lib/route-props";
import { SIMPLE_MODE } from "@/lib/simple-mode";

async function Body({ params }: { params: RouteProps<{ doc: string }>["params"] }) {
  const { doc } = await params;
  return <OnePager doc={doc} />;
}

/** Simple S5: a PRD's one-pager ("A · Paper"); the Detailed switch opens its PRD (qa-shell-4). */
export default function OnePagerPage({ params }: RouteProps<{ doc: string }>) {
  if (!SIMPLE_MODE) notFound();
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Body params={params} />
    </Suspense>
  );
}
