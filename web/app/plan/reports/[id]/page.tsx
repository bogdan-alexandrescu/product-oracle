import { Suspense } from "react";

import { Loading } from "@/components/ui";

import { ReportDetail } from "../_report";

async function Detail({ params }: { params: PageProps<"/plan/reports/[id]">["params"] }) {
  const { id } = await params;
  return <ReportDetail id={id} />;
}

export default function ReportPage({ params }: PageProps<"/plan/reports/[id]">) {
  return (
    <Suspense fallback={<div className="px-6 py-8"><Loading /></div>}>
      <Detail params={params} />
    </Suspense>
  );
}
