import { Suspense } from "react";

import { Loading } from "@/components/ui";
import type { RouteProps } from "@/lib/route-props";

import { InterviewDetail } from "./_detail";

async function Detail({ params }: { params: RouteProps<{ id: string }>["params"] }) {
  const { id } = await params;
  return <InterviewDetail id={id} />;
}

/** A customer interview (C3): its approved questions, transcript, snapshot and requests. */
export default function InterviewPage({ params }: RouteProps<{ id: string }>) {
  return (
    <Suspense fallback={<div className="px-6 py-8"><Loading /></div>}>
      <Detail params={params} />
    </Suspense>
  );
}
