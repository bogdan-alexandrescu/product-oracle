import { notFound } from "next/navigation";
import { Suspense } from "react";

import { Loading } from "@/components/ui";
import type { RouteProps } from "@/lib/route-props";
import { SIMPLE_MODE } from "@/lib/simple-mode";

import { MeetingScreen } from "./_meeting";

async function Body({ params }: { params: RouteProps<{ id: string }>["params"] }) {
  const { id } = await params;
  return <MeetingScreen id={id} />;
}

/** Simple S8 (#723): one review meeting, full screen; once ended, its minutes. */
export default function SimpleMeeting({ params }: RouteProps<{ id: string }>) {
  if (!SIMPLE_MODE) notFound();
  return (
    <Suspense fallback={<div className="px-6 py-8"><Loading /></div>}>
      <Body params={params} />
    </Suspense>
  );
}
