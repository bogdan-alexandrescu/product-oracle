import type { ReactNode } from "react";

import { InfoTip } from "@/components/ds";

/**
 * A Company tab's empty state that says what goes here, why, and what to do
 * (qa-company-16, -36, -37): a short title, the add action when the signed-in role may take
 * it (else one short line saying who does), and the why behind the title's (i) (#1590).
 */
export function CompanyEmpty({
  title,
  children,
  tip,
  action,
  testId,
}: {
  title: string;
  children?: ReactNode;
  /** What goes here and why, behind an (i) beside the title. */
  tip?: ReactNode;
  action?: ReactNode;
  testId?: string;
}) {
  return (
    <div data-testid={testId} className="flex flex-col items-center gap-2 px-4 py-8 text-center max-[600px]:px-3">
      <p className="inline-flex items-center gap-1.5 text-[15px] font-semibold text-text">
        {title}
        {tip && (
          <InfoTip label={title} align="start" testId={testId ? `${testId}-tip` : undefined}>
            {tip}
          </InfoTip>
        )}
      </p>
      {children && <p className="max-w-lg text-sm text-text2">{children}</p>}
      {action && <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}
