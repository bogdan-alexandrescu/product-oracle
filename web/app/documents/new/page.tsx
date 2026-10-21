import { Suspense } from "react";

import { NewDraft } from "@/components/NewDraft";
import { Loading } from "@/components/ui";
import type { RouteProps } from "@/lib/route-props";

async function Picker({ searchParams }: { searchParams: RouteProps["searchParams"] }) {
  const { kind } = await searchParams;
  const k = kind === "roadmap" ? "roadmap" : "prd";
  return <NewDraft key={k} kind={k} />;
}

export default function NewDraftPage({ searchParams }: RouteProps) {
  return (
    <Suspense fallback={<div className="px-6 py-8"><Loading /></div>}>
      <Picker searchParams={searchParams} />
    </Suspense>
  );
}
