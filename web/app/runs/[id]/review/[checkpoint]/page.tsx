import { Suspense } from "react";

import { Loading } from "@/components/ui";

import { CheckpointReviewScreen } from "./_review";
import type { RouteProps } from "@/lib/route-props";

async function Screen({ params }: { params: RouteProps<{ id: string; checkpoint: string }>["params"] }) {
  const { id, checkpoint } = await params;
  return <CheckpointReviewScreen runId={id} checkpointId={checkpoint} />;
}

export default function CheckpointReviewPage({ params }: RouteProps<{ id: string; checkpoint: string }>) {
  return (
    <Suspense fallback={<div className="px-6 py-8"><Loading /></div>}>
      <Screen params={params} />
    </Suspense>
  );
}
