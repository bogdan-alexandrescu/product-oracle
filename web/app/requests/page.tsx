'use client';

import { createFileRoute } from '@tanstack/react-router';
import { RequestsScreen } from './_components/RequestsScreen';

/** Requests' All requests tab (C1, #348): the queue, with the requests Oracle found in your sources. */
function RequestsPage() {
  return <RequestsScreen view="all" />;
}

export const Route = createFileRoute('/requests/')({ component: RequestsPage });
