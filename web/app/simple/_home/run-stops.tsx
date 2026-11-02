"use client";

import Link from "next/link";

import { Icon } from "@/components/ds/Icon";
import type { Schemas } from "@/lib/api/client";
import { formatInZone, useCompanyZone } from "@/lib/dates";

import { CHECKPOINT_LABEL } from "../../runs/_lib";

/**
 * SW1 "A card per stop" (the owner's pick of Nov 1): a run's stop that waits on me gets its own
 * card on Simple's Home, its one action as the card's button. The stop's own work happens on the
 * run's page in Detailed; the card only says it waits and takes me there.
 */
export type Stop = Schemas["InboxCheckpoint"];

/** The run stops that wait on me (the Inbox's checkpoints I may decide), oldest first. */
export function runStopsOf(inbox: Schemas["InboxOut"] | undefined): Stop[] | undefined {
  return inbox?.checkpoints.filter((c) => c.can_decide && c.status === "pending").sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** The one action a stop asks of me, in plain words. */
const ACTION: Partial<Record<Stop["kind"], string>> = {
  feature_set: "Check the feature set",
  eng_review: "Check the engineering review",
  priority_order: "Set the order",
  prd_review: "Review the PRD",
  eng_dates: "Review the dates",
  roadmap_items: "Check the roadmap items",
  baseline_confirm: "Confirm the baseline",
};

/** What the stop is, in the run page's own words (only "Feature set" is shortened). */
const NAME: Partial<Record<Stop["kind"], string>> = {
  feature_set: "Feature set",
};

export const stopName = (s: Stop) => NAME[s.kind] ?? CHECKPOINT_LABEL[s.kind];
export const stopAction = (s: Stop) => ACTION[s.kind] ?? "Open the stop";
/** What the run is for: its PRD, else the flow. */
export const stopFor = (s: Stop) =>
  s.document_title || (s.document_slug ? `${s.document_slug.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase())} PRD` : s.flow_title || "A run");

/** "Waiting since Tue, Oct 27" in the company's zone. */
function Since({ s }: { s: Stop }) {
  const zone = useCompanyZone();
  return <>Waiting since {formatInZone(s.created_at, zone, { weekday: "short", month: "short", day: "numeric" })}</>;
}

/** One stop's card: what it is, which PRD it is for, how long it has waited, and its one action on the right. */
export function StopCard({ s }: { s: Stop }) {
  return (
    <section aria-label={`${stopName(s)}: ${stopFor(s)}`} data-testid="home-run-stop" className="simple-card">
      <div className="flex flex-wrap items-center gap-3">
        <span aria-hidden className="grid size-9 flex-none place-items-center rounded-full bg-warn-bg text-warn">
          <Icon name="runs" size={20} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="simple-h2 break-words">
            {stopName(s)} <span className="font-normal text-text2">· {stopFor(s)}</span>
          </h2>
          <p className="simple-small">
            A run waits on you to go on. <Since s={s} />
          </p>
        </div>
        <Link href={`/runs/${s.run_id}`} className="simple-button simple-button-primary max-[600px]:w-full max-[600px]:justify-center">
          {stopAction(s)}
        </Link>
      </div>
    </section>
  );
}
