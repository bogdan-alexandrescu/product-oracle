"use client";

// tb-mk (the owner's pick C, "Name, goal, health tick"): the Roadmap's bands are its tracks, in
// the tracks' own order, then No track, then Below the line. Each band's header names the
// track and its goal, then its health as a tick (on track) or a warning mark (at risk, or not
// checked lately) whose tooltip says why; pointing at the name shows its owner and PRDs.

import { InfoTip } from "@/components/ds";

import type { Roadmap } from "./_lib";

export type Track = Roadmap["tracks"][number];

/** The roadmap's items in one group per track, in the tracks' order, then "No track". */
export function trackLaned(data: Roadmap): Roadmap {
  const tracks = data.tracks ?? [];
  const known = new Set(tracks.map((t) => t.id));
  // A track the read names on an item but not in its tracks keeps a band, after the known ones.
  const extra = new Map<string, string>();
  for (const i of data.items) if (i.track && !known.has(i.track.id)) extra.set(i.track.id, i.track.title);
  const order = [...tracks.map((t) => [t.id, t.title] as const), ...extra.entries()];
  const groups = order.map(([id, title]) => ({ key: id, title, item_ids: data.items.filter((i) => i.track?.id === id).map((i) => i.id) }));
  groups.push({ key: "none", title: "No track", item_ids: data.items.filter((i) => !i.track).map((i) => i.id) });
  return { ...data, group: "track", groups: groups.filter((g) => g.item_ids.length) };
}

function Mark({ t }: { t: Track }) {
  return t.health === "on_track" ? (
    <span className="font-bold text-pass">
      <span aria-hidden>✓</span>
      <span className="sr-only">On track</span>
    </span>
  ) : (
    <span className="font-bold text-warn">
      <span aria-hidden>⚠</span>
      <span className="sr-only">Needs a look</span>
    </span>
  );
}

/** A track band's header (`stack`: the Gantt's two lines, the goal under the name). */
export function TrackHead({ data, laneKey, title, stack = false }: { data: Roadmap; laneKey: string; title: string; stack?: boolean }) {
  const t = (data.tracks ?? []).find((x) => x.id === laneKey);
  if (!t) return <span className={`truncate font-semibold ${stack ? "text-[15px] leading-[18px]" : ""}`}>{title}</span>;
  const name = <span className="truncate font-semibold">{t.title}</span>;
  const prds = t.prds.map((p) => p.title).join(", ");
  const nameTip = (
    <InfoTip label={t.title} align="start" side="bottom" testId="track-name-tip" trigger={name}>
      <span className="block font-semibold">{t.title}</span>
      <span className="block">Owner: {t.owner_name ?? "none"}</span>
      <span className="block">PRD: {prds || "none"}</span>
    </InfoTip>
  );
  const health = (
    <span data-testid="track-health" data-health={t.health}>
      <InfoTip label={t.health === "on_track" ? "On track" : "Needs a look"} align="start" side="bottom" testId="track-health-tip" trigger={<Mark t={t} />}>
        {t.health_reason}
      </InfoTip>
    </span>
  );
  if (stack)
    return (
      <>
        <span data-testid="track-head" className="pointer-events-auto flex min-w-0 items-center gap-1.5 text-[15px] leading-[18px]">
          {nameTip}
          {health}
        </span>
        {t.goal_name && <span className="truncate text-xs leading-[15px] text-text2">{t.goal_name}</span>}
      </>
    );
  return (
    <span data-testid="track-head" className="pointer-events-auto inline-flex items-center gap-1.5">
      {nameTip}
      {t.goal_name && <span className="font-normal text-text2">· {t.goal_name}</span>}
      {health}
    </span>
  );
}
