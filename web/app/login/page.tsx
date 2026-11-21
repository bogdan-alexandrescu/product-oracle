'use client';

import { createFileRoute } from '@tanstack/react-router';
import { Suspense } from 'react';

import { AuthCard } from '@/app/login/_components/AuthCard';
import { LoginForm } from '@/components/LoginForm';

function LoginPage() {
  return (
    // Without JavaScript, index.html's <noscript> says why the page is blank (fix2-shell review).
    <Suspense fallback={<AuthCard title="Sign in">{null}</AuthCard>}>
      <LoginForm />
    </Suspense>
  );
}

export const Route = createFileRoute('/login/')({ component: LoginPage });
