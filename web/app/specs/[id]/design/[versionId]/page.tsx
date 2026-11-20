'use client';

import { useParams } from '@/lib/nav';
import { Suspense } from 'react';

import { DesignReview } from '@/components/DesignReview';
import { PageSkeleton } from '@/components/ds';

function Detail() {
  const { id, versionId } = useParams<{ id: string; versionId: string }>();
  return <DesignReview specId={id} versionId={versionId} />;
}

/** v2 screen 4: a spec's user flow or wireframes, and their review. */
export default function DesignArtifactPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Detail />
    </Suspense>
  );
}
