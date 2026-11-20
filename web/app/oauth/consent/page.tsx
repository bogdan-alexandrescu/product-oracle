'use client';

import { createFileRoute } from '@tanstack/react-router';
import { Suspense } from 'react';

import { ConsentScreen } from './ConsentScreen';

function ConsentPage() {
  return (
    <Suspense>
      <ConsentScreen />
    </Suspense>
  );
}

export const Route = createFileRoute('/oauth/consent/')({ component: ConsentPage });
