'use client';

import { createFileRoute } from '@tanstack/react-router';
import { MembersSettings } from '@/components/MembersSettings';

function MembersPage() {
  return <MembersSettings />;
}

export const Route = createFileRoute('/settings/members/')({ component: MembersPage });
