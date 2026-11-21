'use client';

import { createFileRoute } from '@tanstack/react-router';
import { useRouter } from '@/lib/nav';
import { useEffect } from 'react';

import { Loading } from '@/components/ui';
import { useMe } from '@/lib/me';
import { useSettingsTabs } from '@/lib/settings-tabs';

/** Settings opens on the first tab the signed-in role can read (#370). */
function SettingsPage() {
  const router = useRouter();
  const { tabs, ready } = useSettingsTabs();
  const { capsError } = useMe();
  const first = tabs[0]?.href;
  useEffect(() => {
    if (ready) router.replace(first ?? '/home');
  }, [ready, first, router]);
  // A failed read says so in the shell, with Retry (#370 fixes 4).
  return capsError ? null : <Loading />;
}

export const Route = createFileRoute('/settings/')({ component: SettingsPage });
