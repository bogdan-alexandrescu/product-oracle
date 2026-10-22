"use client";

import { Button, Icon, LinkButton, Panel } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";
import { formatDay } from "@/lib/format";

type Step = Schemas["SetupStep"];

/**
 * The web's copy of each setup step the API names (A1): label, where Open goes, and the
 * status figure. A pick that adds a step to oracle.setup.STEPS adds its line here.
 */
const STEPS: Record<string, { label: string; href: string; status: (s: Step) => string }> = {
  connect: {
    label: "Connect tools",
    href: "/settings/connections?from=setup",
    status: (s) => (s.done ? `${s.count} connected` : "None"),
  },
  sources: {
    label: "Pick sources",
    href: "/settings/sources?from=setup",
    status: (s) => (s.done ? `${s.count} ${s.count === 1 ? "source" : "sources"}` : "None"),
  },
  invite: {
    label: "Invite team",
    href: "/settings/members?from=setup",
    // Done with a second member, or with an open invite while still alone.
    status: (s) => (!s.done ? "Only you" : (s.count ?? 0) >= 2 ? `${s.count} people` : "Invited"),
  },
  domains: {
    label: "Company domains",
    href: "/settings/sources?from=setup#company-domains",
    status: (s) => (!s.done ? "Not set" : (s.detail ?? `${s.count} domains`)),
  },
  horizons: {
    label: "Horizons",
    href: "/settings/company?from=setup#horizons",
    status: (s) => (s.done ? "Checked" : "Not checked"),
  },
  // B1: done once a Build the baseline run succeeded; detail is when the last one finished.
  build_baseline: {
    label: "Build baseline",
    href: "/baseline?build=1",
    status: (s) => (!s.done ? "Not built" : s.detail ? `Built ${formatDay(s.detail)}` : "Built"),
  },
};

/** Whether the checklist has anything left for this person. */
export function setupOpen(setup: Schemas["SetupOut"] | undefined): setup is Schemas["SetupOut"] {
  return !!setup && setup.total > 0 && setup.done < setup.total;
}

/** The header chip that draws a hidden checklist again: "Set up 2/6". */
export function SetupChip({ setup, onShow, busy }: { setup: Schemas["SetupOut"]; onShow: () => void; busy: boolean }) {
  return (
    <button
      type="button"
      data-testid="home-setup-chip"
      onClick={onShow}
      disabled={busy}
      className="tnum inline-flex h-[26px] items-center gap-1.5 rounded-full bg-accent-soft px-2.5 text-[13px] leading-none font-semibold whitespace-nowrap text-accent-ink hover:brightness-95 disabled:opacity-70"
    >
      Set up {setup.done}/{setup.total}
    </button>
  );
}

/**
 * Set up (A1): the first steps of this company's Oracle, done or open, each one click
 * away. Drawn first on Home while a step is open and the person has not hidden it.
 */
export function SetupPanel({ setup, onHide, busy }: { setup: Schemas["SetupOut"]; onHide: () => void; busy: boolean }) {
  const steps = setup.steps.filter((s) => s.key in STEPS);
  return (
    <Panel
      title="Set up"
      count={`${setup.done} of ${setup.total}`}
      testId="home-setup"
      tools={
        <Button variant="ghost" onClick={onHide} disabled={busy}>
          Hide
        </Button>
      }
    >
      <ul>
        {steps.map((s) => {
          const copy = STEPS[s.key];
          const status = copy.status(s);
          return (
            <li
              key={s.key}
              data-testid={`setup-row-${s.key}`}
              data-done={s.done}
              className="flex min-h-12 min-w-0 items-center gap-2.5 border-b border-line px-4 py-1.5 last:border-b-0 max-[600px]:gap-2 max-[600px]:px-3"
            >
              {s.done ? (
                <span aria-label="Done" role="img" className="grid size-6 flex-none place-items-center rounded-full bg-pass-bg text-pass">
                  <Icon name="check" size={16} />
                </span>
              ) : (
                <span aria-label="To do" role="img" className="size-6 flex-none rounded-full border-2 border-line-strong" />
              )}
              <span className="min-w-0 truncate font-semibold" title={copy.label}>
                {copy.label}
              </span>
              <span className="ml-auto flex min-w-0 items-center gap-2.5 max-[600px]:gap-2">
                <span data-testid="setup-status" title={status} className="tnum min-w-0 truncate text-[15px] text-text2">
                  {status}
                </span>
                <LinkButton href={copy.href} className="flex-none">
                  Open
                </LinkButton>
              </span>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
