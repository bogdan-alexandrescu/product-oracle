'use client';

import { createFileRoute } from '@tanstack/react-router';
import { AutonomySettings } from './AutonomySettings';

function AutonomyPage() {
  return <AutonomySettings />;
}

export const Route = createFileRoute('/settings/autonomy/')({ component: AutonomyPage });
