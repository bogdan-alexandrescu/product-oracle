import type { SelectHTMLAttributes } from "react";

import { Icon } from "@/components/ds/Icon";

/** qa-simple-decide-39: a meeting's select as Decisions' filters draw it (the mock-up's box, the chevron over it). */
export function SimpleSelect({ className = "", children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="relative inline-flex max-w-full">
      <select {...props} className={`simple-select !min-w-0 max-w-full ${className}`}>
        {children}
      </select>
      <span aria-hidden className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-text">
        <Icon name="chevron-down" size={18} stroke={1.7} />
      </span>
    </span>
  );
}

/** A checkbox or radio in Simple's accent colour, at a tappable size. */
export const CHECK = "h-5 w-5 shrink-0 accent-[var(--accent)]";
