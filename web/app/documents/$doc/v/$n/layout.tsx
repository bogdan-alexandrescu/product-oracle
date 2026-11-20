import { Outlet, createFileRoute } from '@tanstack/react-router';
import { Suspense } from 'react';

import { RebuildSeenHere } from '@/components/RebuildSign';

/** Every pane of a version: opening it ends the rebuild sign's "v<n> ready: review it". */
function VersionLayout() {
  return (
    <>
      <Suspense fallback={null}>
        <RebuildSeenHere />
      </Suspense>
      <Outlet />
    </>
  );
}

export const Route = createFileRoute('/documents/$doc/v/$n')({ component: VersionLayout });
