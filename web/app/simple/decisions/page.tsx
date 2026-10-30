import { notFound } from "next/navigation";
import { Suspense } from "react";

import { SIMPLE_MODE } from "@/lib/simple-mode";

import { SimpleDecisions } from "./_decisions";
import { PageSkeleton } from "@/components/ds";

/** Simple S8 (#723): Decisions, direction B "By meeting". */
export default function SimpleDecisionsPage() {
  if (!SIMPLE_MODE) notFound();
  return (
    <Suspense fallback={<PageSkeleton />}>
      <SimpleDecisions />
    </Suspense>
  );
}
