import type { Metadata } from "next";
import { Suspense } from "react";

import { SharedRoadmap } from "@/components/share/SharedRoadmap";
import type { RouteProps } from "@/lib/route-props";

export const metadata: Metadata = {
  title: "Shared roadmap",
  // A private link: never indexed, never sent on as a referrer.
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

async function Shared({ params }: { params: RouteProps<{ token: string }>["params"] }) {
  const { token } = await params;
  return <SharedRoadmap token={token} />;
}

/**
 * A shared roadmap (O5): opened from a link with its passcode (owner answer O5-Q5), with no
 * account and no rail (AppShell leaves /s/ bare). Only the public share routes are called.
 */
export default function SharedRoadmapPage({ params }: RouteProps<{ token: string }>) {
  return (
    <Suspense fallback={null}>
      <Shared params={params} />
    </Suspense>
  );
}
