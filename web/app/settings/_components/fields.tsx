import type { ReactNode } from "react";

/**
 * Form parts for the settings slice (the kit has no inputs yet; lift into components/ds
 * when another slice needs them). Token classes only, 15 px text, 13 px labels.
 */
export const INPUT =
  "h-9 w-full min-w-0 rounded-lg border border-line-strong bg-surface px-2.5 text-[15px] text-text placeholder:text-text2 focus:border-accent focus:outline-none disabled:opacity-70";
export const TEXTAREA =
  "w-full min-w-0 rounded-lg border border-line-strong bg-surface px-2.5 py-2 text-[15px] leading-[22px] text-text placeholder:text-text2 focus:border-accent focus:outline-none disabled:opacity-70";
export const SELECT =
  "h-8 min-w-0 rounded-lg border border-line-strong bg-surface pr-7 pl-2 text-sm text-text focus:border-accent focus:outline-none disabled:opacity-70";
/** A select that fills a form field, as tall as INPUT. */
export const SELECT_FIELD =
  "h-9 w-full min-w-0 rounded-lg border border-line-strong bg-surface pr-7 pl-2.5 text-[15px] text-text focus:border-accent focus:outline-none disabled:opacity-70";

const LABEL = "text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2";

/**
 * A labelled field: 13 px label above the control. With `tip` (an InfoTip), pass the
 * control's `id` as `htmlFor`, so the tip's button sits outside the <label> and the
 * control keeps the label as its exact accessible name.
 */
export function Field({
  label,
  tip,
  htmlFor,
  children,
  className = "",
}: {
  label: ReactNode;
  tip?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  if (tip && htmlFor) {
    return (
      <div className={`flex min-w-0 flex-col gap-1.5 ${className}`}>
        <span className="flex items-center gap-1.5">
          <label htmlFor={htmlFor} className={LABEL}>
            {label}
          </label>
          {tip}
        </span>
        {children}
      </div>
    );
  }
  return (
    <label className={`flex min-w-0 flex-col gap-1.5 ${className}`}>
      <span className={LABEL}>{label}</span>
      {children}
    </label>
  );
}
