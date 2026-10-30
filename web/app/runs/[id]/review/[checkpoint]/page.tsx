import { Suspense } from "react";

import type { RouteProps } from "@/lib/route-props";

import { ReviewShell } from "./_shell";
import { PageSkeleton } from "@/components/ds";

async function Shell({ params, searchParams }: RouteProps<{ id: string; checkpoint: string }>) {
  const [{ id, checkpoint }, query] = await Promise.all([params, searchParams]);
  const item = typeof query.item === "string" ? query.item : null;
  return <ReviewShell runId={id} checkpointId={checkpoint} item={item} />;
}

/**
 * The shared review route (C7): `/runs/<id>/review/<checkpoint id>` loads the run and its
 * checkpoint and opens the view of the checkpoint's kind (./_shell.tsx VIEWS); any other
 * kind goes to the run page's decision. `?item=<key>` selects a row on arrival.
 */
export default function ReviewPage(props: RouteProps<{ id: string; checkpoint: string }>) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Shell {...props} />
    </Suspense>
  );
}
