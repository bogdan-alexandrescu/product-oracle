import { notFound } from "next/navigation";
import { Suspense } from "react";

import { SIMPLE_MODE } from "@/lib/simple-mode";

import { Priorities } from "./priorities";

/** Simple S6 (#723, D9): priorities as a ranked list, a value/effort 2x2 and goal buckets. */
export default function SimplePrioritiesPage() {
  if (!SIMPLE_MODE) notFound();
  return (
    <Suspense>
      <Priorities />
    </Suspense>
  );
}
