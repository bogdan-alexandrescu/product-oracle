'use client';

import { createFileRoute } from '@tanstack/react-router';
import { useParams } from '@/lib/nav';
import { Suspense } from 'react';

import { VersionView } from '@/components/VersionView';
import { PageSkeleton } from '@/components/ds';

/** A PRD version's Roadmap tab (E1); a roadmap version's /roadmap opens its Items tab. */
function Roadmap() {
  const { doc, n } = useParams<{ doc: string; n: string }>();
  return <VersionView key={`${doc}/${n}/roadmap`} doc={doc} n={Number(n)} pane="roadmap" />;
}

function VersionRoadmapPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Roadmap />
    </Suspense>
  );
}

export const Route = createFileRoute('/documents/$doc/v/$n/roadmap/')({
  component: VersionRoadmapPage,
});
