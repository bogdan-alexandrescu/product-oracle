import { Suspense } from "react";

import { Loading } from "@/components/ui";

import { OccurrenceDetail } from "../_components/OccurrenceDetail";

// Typed by hand rather than with Next's generated PageProps, so a plain `tsc --noEmit`
// (without a build's .next/types) checks it.
type Params = { params: Promise<{ occurrence: string }> };

async function Detail({ params }: Params) {
  const { occurrence } = await params;
  return <OccurrenceDetail id={occurrence} />;
}

/** One ritual occurrence, inside the Company shell with the Rituals tab selected. */
export default function OccurrencePage({ params }: Params) {
  return (
    <Suspense fallback={<Loading />}>
      <Detail params={params} />
    </Suspense>
  );
}
