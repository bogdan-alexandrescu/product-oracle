import type { ReactNode } from "react";

/** Status colours are only for status (B1); `now` (accent-soft) only for "now"; `acc` for counts and kinds. */
export type ChipKind = "pass" | "warn" | "crit" | "na" | "acc" | "now" | "line";

const KIND: Record<ChipKind, string> = {
  pass: "bg-pass-bg text-pass",
  warn: "bg-warn-bg text-warn",
  crit: "bg-crit-bg text-crit",
  na: "bg-na-bg text-na",
  acc: "bg-accent-soft text-accent-ink",
  now: "bg-accent-soft text-accent-ink",
  line: "border border-line-strong bg-transparent text-text",
};

/** Hero variant: chips in the inspector's dark head. */
const HERO: Partial<Record<ChipKind, string>> = { now: KIND.now };

export function Chip({
  kind = "na",
  dot = false,
  hero = false,
  wrap = false,
  title,
  className = "",
  children,
  ...rest
}: {
  kind?: ChipKind;
  /** A leading status dot (status chips in tables). */
  dot?: boolean;
  /** Inside an Inspector head. */
  hero?: boolean;
  /** A long label wraps onto more lines instead of overflowing a narrow screen. */
  wrap?: boolean;
  title?: string;
  className?: string;
  children: ReactNode;
} & { [data: `data-${string}`]: string | undefined }) {
  const tone = hero ? (HERO[kind] ?? "bg-hero-2 text-hero-text") : KIND[kind];
  return (
    <span
      title={title}
      data-kind={kind}
      {...rest}
      className={`tnum inline-flex max-w-full items-center gap-1.5 px-2.5 text-[13px] font-semibold ${
        wrap ? "min-h-[26px] rounded-[13px] py-1 leading-[18px]" : "h-[26px] rounded-full leading-none whitespace-nowrap"
      } ${tone} ${className}`}
    >
      {dot && <span aria-hidden className="size-2 flex-none rounded-full bg-current" />}
      {children}
    </span>
  );
}

/** A goal id tag (G1): mono, accent-soft; a proposed goal shows in warn. */
export function GoalTag({ id, proposed = false, title }: { id: string; proposed?: boolean; title?: string }) {
  return (
    <span
      title={title ?? (proposed ? `${id} · proposed` : id)}
      className={`tnum inline-grid h-6 flex-none place-items-center rounded-goal px-[7px] font-mono text-[13px] leading-none font-medium ${
        proposed ? "bg-warn-bg text-warn" : "bg-accent-soft text-accent-ink"
      }`}
    >
      {id}
    </span>
  );
}

/**
 * #370: a page the signed-in role can read but not change says so, quietly, in its header
 * (PageHeader's status). The controls it can never use are hidden, not disabled.
 */
export function ViewOnly() {
  return (
    <Chip kind="na" data-testid="view-only">
      View only
    </Chip>
  );
}
