import { notFound, redirect } from "next/navigation";

import type { RouteProps } from "@/lib/route-props";
import { SIMPLE_MODE } from "@/lib/simple-mode";

/**
 * Simple S5's older path to a PRD's one-pager: it opens the one-pager's own page
 * (/simple/one-pagers/<doc>), so one route shows it and the Detailed switch maps it (qa-shell-4).
 */
export default async function OldOnePagerPage({ params }: RouteProps<{ doc: string }>) {
  if (!SIMPLE_MODE) notFound();
  const { doc } = await params;
  redirect(`/simple/one-pagers/${encodeURIComponent(doc)}`);
}
