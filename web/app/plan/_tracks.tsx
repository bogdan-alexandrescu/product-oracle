"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { peopleByIds, PersonPicker } from "@/components/PersonPicker";
import { FIELD_LABEL, InlineError } from "@/components/review/parts";
import {
  Button,
  Chip,
  Inspector,
  InspectorSection,
  Notice,
  Panel,
  SegmentedControl,
  type ChipKind,
} from "@/components/ds";
import { INPUT } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { calendarDay } from "@/lib/dates";
import { formatDay } from "@/lib/format";
import { errorMessage, useQuery, type Query } from "@/lib/use-query";

import { HORIZON_LABEL, HORIZONS, type Horizon } from "./_lib";

export type Track = Schemas["TrackOverview"];
type Milestone = Schemas["MilestoneOut"];
type Status = Track["status"];
type MilestoneStatus = Milestone["status"];

/** Which milestone the inspector edits; `id` null adds a new one to the track. */
export type MilestonePick = { trackId: string; id: string | null };

export const READ_ONLY = "Changing a track needs the approver role.";

const STATUS_LABEL: Record<Status, string> = {
  active: "Active",
  paused: "Paused",
  closed: "Closed",
};
const MILESTONE_STATUS: Record<
  MilestoneStatus,
  { kind: ChipKind; label: string }
> = {
  planned: { kind: "na", label: "Planned" },
  done: { kind: "pass", label: "Done" },
  dropped: { kind: "line", label: "Dropped" },
};
const HEALTH: Record<Track["health"], { kind: ChipKind; label: string }> = {
  on_track: { kind: "pass", label: "On track" },
  at_risk: { kind: "warn", label: "At risk" },
  off_track: { kind: "crit", label: "Off track" },
  no_roadmap: { kind: "na", label: "No roadmap" },
  paused: { kind: "na", label: "Paused" },
  closed: { kind: "na", label: "Closed" },
};

/** Every track with its overview (owner, status, health and milestones). */
export function useTracks(): Query<Track[]> {
  return useQuery("plan|tracks", async () => {
    const rows = await unwrap(api.GET("/v1/tracks"));
    return Promise.all(
      rows.map((t) =>
        unwrap(
          api.GET("/v1/tracks/{track_id}", {
            params: { path: { track_id: t.id } },
          }),
        ),
      ),
    );
  });
}

const day = (d: string) => calendarDay(d);

/** A track's milestones in the API's order: dated first by date, then by when they were added. */
export function sortedMilestones(t: Track): Milestone[] {
  return [...t.milestones].sort(
    (a, b) =>
      (a.target_date ? 0 : 1) - (b.target_date ? 0 : 1) ||
      (a.target_date ?? "").localeCompare(b.target_date ?? "") ||
      a.created_at.localeCompare(b.created_at),
  );
}

/** "M1 · Oct 19 – Nov 13" (#306): from the previous dated milestone (or the track's start) to this one's date. */
export function milestoneTitle(t: Track, id: string): string {
  const ms = sortedMilestones(t);
  const at = ms.findIndex((m) => m.id === id);
  const m = ms[at];
  if (!m) return "New milestone";
  const n = `M${at + 1}`;
  if (!m.target_date) return `${n} · no date`;
  const prev = ms
    .slice(0, at)
    .filter((x) => x.target_date)
    .pop()?.target_date;
  return `${n} · ${prev ? day(prev) : formatDay(t.created_at)} – ${day(m.target_date)}`;
}

/** What the viewer's role may do to a track, one flag per operation (#370: `can()`). */
export type TrackRights = {
  edit: boolean;
  addMilestone: boolean;
  check: boolean;
  draftRoadmap: boolean;
  push: boolean;
};

/**
 * A PRD's track (#339): title, owner and status edited in place, its milestones, and its
 * actions. #370 (#505): a control shows only to a role that can use it.
 */
