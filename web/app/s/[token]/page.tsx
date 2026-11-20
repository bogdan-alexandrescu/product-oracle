'use client';

import { Suspense } from 'react';

import { SharedRoadmap } from '@/components/share/SharedRoadmap';
import { useParams } from '@/lib/nav';
import { useTitle } from '@/lib/title';

function Shared() {
  const { token } = useParams<{ token: string }>();
  return <SharedRoadmap token={token} />;
}

/**
 * A shared roadmap (O5): opened from a link with its passcode (owner answer O5-Q5), with no
 * account and no rail (AppShell leaves /s/ bare). Only the public share routes are called.
 */
export default function SharedRoadmapPage() {
  useTitle('Shared roadmap');
  return (
    <>
      {/* A private link: never indexed, never sent on as a referrer. */}
      <meta name="robots" content="noindex, nofollow" />
      <meta name="referrer" content="no-referrer" />
      <Suspense fallback={null}>
        <Shared />
      </Suspense>
    </>
  );
}
