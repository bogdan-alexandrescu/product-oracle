import { createFileRoute } from '@tanstack/react-router';

import InboxPage from '@/app/inbox/_inbox';

/**
 * S-7: Simple's Inbox, the one Inbox (Detailed's too) in Simple's shell, so its rail link keeps
 * the person in Simple.
 */
export const Route = createFileRoute('/simple/inbox/')({ component: InboxPage });
