"use client";

import { useState } from "react";

import { Button, toast } from "@/components/ds";
import { api, type Schemas } from "@/lib/api/client";

import { shortDay } from "./_lib";

type Old = Schemas["SimpleOldMilestones"];
type Row = Schemas["SimpleOldMilestone"];

/** "Nov 20", with its year when not this year's ("Jan 9, 2027"). */
const dayWords = (day: string | null | undefined, today: string) =>
  !day
    ? "No date"
    : day.slice(0, 4) === today.slice(0, 4)
      ? shortDay(day)
      : `${shortDay(day)}, ${day.slice(0, 4)}`;

/** The old milestones an owner still has a call on (none of their items are left): for the tray's count. */
export const oldToDecide = (old: Old | undefined): Row[] =>
  old?.can_act ? old.needs_call : [];

/**
 * old-milestones (the owner, Nov 4: "Move them over"): goal milestones still on the older
 * per-PRD roadmaps, brought onto the company roadmap by an owner (POST
 * /v1/simple/roadmap/milestones/carry-over), with what moves shown first. One none of whose
 * items are left asks Keep or Drop. Anyone but an owner sees nothing here (``can_act``).
 * ``tray``: the Needs a decision list, the Keep or Drop rows alone.
 */
export function OldMilestones({
  old,
  today,
  onDone,
  tray = false,
}: {
  old: Old | undefined;
  today: string;
  onDone: () => Promise<void> | void;
  tray?: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  if (!old?.can_act) return null;
  const { moves, needs_call } = old;
  if ((tray || !moves.length) && !needs_call.length) return null;

  const run = async (
    key: string,
    call: () => Promise<{
      error?: unknown;
      data?: Schemas["SimpleOldMilestonesResult"];
    }>,
    said: (r: Schemas["SimpleOldMilestonesResult"]) => string,
  ) => {
    setBusy(key);
    try {
      const r = await call();
      if (r.error || !r.data) {
        toast({ place: "corner", message: "That did not work. Try again." });
        return;
      }
      toast({ place: "corner", message: said(r.data) });
      await onDone();
    } finally {
      setBusy(null);
    }
  };
  const bring = () =>
    run(
      "all",
      () => api.POST("/v1/simple/roadmap/milestones/carry-over"),
      (r) =>
        r.carried.length === 1
          ? "Brought 1 old milestone over"
          : `Brought ${r.carried.length} old milestones over`,
    );
  const decide = (m: Row, how: "keep" | "drop") =>
    run(
      m.id,
      () =>
        api.POST(
          how === "keep"
            ? "/v1/simple/roadmap/milestones/{milestone_id}/keep"
            : "/v1/simple/roadmap/milestones/{milestone_id}/drop",
          { params: { path: { milestone_id: m.id } } },
        ),
      () =>
        how === "keep"
          ? `Kept '${m.name}' on the company roadmap`
          : `Dropped '${m.name}'`,
    );
  const line = (m: Row) => (
    <span className="min-w-0 flex-1 text-[15px]">
      <span className="font-medium">{m.name}</span>
      <span className="text-text2">
        {" "}
        · {dayWords(m.date, today)}
        {m.goal_title ? ` · ${m.goal_title}` : ""}
      </span>
      <span className="block text-sm text-text2">
        From {m.from_roadmap.title}
      </span>
    </span>
  );
  const asks = needs_call.length > 0 && (
    <ul className="mt-1" aria-label="Old milestones with no items left">
      {needs_call.map((m) => (
        <li
          key={m.id}
          className="flex flex-wrap items-center gap-2 py-1.5"
          data-testid="old-milestone-ask"
          data-name={m.name}
        >
          {line(m)}
          <span className="block w-full text-sm text-text2">
            Old milestone with no items left: Keep or Drop
          </span>
          <Button
            aria-label={`Keep ${m.name}`}
            disabled={busy !== null}
            onClick={() => void decide(m, "keep")}
          >
            Keep
          </Button>
          <Button
            variant="ghost"
            aria-label={`Drop ${m.name}`}
            disabled={busy !== null}
            onClick={() => void decide(m, "drop")}
          >
            Drop
          </Button>
        </li>
      ))}
    </ul>
  );
  if (tray)
    return (
      <section className="mt-4" data-testid="tray-old-milestones">
        <h3 className="font-semibold">Old milestones</h3>
        {asks}
      </section>
    );
  return (
    <section
      className="mt-3 border-t border-line pt-3"
      data-testid="old-milestones"
    >
      <h3 className="text-sm font-semibold">Old milestones</h3>
      {moves.length > 0 && (
        <div data-testid="old-milestones-preview">
          <p className="mt-1 text-sm text-text2">
            {moves.length === 1 ? "1 milestone" : `${moves.length} milestones`}{" "}
            from older roadmaps will move to the company roadmap, with the items
            they wait on:
          </p>
          <ul className="mt-1" aria-label="Old milestones that move">
            {moves.map((m) => (
              <li
                key={m.id}
                className="flex flex-wrap gap-2 py-1"
                data-testid="old-milestone-move"
                data-name={m.name}
              >
                {line(m)}
                <span
                  className="block w-full text-sm text-text2"
                  data-testid="old-milestone-items"
                >
                  {m.items.length
                    ? `Waits on ${m.items.join(", ")}`
                    : "Waits on no items"}
                </span>
              </li>
            ))}
          </ul>
          {needs_call.length > 0 && (
            <p className="mt-1 text-sm text-text2">
              {needs_call.length === 1
                ? "1 needs your call"
                : `${needs_call.length} need your call`}
              : none of their items are left.
            </p>
          )}
          <div className="mt-2 flex justify-end">
            <Button
              variant="solid"
              disabled={busy !== null}
              onClick={() => void bring()}
            >
              Bring old milestones over
            </Button>
          </div>
        </div>
      )}
      {asks}
    </section>
  );
}
