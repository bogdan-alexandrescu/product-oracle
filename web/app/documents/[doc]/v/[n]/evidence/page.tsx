'use client';

import { useParams } from '@/lib/nav';
import { Suspense } from 'react';

import { VersionView } from '@/components/VersionView';
import { PageSkeleton } from '@/components/ds';

/** A PRD version's Evidence tab (v2 screen 3: the evidence inspector). */
function Evidence() {
  const { doc, n } = useParams<{ doc: string; n: string }>();
  return <VersionView key={`${doc}/${n}/evidence`} doc={doc} n={Number(n)} pane="evidence" />;
}

export default function VersionEvidencePage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Evidence />
    </Suspense>
  );
}
