'use client';

import { createFileRoute } from '@tanstack/react-router';
import { Suspense } from 'react';

import { useParams } from '@/lib/nav';
import { useTitle } from '@/lib/title';

import { InterviewChat } from './_chat';

function Chat() {
  const { token } = useParams<{ token: string }>();
  return <InterviewChat token={token} />;
}

/**
 * A customer's interview (C3): opened from a private one-time link, with no account and no
 * rail (AppShell leaves /i/ bare). Only the public interview routes are called.
 */
function CustomerInterviewPage() {
  useTitle('Interview');
  return (
    <>
      {/* A private one-time link: never indexed, never sent on as a referrer. */}
      <meta name="robots" content="noindex, nofollow" />
      <meta name="referrer" content="no-referrer" />
      <Suspense fallback={null}>
        <Chat />
      </Suspense>
    </>
  );
}

export const Route = createFileRoute('/i/$token/')({ component: CustomerInterviewPage });
