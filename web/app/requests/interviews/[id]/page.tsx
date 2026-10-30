import { Suspense } from "react";

import type { RouteProps } from "@/lib/route-props";

import { InterviewDetail } from "./_detail";
import { PageSkeleton, PageTabsProvider } from "@/components/ds";

async function Detail({ params }: { params: RouteProps<{ id: string }>["params"] }) {
  const { id } = await params;
  // qa-work-44: one way back, "← Interviews": the Requests tabs are not drawn under the interview's name.
  return (
    <PageTabsProvider tabs={null}>
      <InterviewDetail id={id} />
    </PageTabsProvider>
  );
}

/** A customer interview (C3): its approved questions, transcript, snapshot and requests. */
export default function InterviewPage({ params }: RouteProps<{ id: string }>) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Detail params={params} />
    </Suspense>
  );
}
