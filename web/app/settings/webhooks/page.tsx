'use client';

import { createFileRoute } from '@tanstack/react-router';
import { Suspense } from 'react';

import { WebhooksSettings } from './WebhooksSettings';
import { PageSkeleton } from '@/components/ds';

function WebhooksPage() {
  return (
    <Suspense fallback={<PageSkeleton bare />}>
      <WebhooksSettings />
    </Suspense>
  );
}

export const Route = createFileRoute('/settings/webhooks/')({ component: WebhooksPage });
