'use client';

import { createFileRoute } from '@tanstack/react-router';
import { Suspense } from 'react';

import { NotificationsSettings } from './NotificationsSettings';
import { PageSkeleton } from '@/components/ds';

function NotificationsPage() {
  return (
    <Suspense fallback={<PageSkeleton bare />}>
      <NotificationsSettings />
    </Suspense>
  );
}

export const Route = createFileRoute('/settings/notifications/')({ component: NotificationsPage });
