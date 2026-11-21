'use client';

import { createFileRoute } from '@tanstack/react-router';
import { Suspense } from 'react';

import { ConnectionsSettings } from './ConnectionsSettings';

function ConnectionsPage() {
  return (
    <Suspense>
      <ConnectionsSettings />
    </Suspense>
  );
}

export const Route = createFileRoute('/settings/connections/')({ component: ConnectionsPage });
