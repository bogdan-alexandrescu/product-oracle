"use client";

import Link from "next/link";

import { Button, Panel } from "@/components/ds";
import { useMe, type Role } from "@/lib/me";

type Copy = { role: string; steps: { label: string; href: string }[] };

/**
 * The welcome's words (A1 welcome, #140), by role: what Oracle is for this person and the
 * first three things to do. The exact wording is the owner's call (questions.json); this is
 * the recommended one. What the person may do (can()) only picks the words; what each page
 * lets them do is still decided there.
 */
const COPY: Record<Role, Copy> = {
  owner: {
    role: "You are an owner: you set Oracle up for the company and decide who joins.",
    steps: [
      { label: "Connect your tools", href: "/settings/connections" },
      { label: "Pick your sources", href: "/settings/sources" },
      { label: "Invite your team", href: "/settings/members" },
    ],
  },
  approver: {
    role: "You are an approver: you approve PRDs and roadmaps before the team builds from them.",
    steps: [
      { label: "Connect your tools", href: "/settings/connections" },
      { label: "Pick your sources", href: "/settings/sources" },
      { label: "See what waits for you", href: "/inbox" },
    ],
  },
  commenter: {
    role: "You are a commenter: you read PRDs and roadmaps, comment on them and add evidence.",
    steps: [
      { label: "Connect your tools", href: "/settings/connections" },
      { label: "Pick your sources", href: "/settings/sources" },
      { label: "Read a PRD and comment", href: "/documents" },
    ],
  },
  viewer: {
    role: "You are a viewer: you read the goals, PRDs and plan, and why each was chosen.",
    steps: [
      { label: "Read the goals", href: "/baseline" },
      { label: "Open a PRD", href: "/documents" },
      { label: "Open the plan", href: "/plan" },
    ],
  },
};

/**
 * Home's welcome for a member who joined through an invite (A1 welcome): drawn first while
 * /v1/setup says so, until they dismiss it (their welcome_dismissed preference). Never an
 * email.
 */
export function WelcomePanel({ onDismiss, busy }: { onDismiss: () => void; busy: boolean }) {
  const { can } = useMe();
  // The words of the most a person may do: change the company's settings (an owner), approve
  // a PRD (an approver), comment (a commenter), else read (a viewer).
  const words: Role = can("put_setting")
    ? "owner"
    : can("approve_version", true)
      ? "approver"
      : can("create_comment")
        ? "commenter"
        : "viewer";
  const copy = COPY[words];
  return (
    <Panel
      title="Welcome to Oracle"
      testId="home-welcome"
      tools={
        <Button variant="ghost" onClick={onDismiss} disabled={busy}>
          Dismiss
        </Button>
      }
    >
      <div className="flex min-w-0 flex-col gap-3 px-4 py-3 max-[600px]:px-3">
        <p className="text-[15px] text-text">
          Oracle keeps the company&apos;s goals, PRDs and plan in one place, each tied to the evidence behind it.
        </p>
        <p data-testid="welcome-role" className="text-[15px] text-text">
          {copy.role}
        </p>
        <ol className="flex flex-col gap-1.5">
          {copy.steps.map((s, i) => (
            <li key={s.href} data-testid="welcome-step" className="flex min-w-0 items-center gap-2.5">
              <span className="tnum grid size-6 flex-none place-items-center rounded-full bg-accent-soft text-[13px] font-bold text-accent-ink">
                {i + 1}
              </span>
              <Link href={s.href} className="min-w-0 truncate font-semibold text-accent-ink hover:underline">
                {s.label}
              </Link>
            </li>
          ))}
        </ol>
      </div>
    </Panel>
  );
}
