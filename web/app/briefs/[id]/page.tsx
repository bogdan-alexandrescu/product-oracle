import { Suspense } from "react";

import { Loading } from "@/components/ui";

import { BriefDetail } from "../_brief-detail";

async function Detail({ params }: { params: PageProps<"/briefs/[id]">["params"] }) {
  const { id } = await params;
  return <BriefDetail id={id} />;
}

export default function BriefPage({ params }: PageProps<"/briefs/[id]">) {
  return (
    <Suspense fallback={<div className="px-6 py-8"><Loading /></div>}>
      <Detail params={params} />
    </Suspense>
  );
}
