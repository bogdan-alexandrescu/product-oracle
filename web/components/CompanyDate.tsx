import { formatDate, formatDateTime } from '@/lib/format';

/**
 * A day in the Company time zone, its time on hover (qa-docs-34). When that zone could not be
 * read (#1677), the shell's ZoneNotice says so once for the page (#1721).
 */
export function CompanyDate({ iso, testId }: { iso: string; testId?: string }) {
  return (
    <span data-testid={testId} title={formatDateTime(iso)}>
      {formatDate(iso)}
    </span>
  );
}
