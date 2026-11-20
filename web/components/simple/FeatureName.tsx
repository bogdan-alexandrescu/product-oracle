'use client';
// A feature as Simple names it on every page: its code, then its name ("F-12 Alert rules engine");
// one with no Ground Truth code is flagged, never refused (docs/ground-truth.md). The one flag and
// the one code-and-name every page uses: the Roadmap's _gtflag and _fields re-export these.

import { Chip } from '@/components/ds/Chip';

/** The words of the flag a feature with no Ground Truth code carries. */
export const NOT_IN_GT = 'Not in the Ground Truth';
/** qa-nov17 #5/#8: the flag's short words where a narrow column would cut the long ones (whole in its title). */
export const NOT_IN_GT_SHORT = 'Not in GT';

/** A feature's code chip, then its name: "F-12 Alert rules engine". */
export function Named({ item }: { item: { code?: string | null; title: string } }) {
  return (
    <>
      {item.code && (
        <>
          <span className="simple-code mr-0.5">{item.code}</span>{' '}
        </>
      )}
      {item.title}
    </>
  );
}

/**
 * The flag a feature with no Ground Truth code carries: the Roadmap's warn chip, on every page.
 * Given an item, it shows only when the item has no code.
 */
export function NotInGt({
  item,
  className = 'ml-1.5 h-5! px-2! text-xs!',
  short = false,
}: {
  item?: { code?: string | null };
  className?: string;
  short?: boolean;
}) {
  if (item?.code) return null;
  return (
    <Chip
      kind="warn"
      className={`shrink-0 ${className}`}
      title={NOT_IN_GT}
      data-testid="not-in-gt"
      data-short={short ? '' : undefined}
    >
      {short ? (
        // qa-nov17 #5/#8: a names column's flag is whole in short words, never cut; read in full.
        <>
          <span aria-hidden>{NOT_IN_GT_SHORT}</span>
          <span className="sr-only">{NOT_IN_GT}</span>
        </>
      ) : (
        // A narrow row may cut the words (its title keeps them whole).
        <span className="truncate">{NOT_IN_GT}</span>
      )}
    </Chip>
  );
}

/** "F-12 Alert rules engine"; a name with no code gets the "Not in the Ground Truth" flag. */
export function FeatureName({ item }: { item: { code?: string | null; title: string } }) {
  return (
    <>
      <Named item={{ code: item.code ?? '', title: item.title }} />
      <NotInGt item={item} />
    </>
  );
}
