'use client';

import { createFileRoute } from '@tanstack/react-router';
import { ClaudeAccounts } from './ClaudeAccounts';

function ClaudeAccountsPage() {
  return <ClaudeAccounts />;
}

export const Route = createFileRoute('/settings/claude-accounts/')({
  component: ClaudeAccountsPage,
});
