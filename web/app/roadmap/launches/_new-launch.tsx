"use client";

import { useState } from "react";

import { Button, Chip, Dialog } from "@/components/ds";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { errorMessage, useQuery } from "@/lib/use-query";

type Track = Schemas["TrackSummary"];
type Item = Schemas["RoadmapItemOut"];

const HORIZON: Record<string, string> = { now: "Now", next: "Next", later: "Later" };

/** The track's approved roadmap, the one launches are planned from (null until one is approved). */
const approvedRoadmap = (t: Track | undefined) => (t?.roadmap?.approved && t.roadmap.version ? t.roadmap : null);

/**
 * New launch (#344): plan a launch by hand that groups one or more items of a track's latest
 * approved roadmap. The name starts as the first item's title until a person writes their own.
 */
export function NewLaunchDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (launch: Schemas["LaunchOut"]) => Promise<void> }) {
  const tracksQ = useQuery("new-launch-tracks", () => unwrap(api.GET("/v1/tracks")));
  const tracks = tracksQ.data ?? [];
  const [trackId, setTrackId] = useState<string | null>(null);
  const track = tracks.find((t) => t.id === trackId) ?? tracks.find((t) => approvedRoadmap(t)) ?? tracks[0];
  const roadmap = approvedRoadmap(track);
  const itemsQ = useQuery(`new-launch-items|${roadmap?.slug ?? ""}|${roadmap?.version ?? ""}`, async (): Promise<Item[]> => {
    if (!roadmap) return [];
    const out = await unwrap(
      api.GET("/v1/roadmaps/{doc}/items", { params: { path: { doc: roadmap.slug }, query: { version: roadmap.version!, view: "brief" } } }),
    );
    return out.items;
  });
  const [picked, setPicked] = useState<string[]>([]);
  const [customName, setCustomName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const items = itemsQ.data ?? [];
  const firstTitle = items.find((i) => i.item_key === picked[0])?.title ?? "";
  const name = customName ?? firstTitle;

  function toggle(key: string, on: boolean) {
    // Keep the roadmap's order, so the first item (and the default name) is the topmost picked.
    setPicked((p) => items.map((i) => i.item_key).filter((k) => (k === key ? on : p.includes(k))));
  }

  async function create() {
    if (!track) return;
    setBusy(true);
    setError(null);
    try {
      const launch = await unwrap(api.POST("/v1/launches", { body: { title: name.trim(), track_id: track.id, item_keys: picked } }));
      await onCreated(launch);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  const problem = error ?? tracksQ.error ?? itemsQ.error;
  const canSubmit = !!track && picked.length > 0 && !!name.trim();

  return (
    <Dialog
      title="New launch"
      testId="new-launch-dialog"
      dirty={picked.length > 0 || customName !== null}
      onClose={onClose}
      onSubmit={() => {
        if (canSubmit && !busy) void create();
      }}
      actions={
        <Button type="submit" variant="primary" disabled={busy || !canSubmit}>
          {busy ? "Creating…" : "Create launch"}
        </Button>
      }
    >
      {tracks.length > 1 && (
        <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
          Track
          <select
            className={INPUT}
            value={track?.id ?? ""}
            onChange={(e) => {
              setTrackId(e.target.value);
              setPicked([]);
            }}
          >
            {tracks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </label>
      )}
      <fieldset className="flex min-w-0 flex-col gap-1.5">
        <legend className="mb-1 text-sm font-semibold text-text2">
          Items{roadmap ? ` · ${roadmap.title} v${roadmap.version}` : ""}
        </legend>
        {tracksQ.data && !track && <p className="text-sm text-text2">No product track yet. Start one from a PRD to plan launches.</p>}
        {track && !roadmap && <p className="text-sm text-text2">This track has no approved roadmap yet. Launches group items of an approved roadmap.</p>}
        {roadmap && itemsQ.data && items.length === 0 && <p className="text-sm text-text2">The approved roadmap has no items.</p>}
        <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {items.map((i) => (
            <li key={i.item_key}>
              <label
                data-testid="launch-item-option"
                className={`flex min-w-0 cursor-pointer items-center gap-2.5 rounded-button border px-3 py-2 ${
                  picked.includes(i.item_key) ? "border-accent bg-accent-soft" : "border-line bg-surface hover:border-line-strong"
                }`}
              >
                <input type="checkbox" checked={picked.includes(i.item_key)} onChange={(e) => toggle(i.item_key, e.target.checked)} />
                <span className="min-w-0 flex-1 truncate font-medium" data-testid="launch-item-title" title={i.title}>
                  {i.title}
                </span>
                <Chip kind="line">{HORIZON[i.horizon] ?? i.horizon}</Chip>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
        Name
        <input className={INPUT} value={name} maxLength={300} onChange={(e) => setCustomName(e.target.value)} />
      </label>
      <p className="text-sm text-text2">
        The launch starts Planned with Oracle&apos;s suggested tier and its checklist. It is ready when the items&apos; tracker issues or
        milestones are done.
      </p>
      {problem && <ErrorNote>{problem}</ErrorNote>}
    </Dialog>
  );
}
