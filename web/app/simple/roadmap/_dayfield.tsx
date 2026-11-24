'use client';

import { shortDay } from './_lib';

/** #1751: the day in words, month first ("Nov 14, 2026"), a native date picker laid over it,
 * as the milestone card's date field: the browser's own format (dd.mm.yyyy) never shows. */
export function DayField({
  value,
  label,
  onChange,
}: {
  value: string;
  label: string;
  onChange: (d: string) => void;
}) {
  return (
    <span className="relative flex h-8 min-w-[8.5rem] items-center rounded-lg border border-line bg-bg px-2 text-base font-normal text-text focus-within:border-accent">
      <span data-testid="key-date-day-words" className={value ? '' : 'text-text2'}>
        {value ? `${shortDay(value)}, ${value.slice(0, 4)}` : 'Pick a day'}
      </span>
      <input
        aria-label={label}
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0"
      />
    </span>
  );
}
