'use client';

import { createFileRoute } from '@tanstack/react-router';
import { useParams } from '@/lib/nav';
import { Suspense } from 'react';

import { DesignReview } from '@/components/DesignReview';
import { PageSkeleton } from '@/components/ds';

function Detail() {
  const { id, versionId } = useParams<{ id: string; versionId: string }>();
  return <DesignReview specId={id} versionId={versionId} />;
}

/** v2 screen 4: a spec's user flow or wireframes, and their review. */
function DesignArtifactPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Detail />
    </Suspense>
  );
}

export const Route = createFileRoute('/specs/$id/design/$versionId/')({
  component: DesignArtifactPage,
});
