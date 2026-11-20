'use client';

import { createFileRoute } from '@tanstack/react-router';
import { MyAccount } from '@/components/MyAccount';

function AccountPage() {
  return <MyAccount />;
}

export const Route = createFileRoute('/account/')({ component: AccountPage });
