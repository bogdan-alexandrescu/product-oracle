import { notFound } from "next/navigation";
import { Suspense } from "react";

import { Loading } from "@/components/ui";
import { SIMPLE_MODE } from "@/lib/simple-mode";

import { SimpleDecisions } from "./_decisions";

/** Simple S8 (#723): Decisions, direction B "By meeting". */
export default function SimpleDecisionsPage() {
  if (!SIMPLE_MODE) notFound();
  return (
    <Suspense fallback={<div className="px-6 py-8"><Loading /></div>}>
      <SimpleDecisions />
    </Suspense>
  );
}
