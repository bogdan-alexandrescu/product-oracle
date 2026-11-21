'use client';

import { createFileRoute } from '@tanstack/react-router';
import { useRouter } from '@/lib/nav';
import { useEffect } from 'react';

import { loadLanding } from '@/lib/experience';

/**
 * The bare site URL opens the person's home (UI test finding E1): Detailed's Home, or Simple's
 * when they chose Simple or their role lands there (#723, D13).
 */
function Root() {
  const router = useRouter();
  useEffect(() => {
    let alive = true;
    void loadLanding().then((to) => alive && router.replace(to));
    return () => {
      alive = false;
    };
  }, [router]);
  return null;
}

export const Route = createFileRoute('/')({ component: Root });
