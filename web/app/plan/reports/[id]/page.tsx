import { Suspense } from "react";

import { Loading } from "@/components/ui";

import { ReportDetail } from "../_report";

// Typed by hand rather than with Next's generated PageProps, so a plain `tsc --noEmit`
// (without a build's .next/types) checks it.
type Params = { params: Promise<{ id: string }> };

async function Detail({ params }: Params) {
  const { id } = await params;
  return <ReportDetail id={id} />;
}

export default function ReportPage({ params }: Params) {
  return (
    <Suspense fallback={<div className="px-6 py-8"><Loading /></div>}>
      <Detail params={params} />
    </Suspense>
  );
}
