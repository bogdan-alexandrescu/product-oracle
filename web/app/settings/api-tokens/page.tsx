'use client';

import { createFileRoute } from '@tanstack/react-router';
import { Suspense } from 'react';

import { ApiTokensSettings } from '@/components/ApiTokensSettings';
import { useSearchParams } from '@/lib/nav';

function Tokens() {
  const member = useSearchParams().getAll('member');
  return <ApiTokensSettings initialMember={member.length === 1 ? member[0] : null} />;
}

function ApiTokensPage() {
  return (
    <Suspense fallback={null}>
      <Tokens />
    </Suspense>
  );
}

export const Route = createFileRoute('/settings/api-tokens/')({ component: ApiTokensPage });
