'use client';

import { createFileRoute } from '@tanstack/react-router';
import { useParams } from '@/lib/nav';
import { Suspense } from 'react';

import { ThemeDetail } from '@/components/ThemeDetail';
import { PageSkeleton } from '@/components/ds';

function Detail() {
  const { key } = useParams<{ key: string }>();
  return <ThemeDetail themeKey={key} />;
}

function ThemePage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Detail />
    </Suspense>
  );
}

export const Route = createFileRoute('/settings/themes/$key/')({ component: ThemePage });
