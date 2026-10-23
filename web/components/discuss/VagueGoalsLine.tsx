"use client";

import Link from "next/link";

import { Icon, InfoTip } from "@/components/ds";

export const INTERVIEW_TIP = "Oracle asks one question at a time and proposes measurable versions. Nothing runs until you start.";

/**
 * B6 after a baseline review: "2 goals are not measurable · Interview" (commenters and up;
 * nothing at 0). Interview links to `href`, or calls `onInterview`; nothing starts before.
 */
export function VagueGoalsLine({ count, href, onInterview, busy = false }: { count: number; href?: string; onInterview?: () => void; busy?: boolean }) {
  if (count <= 0) return null;
  const action = "font-semibold text-accent-ink hover:underline disabled:opacity-70";
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-text" data-testid="vague-goals-line">
      <Icon name="ask" size={16} className="flex-none text-warn" />
      <span>
        {count === 1 ? "1 goal is not measurable" : `${count} goals are not measurable`} ·{" "}
        {href ? (
          <Link href={href} className={action}>
            Interview
          </Link>
        ) : (
          <button type="button" className={action} disabled={busy} onClick={onInterview}>
            Interview
          </button>
        )}
      </span>
      <InfoTip label="the goals interview" align="start">
        {INTERVIEW_TIP}
      </InfoTip>
    </div>
  );
}
