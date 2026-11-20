'use client';

import { createFileRoute } from '@tanstack/react-router';
import { useParams, useSearchParams } from '@/lib/nav';

import { MeetingChatPage } from './_chat';

/** Simple S9 (#723): one meeting's shared chat on its own page; S8's meeting screen renders the same MeetingChat in its right column. */
function SimpleMeetingChat() {
  const { id } = useParams<{ id: string }>();
  const session = useSearchParams().getAll('session');
  return <MeetingChatPage id={id} session={session.length === 1 ? session[0] : ''} />;
}

export const Route = createFileRoute('/simple/meetings/$id/chat/')({
  component: SimpleMeetingChat,
});