export function TrackPanel({
  track,
  may,
  picked,
  onPick,
  onChange,
}: {
  track: Track;
  may: TrackRights;
  picked: MilestonePick | null;
  onPick: (pick: MilestonePick) => void;
  onChange: (t: Track) => void;
}) {
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(track.title);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    tone: "pass" | "warn";
    text: string;
  } | null>(null);
  const owner = useQuery(`plan|track-owner|${track.owner_id ?? ""}`, () =>
    peopleByIds([track.owner_id]),
  );
  const ownerName = track.owner_id
    ? owner.data?.get(track.owner_id)
    : undefined;
  const health = HEALTH[track.health];
  const off = busy;
  const actions = may.check || may.draftRoadmap || may.push;

  async function act<T>(call: () => Promise<T>, done: (out: T) => void) {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      done(await call());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const patch = (
    body: Omit<Schemas["TrackPatch"], "lock_version">,
    then?: () => void,
  ) =>
    act(
      () =>
        unwrap(
          api.PATCH("/v1/tracks/{track_id}", {
            params: { path: { track_id: track.id } },
            body: { ...body, lock_version: track.lock_version },
          }),
        ),
      (t) => {
        onChange(t);
        then?.();
      },
    );
  const path = { params: { path: { track_id: track.id } } };

  return (
    <Panel
      title={
        <span data-testid="track-title" className="break-words">
          {track.title}
        </span>
      }
      testId="plan-track"
      tools={
        <>
          <Chip kind={health.kind} data-testid="track-health">
            {health.label}
          </Chip>
          {may.edit && (
            <Button
              variant="ghost"
              disabled={off}
              onClick={() => setRenaming(true)}
            >
              Rename
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3 px-4 py-3 text-[15px] max-[600px]:px-3">
        {renaming && may.edit && (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (title.trim())
                void patch({ title: title.trim() }, () => setRenaming(false));
            }}
          >
            <label className={`${FIELD_LABEL} min-w-0 flex-1`}>
              Track title
              <input
                className={INPUT}
                value={title}
                maxLength={300}
                onChange={(e) => setTitle(e.target.value)}
                autoFocus
              />
            </label>
            <Button
              type="submit"
              variant="solid"
              disabled={off || !title.trim()}
            >
              Save
            </Button>
            <Button variant="ghost" onClick={() => setRenaming(false)}>
              Cancel
            </Button>
          </form>
        )}
        <p className="text-text2">{track.headline}</p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="flex min-w-0 items-center gap-2">
            <span className="text-[13px] font-semibold text-text2">Owner</span>
            <span
              data-testid="track-owner"
              className="min-w-0 truncate font-semibold"
            >
              {ownerName
                ? `${ownerName.name} · ${ownerName.email}`
                : track.owner_id
                  ? "…"
                  : "No owner"}
            </span>
            {may.edit && (
              <Button
                variant="ghost"
                disabled={off}
                onClick={() => setPicking((v) => !v)}
              >
                Change owner
              </Button>
            )}
          </span>
          {may.edit ? (
            <SegmentedControl<Status>
              label="Track status"
              size="sm"
              value={track.status}
              onChange={(status) =>
                status !== track.status && void patch({ status })
              }
              items={(["active", "paused", "closed"] as const).map((s) => ({
                value: s,
                label: STATUS_LABEL[s],
                disabled: off,
              }))}
            />
          ) : (
            <span data-testid="track-status" className="text-sm text-text2">
              {STATUS_LABEL[track.status]}
            </span>
          )}
        </div>
        {picking && may.edit && (
          <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface2 p-2.5">
            <PersonPicker
              writersOnly={false}
              autoFocus
              onPick={(p) =>
                void patch({ owner_id: p.user_id }, () => setPicking(false))
              }
            />
            {track.owner_id && (
              <Button
                variant="ghost"
                className="self-start"
                onClick={() =>
                  void patch({ owner_id: null }, () => setPicking(false))
                }
              >
                No owner
              </Button>
            )}
          </div>
        )}
      </div>
      <div className="border-t border-line">
        <div className="flex items-center gap-2 px-4 pt-3 pb-1 max-[600px]:px-3">
          <span className="text-[13px] font-semibold tracking-[0.02em] text-text2">
            Milestones
          </span>
          {may.addMilestone && (
            <Button
              variant="ghost"
              icon="plus"
              className="ml-auto"
              disabled={off}
              onClick={() => onPick({ trackId: track.id, id: null })}
            >
              Add milestone
            </Button>
          )}
        </div>
        <ul className="flex flex-col pb-2">
          {sortedMilestones(track).map((m) => {
            const on = picked?.trackId === track.id && picked.id === m.id;
            const st = MILESTONE_STATUS[m.status];
            return (
              <li key={m.id}>
                <button
                  type="button"
                  data-testid="track-milestone"
                  aria-pressed={on}
                  onClick={() => onPick({ trackId: track.id, id: m.id })}
                  className={`flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-left hover:bg-surface2 max-[600px]:px-3 ${on ? "bg-accent-soft" : ""}`}
                >
                  <span
                    data-testid="milestone-title"
                    className="tnum flex-none font-semibold"
                  >
                    {milestoneTitle(track, m.id)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{m.name}</span>
                  <span className="flex-none text-sm text-text2">
                    {HORIZON_LABEL[m.horizon]} · {m.item_keys.length}{" "}
                    {m.item_keys.length === 1 ? "item" : "items"}
                  </span>
                  <Chip kind={st.kind} data-testid="milestone-status">
                    {st.label}
                  </Chip>
                </button>
              </li>
            );
          })}
          {track.milestones.length === 0 && (
            <li className="px-4 py-2 text-text2">No milestones</li>
          )}
        </ul>
      </div>
      {(actions || result || error) && (
        <div className="flex flex-col gap-2 border-t border-line px-4 py-3 max-[600px]:px-3">
          {actions && (
            <div className="flex flex-wrap gap-2">
              {may.check && (
                <Button
                  disabled={off}
                  onClick={() =>
                    void act(
                      () => unwrap(api.POST("/v1/tracks/{track_id}/monitor", path)),
                      (out) => {
                        onChange(out.overview);
                        setResult({
                          tone: "pass",
                          text: `Checked: ${out.changed.length ? `changed ${out.changed.join(", ").replaceAll("_", " ")}` : "nothing changed"}.`,
                        });
                      },
                    )
                  }
                >
                  Check now
                </Button>
              )}
              {may.draftRoadmap && (
                <Button
                  disabled={off}
                  onClick={() =>
                    void act(
                      () =>
                        unwrap(api.POST("/v1/tracks/{track_id}/roadmap-run", path)),
                      (run) => router.push(`/runs/${run.id}`),
                    )
                  }
                >
                  Draft roadmap from this track
                </Button>
              )}
              {may.push && (
                <Button
                  disabled={off}
                  onClick={async () => {
                    setBusy(true);
                    setError(null);
                    setResult(null);
                    try {
                      await unwrap(
                        api.POST("/v1/tracks/{track_id}/tracker-push", path),
                      );
                      setResult({ tone: "pass", text: "Sent to the tracker." });
                    } catch (e) {
                      setResult({ tone: "warn", text: errorMessage(e) });
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Push to tracker
                </Button>
              )}
            </div>
          )}
          {result && (
            <Notice tone={result.tone} testId="track-result">
              {result.text}
            </Notice>
          )}
          {error && <InlineError>{error}</InlineError>}
        </div>
      )}
    </Panel>
  );
}

/** The milestone editor in the Plan inspector (#339): name, horizon, date with its verified bases, items and status. */
export function MilestoneEditor({
  track,
  milestoneId,
  canWrite,
  onSaved,
}: {
  track: Track;
  milestoneId: string | null;
  canWrite: boolean;
  onSaved: (m: Milestone) => void;
}) {
  const m = track.milestones.find((x) => x.id === milestoneId) ?? null;
  const [name, setName] = useState(m?.name ?? "");
  const [horizon, setHorizon] = useState<Horizon>(m?.horizon ?? "now");
  const [date, setDate] = useState(m?.target_date ?? "");
  const [basisIds, setBasisIds] = useState<string[]>(m?.basis_ids ?? []);
  const [itemKeys, setItemKeys] = useState<string[]>(m?.item_keys ?? []);
  const [status, setStatus] = useState<MilestoneStatus>(m?.status ?? "planned");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bases = useQuery(`plan|bases|${track.prd.slug}`, () =>
    unwrap(
      api.GET("/v1/schedule-bases", {
        params: { query: { prd: track.prd.slug, status: "verified" } },
      }),
    ),
  );
  const roadmap = track.roadmap?.slug;
  const items = useQuery(`plan|track-items|${roadmap ?? ""}`, () =>
    roadmap
      ? unwrap(
          api.GET("/v1/roadmaps/{doc}/items", {
            params: { path: { doc: roadmap } },
          }),
        ).then((r) => r.items)
      : Promise.resolve([]),
  );
  const supporting = (bases.data ?? []).filter(
    (b) => date && b.supports_date === date,
  );
  // A new date picks the verified bases that support exactly it.
  const pickDate = (d: string) => {
    setDate(d);
    setBasisIds(
      (bases.data ?? []).filter((b) => b.supports_date === d).map((b) => b.id),
    );
  };

  const off = !canWrite || busy;
  const toggle = (list: string[], key: string, on: boolean) =>
    on ? [...list, key] : list.filter((k) => k !== key);

  async function save() {
    setBusy(true);
    setError(null);
    const fields = {
      name: name.trim(),
      horizon,
      target_date: date || null,
      basis_ids: date ? basisIds : [],
      item_keys: itemKeys,
    };
    try {
      const out = m
        ? await unwrap(
            api.PATCH("/v1/milestones/{milestone_id}", {
              params: { path: { milestone_id: m.id } },
              body: { ...fields, status, lock_version: m.lock_version },
            }),
          )
        : await unwrap(
            api.POST("/v1/tracks/{track_id}/milestones", {
              params: { path: { track_id: track.id } },
              body: fields,
            }),
          );
      onSaved(out);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Inspector
      eyebrow="Milestone · selected"
      title={m ? milestoneTitle(track, m.id) : "New milestone"}
      label={m ? `Milestone ${m.name}` : "New milestone"}
      testId="plan-milestone"
      chips={<Chip hero>{track.title}</Chip>}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <InspectorSection>
          <div className="flex flex-col gap-3">
            <label className={FIELD_LABEL}>
              Name
              <input
                className={INPUT}
                value={name}
                maxLength={200}
                disabled={off}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <div className={FIELD_LABEL}>
              Horizon
              <SegmentedControl<Horizon>
                label="Horizon"
                size="sm"
                value={horizon}
                onChange={setHorizon}
                items={HORIZONS.map((h) => ({
                  value: h,
                  label: HORIZON_LABEL[h],
                  disabled: off,
                }))}
              />
            </div>
            <label className={FIELD_LABEL}>
              Date
              <input
                type="date"
                className={INPUT}
                value={date}
                disabled={off}
                onChange={(e) => pickDate(e.target.value)}
              />
            </label>
            {date &&
              (supporting.length ? (
                <fieldset className="flex flex-col gap-1">
                  <legend className="text-[13px] font-semibold text-text2">
                    Verified by
                  </legend>
                  {supporting.map((b) => (
                    <label
                      key={b.id}
                      className="flex items-center gap-2 text-[15px]"
                    >
                      <input
                        type="checkbox"
                        checked={basisIds.includes(b.id)}
                        disabled={off}
                        onChange={(e) =>
                          setBasisIds((ids) =>
                            toggle(ids, b.id, e.target.checked),
                          )
                        }
                      />
                      {b.reference} · {b.kind}
                    </label>
                  ))}
                </fieldset>
              ) : (
                <p
                  data-testid="milestone-no-basis"
                  className="text-sm text-warn"
                >
                  No verified estimate, capacity or commitment supports this
                  date. Oracle never invents dates.
                </p>
              ))}
            {m && (
              <div className={FIELD_LABEL}>
                Status
                <SegmentedControl<MilestoneStatus>
                  label="Milestone status"
                  size="sm"
                  value={status}
                  onChange={setStatus}
                  items={(["planned", "done", "dropped"] as const).map((s) => ({
                    value: s,
                    label: MILESTONE_STATUS[s].label,
                    disabled: off,
                  }))}
                />
              </div>
            )}
          </div>
        </InspectorSection>
        <InspectorSection label="Items">
          <div
            role="group"
            aria-label="Items"
            className="flex max-h-60 flex-col gap-1 overflow-y-auto"
          >
            {items.error && <span className="text-text2">{items.error}</span>}
            {items.data?.length === 0 && (
              <span className="text-text2">No roadmap items yet</span>
            )}
            {items.data?.map((i) => (
              <label
                key={i.item_key}
                className="flex min-w-0 items-center gap-2 text-[15px]"
              >
                <input
                  type="checkbox"
                  checked={itemKeys.includes(i.item_key)}
                  disabled={off}
                  onChange={(e) =>
                    setItemKeys((keys) =>
                      toggle(keys, i.item_key, e.target.checked),
                    )
                  }
                />
                <span className="min-w-0 flex-1 truncate">{i.title}</span>
                <span className="flex-none text-sm text-text2">
                  {HORIZON_LABEL[i.horizon]}
                </span>
              </label>
            ))}
          </div>
        </InspectorSection>
        <InspectorSection>
          <div className="flex flex-col gap-2">
            <Button
              type="submit"
              variant="solid"
              className="self-start"
              disabled={off || !name.trim()}
              title={canWrite ? undefined : READ_ONLY}
            >
              {m ? "Save milestone" : "Add milestone"}
            </Button>
            {error && <InlineError>{error}</InlineError>}
            {!canWrite && <p className="text-sm text-text2">{READ_ONLY}</p>}
          </div>
        </InspectorSection>
      </form>
    </Inspector>
  );
}
