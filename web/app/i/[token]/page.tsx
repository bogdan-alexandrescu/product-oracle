import type { Metadata } from "next";
import { Suspense } from "react";

import type { RouteProps } from "@/lib/route-props";

import { InterviewChat } from "./_chat";

export const metadata: Metadata = {
  title: "Interview",
  // A private one-time link: never indexed, never sent on as a referrer.
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

async function Chat({ params }: { params: RouteProps<{ token: string }>["params"] }) {
  const { token } = await params;
  return <InterviewChat token={token} />;
}

/**
 * A customer's interview (C3): opened from a private one-time link, with no account and no
 * rail (AppShell leaves /i/ bare). Only the public interview routes are called.
 */
export default function CustomerInterviewPage({ params }: RouteProps<{ token: string }>) {
  return (
    <Suspense fallback={null}>
      <Chat params={params} />
    </Suspense>
  );
}
