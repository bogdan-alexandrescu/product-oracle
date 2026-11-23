import { useContext } from 'react';

import { InfoTip } from '@/components/ds';
import { formatDate, formatDateTime } from '@/lib/format';
import { CompanyZoneStateContext } from '@/lib/me';
import { ZONE_UNAVAILABLE } from '@/lib/zone';

/**
 * A day in the Company time zone, its time on hover (qa-docs-34), and, when that zone could
 * not be read (#1677), a tip saying the default zone is used: never silently.
 */
export function CompanyDate({ iso, testId }: { iso: string; testId?: string }) {
  const state = useContext(CompanyZoneStateContext);
  return (
    <>
      <span data-testid={testId} title={formatDateTime(iso)}>
        {formatDate(iso)}
      </span>
      {state === 'unavailable' ? (
        <InfoTip label="Company time zone" testId="zone-unavailable">
          {ZONE_UNAVAILABLE}
        </InfoTip>
      ) : null}
    </>
  );
}
