'use client';

import { createFileRoute } from '@tanstack/react-router';
import { useParams } from '@/lib/nav';
import { Suspense } from 'react';

import { VersionView } from '@/components/VersionView';
import { PageSkeleton } from '@/components/ds';

/** A roadmap version's Items tab (E2); a PRD version's /items opens the version itself. */
function Items() {
  const { doc, n } = useParams<{ doc: string; n: string }>();
  return <VersionView key={`${doc}/${n}/items`} doc={doc} n={Number(n)} pane="items" />;
}

function VersionItemsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Items />
    </Suspense>
  );
}

export const Route = createFileRoute('/documents/$doc/v/$n/items/')({
  component: VersionItemsPage,
});
