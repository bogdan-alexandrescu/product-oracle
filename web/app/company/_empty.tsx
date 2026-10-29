import type { ReactNode } from "react";

/**
 * A Company tab's empty state that says what goes here, why, and what to do
 * (qa-company-16, -36, -37): a short title, a line or two of explanation, and the add action
 * when the signed-in role may take it (else who does).
 */
export function CompanyEmpty({
  title,
  children,
  action,
  testId,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
  testId?: string;
}) {
  return (
    <div data-testid={testId} className="flex flex-col items-center gap-2 px-4 py-8 text-center max-[600px]:px-3">
      <p className="text-[15px] font-semibold text-text">{title}</p>
      <p className="max-w-lg text-sm text-text2">{children}</p>
      {action && <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}
