"use client";

import type { Schemas } from "@/lib/api/client";
import { inWords, useCompanyZone } from "@/lib/dates";

/** Why SwarmCloud holds a run's step, in plain words, and since when in the Company time zone. */
export function QueueWaitNote({
  wait,
  testId,
}: {
  wait: Schemas["QueueWait"];
  testId: string;
}) {
  const zone = useCompanyZone();
  return (
    <span data-testid={testId} className="text-sm text-text2">
      {wait.text} · since {inWords(wait.since, zone)}
    </span>
  );
}
