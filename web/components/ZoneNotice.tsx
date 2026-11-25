import { useContext } from 'react';

import { InfoTip } from '@/components/ds/InfoTip';
import { CompanyZoneStateContext } from '@/lib/me';
import { ZONE_UNAVAILABLE, type ZoneState } from '@/lib/zone';

/**
 * #1721: the one notice that the Company time zone could not be read, so dates use the
 * default zone: an (i), never a sentence on the page. With no `state`, the shell's (GET
 * /v1/me's); a page whose own read says its state (the Claude accounts pool) passes it, and
 * shows it only where the shell does not already.
 */
export function ZoneNotice({ state, bar = false }: { state?: ZoneState | null; bar?: boolean }) {
  const shell = useContext(CompanyZoneStateContext);
  const own = state !== undefined;
  if (own ? state !== 'unavailable' || shell === 'unavailable' : shell !== 'unavailable')
    return null;
  const tip = (
    <InfoTip label="Company time zone" testId="zone-unavailable" side="bottom">
      {ZONE_UNAVAILABLE}
    </InfoTip>
  );
  return bar ? <div className="flex justify-end px-4 pt-2 sm:px-6">{tip}</div> : tip;
}
