import { createFileRoute } from '@tanstack/react-router';

import SettingsNotFound from './not-found';

/**
 * F-32: a wrong URL under Settings ("/settings/bad") is not-found inside Settings' layout, so the
 * Settings tabs stay above it (as a missing run keeps Runs' page), not the bare root not-found.
 */
export const Route = createFileRoute('/settings/$')({ component: SettingsNotFound });
