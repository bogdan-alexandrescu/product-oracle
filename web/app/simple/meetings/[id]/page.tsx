import { notFound } from "next/navigation";
import { Suspense } from "react";

import type { RouteProps } from "@/lib/route-props";
import { SIMPLE_MODE } from "@/lib/simple-mode";

import { MeetingScreen } from "./_meeting";
import { PageSkeleton } from "@/components/ds";

async function Body({ params }: { params: RouteProps<{ id: string }>["params"] }) {
  const { id } = await params;
  return <MeetingScreen id={id} />;
}

/** Simple S8 (#723): one review meeting, full screen; once ended, its minutes. */
export default function SimpleMeeting({ params }: RouteProps<{ id: string }>) {
  if (!SIMPLE_MODE) notFound();
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Body params={params} />
    </Suspense>
  );
}
