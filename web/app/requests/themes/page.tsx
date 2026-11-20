'use client';

import { createFileRoute } from '@tanstack/react-router';
import { RequestsScreen } from '../_components/RequestsScreen';

/** Requests' Themes tab (#348): list, create, rename and archive the themes requests group under. */
function RequestThemesPage() {
  return <RequestsScreen view="themes" />;
}

export const Route = createFileRoute('/requests/themes/')({ component: RequestThemesPage });
