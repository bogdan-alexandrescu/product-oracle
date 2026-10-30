import { notFound, redirect } from "next/navigation";

import type { RouteProps } from "@/lib/route-props";
import { SIMPLE_MODE } from "@/lib/simple-mode";

/**
 * qa-simple-prd-12: a PRD's one-pager has one address, /simple/one-pagers/<doc> (what the rail,
 * the links and the mode switch know); this older one sends there.
 */
export default async function OldOnePagerPage({ params }: RouteProps<{ doc: string }>) {
  if (!SIMPLE_MODE) notFound();
  const { doc } = await params;
  redirect(`/simple/one-pagers/${encodeURIComponent(doc)}`);
}
