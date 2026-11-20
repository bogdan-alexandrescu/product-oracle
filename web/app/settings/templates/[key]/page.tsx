'use client';

import { useParams } from '@/lib/nav';
import { Suspense } from 'react';

import { TemplateDetail } from '@/components/TemplateDetail';
import { PageSkeleton } from '@/components/ds';

function Detail() {
  const { key } = useParams<{ key: string }>();
  return <TemplateDetail templateKey={key} />;
}

export default function TemplatePage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Detail />
    </Suspense>
  );
}
