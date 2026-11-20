import { createFileRoute } from '@tanstack/react-router';

import InboxPage from './_inbox';

export const Route = createFileRoute('/inbox/')({ component: InboxPage });
