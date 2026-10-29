import type { RouteProps } from "@/lib/route-props";

import { MeetingChatPage } from "./_chat";

/** Simple S9 (#723): one meeting's shared chat on its own page; S8's meeting screen renders the same MeetingChat in its right column. */
export default async function SimpleMeetingChat({ params, searchParams }: RouteProps<{ id: string }>) {
  const { id } = await params;
  const session = (await searchParams).session;
  return <MeetingChatPage id={id} session={typeof session === "string" ? session : ""} />;
}
