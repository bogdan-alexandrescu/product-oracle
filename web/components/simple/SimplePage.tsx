import Link from "next/link";
import type { ReactNode } from "react";

/**
 * A Simple page (#723 S1): its title and parts, drawn from the Simple tokens (globals.css,
 * html[data-mode="simple"]) so the owner's mockup picks restyle it there. The H1 hides on a
 * phone, as Detailed's does: the phone header shows it.
 */
export function SimplePage({ title, lead, children }: { title: string; lead?: ReactNode; children: ReactNode }) {
  return (
    <div className="simple-page" data-testid="simple-page">
      <header className="flex flex-col gap-2">
        <h1 className="simple-h1 max-[600px]:sr-only">{title}</h1>
        {lead && <p className="simple-small">{lead}</p>}
      </header>
      {children}
    </div>
  );
}

/** One part of a Simple page: a heading and a card. */
export function SimpleSection({ title, testId, action, children }: { title: string; testId?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="simple-card" data-testid={testId} aria-label={title}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="simple-h2">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A part with nothing in it yet: one line, said plainly. */
export function SimpleEmpty({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <p className="simple-small" data-testid={testId}>
      {children}
    </p>
  );
}

/**
 * A page whose screen arrives with a later part of Simple: says what arrives and links the
 * Detailed page that has it today.
 */
export function SimplePlaceholder({ arrives, detailedHref, detailedLabel }: { arrives: ReactNode; detailedHref: string; detailedLabel: string }) {
  return (
    <div className="simple-card" data-testid="simple-placeholder">
      <p>
        <span className="font-semibold">Arrives soon: </span>
        {arrives}
      </p>
      <p>
        Until then: {detailedLabel}.{" "}
        <Link href={detailedHref} className="font-semibold text-accent-ink hover:underline">
          Open the detailed view
        </Link>
      </p>
    </div>
  );
}
