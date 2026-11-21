'use client';

import { createFileRoute } from '@tanstack/react-router';
import { Suspense } from 'react';

import { NewDraft, NewPrd } from '@/components/NewDraft';
import { useSearchParams } from '@/lib/nav';
import { PageSkeleton } from '@/components/ds';

function Picker() {
  const q = useSearchParams();
  const kind = q.getAll('kind');
  const k = kind.length === 1 && kind[0] === 'roadmap' ? 'roadmap' : 'prd';
  // C1 lane 2: Start a PRD on requests (`requests=<id,id>`) ticks them under "Requests behind it".
  const requests = q.getAll('requests');
  const ids = (requests.length === 1 ? requests[0].split(',') : []).filter(Boolean).slice(0, 50);
  // C4: New PRD is the brief door; the roadmap door is the template picker, unchanged.
  return k === 'roadmap' ? (
    <NewDraft key={k} kind={k} />
  ) : (
    <NewPrd key={`${k}:${ids.join(',')}`} requestIds={ids} />
  );
}

function NewDraftPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Picker />
    </Suspense>
  );
}

export const Route = createFileRoute('/documents/new/')({ component: NewDraftPage });
