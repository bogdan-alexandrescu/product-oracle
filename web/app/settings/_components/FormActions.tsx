import type { ReactNode } from "react";

/**
 * A form's main action under the form it saves (qa-settings-28). `sticky` keeps it in sight
 * at the bottom of the window while the form is long (as the last thing in a Panel's padded
 * body). While the action is disabled, `reason` says why next to it; give the button
 * `aria-describedby={id}` so it is read with it.
 */
export function FormActions({
  id,
  reason,
  children,
  sticky = false,
  className = "",
}: {
  /** The reason's id, for the button's aria-describedby. */
  id: string;
  reason?: string | null;
  children: ReactNode;
  sticky?: boolean;
  className?: string;
}) {
  return (
    <div
      data-testid={`${id}-bar`}
      className={`flex flex-wrap items-center gap-x-3 gap-y-2 ${
        sticky ? "sticky bottom-0 z-[2] -mx-4 -mb-4 rounded-b-panel border-t border-line bg-surface px-4 py-3 max-[600px]:bottom-[var(--phone-tab-bar)] max-[600px]:-mx-3 max-[600px]:-mb-3 max-[600px]:px-3" : ""
      } ${className}`}
    >
      {children}
      {reason && (
        <span id={id} data-testid={id} className="text-sm text-text2">
          {reason}
        </span>
      )}
    </div>
  );
}
