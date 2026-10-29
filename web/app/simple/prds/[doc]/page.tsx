import { permanentRedirect } from "next/navigation";

import type { RouteProps } from "@/lib/route-props";

/**
 * An old link to a PRD's one-pager (qa-shell-4): the one-pager lives at /simple/one-pagers/<doc>,
 * which the One-pagers list, Home and the mode switch open; this path only sends there.
 */
export default async function OldOnePagerPath({ params }: RouteProps<{ doc: string }>) {
  const { doc } = await params;
  permanentRedirect(`/simple/one-pagers/${encodeURIComponent(doc)}`);
}
