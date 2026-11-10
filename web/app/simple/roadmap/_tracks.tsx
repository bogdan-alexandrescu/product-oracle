"use client";

import { useMemo, useState } from "react";

import { Button, Sheet, toast } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useQuery } from "@/lib/use-query";

import { ChangeFailed, propose, undo, type Item } from "./_lib";

type Track = Schemas["SimpleTrackRow"];
type Status = Track["status"];

const STATE: Record<Status, string> = { active: "Active", paused: "Paused", closed: "Closed" };
const FIELD = "h-9 w-full rounded-lg border border-line bg-surface px-2.5 text-[15px] outline-none focus:border-accent";
const PRIMARY = "inline-flex h-8 items-center gap-1 rounded-lg bg-accent px-3 text-sm font-medium text-on-accent hover:brightness-110 disabled:opacity-50";
const ROW = "grid grid-cols-[84px_minmax(0,1fr)] items-center gap-2 py-1";

/** What a proposal asks, as its toast names it ("Rename proposed · waits for …"). */
function asking(after: Record<string, string | string[] | null>): string {
  if ("to" in after) return "Move";
  if ("title" in after) return "Rename";
  if ("owner_id" in after) return "Owner change";
  if ("goal_id" in after) return "Goal change";
  if ("prd_id" in after || "prd_ids" in after || "add_prd_id" in after || "remove_prd_id" in after) return "PRD change";
  return after.status === "paused" ? "Pause" : after.status === "closed" ? "Close" : "Resume";
}

/** The proposer takes a proposal back (the Tracks sheet's toasts, the Removed list's too). */
export async function withdraw(id: string): Promise<void> {
  const { error } = await api.POST("/v1/simple/changes/{change_id}/withdraw", { params: { path: { change_id: id } } });
  const detail = (error as { detail?: unknown } | undefined)?.detail;
  if (error) throw new ChangeFailed(typeof detail === "string" ? detail : "Oracle could not withdraw it", 409);
}

const features = (n: number) => `${n} ${n === 1 ? "feature" : "features"}`;
/** The Move to Trash confirm: its live features, then the cut or merged ones it moves too. */
const movesLine = (live: number, moves: number) => {
  const closed = moves - live;
  const what = !closed ? features(live) : live ? `${features(live)} and ${closed} cut or merged` : `${closed} cut or merged ${closed === 1 ? "feature" : "features"}`;
  return `Its ${what} ${moves === 1 ? "moves" : "move"} to No track.`;
};

/** A short stamp of the roadmap's items: the sheet reads its tracks again when the roadmap reloads. */
function stampOf(items: Item[]): string {
  let h = 0;
  for (const i of items) for (const c of `${i.id}:${i.track?.id ?? ""}:${i.status};`) h = (h * 31 + c.charCodeAt(0)) | 0;
  return `${items.length}.${h}`;
}

/**
 * removed-tracks (et B): "Tracks · N" beside the roadmap's filters opens a sheet of every track
 * (paused, closed and empty ones too) with its owner, state and features; a row opens to Name,
 * Owner, State, Move up and Move down (track-order: the company's track order) and Move to Trash;
 * "+ Add track" in its head. One who does not decide proposes.
 */
export function TracksButton({ items, canChange, onChanged }: { items: Item[]; canChange: boolean; onChanged: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [n, setN] = useState(0);
  // A track's count is the API's, over the whole roadmap: never the filtered items on screen.
  const stamp = useMemo(() => stampOf(items), [items]);
  const q = useQuery(`simple-tracks:${n}:${stamp}`, () => unwrap(api.GET("/v1/simple/tracks")), { keepPrevious: true });
  const [opened, setOpened] = useState<string | null>(null);
  const [trashing, setTrashing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [moving, setMoving] = useState(false);
  const data = q.data;
  const tracks = data?.tracks ?? [];
  const refresh = async () => {
    setN((x) => x + 1);
    await onChanged();
  };
  const failed = (fallback: string) => (e: unknown) => toast({ message: e instanceof ChangeFailed ? e.message : fallback });
  const takeBack = async (id: string, title: string) => {
    const res = await undo(id);
    await refresh();
    // Undo of an add never deletes a track that holds something since: it goes to Trash.
    if ((res.change.after as { in_trash?: boolean } | null)?.in_trash) toast({ message: `Moved ${title} to Trash, as it holds work now` });
  };
  const send = async (body: Schemas["SimpleChangeIn"], done: string, decider: string | null, asked = "Change", title = "") => {
    try {
      const res = await propose(body);
      await refresh();
      if (res.change.status === "applied")
        toast({ message: done, action: res.change.can_undo ? { label: "Undo", onClick: () => void takeBack(res.change.id, title).catch(failed("Oracle could not undo it")) } : undefined });
      else
        toast({
          message: `${asked} proposed · waits for ${decider ?? "an owner"}`,
          action: { label: "Withdraw", onClick: () => void withdraw(res.change.id).then(() => (toast({ message: "Withdrawn" }), refresh()), failed("Oracle could not withdraw it")) },
        });
      return true;
    } catch (e) {
      toast({ message: e instanceof ChangeFailed ? e.message : "Oracle could not change the track" });
      return false;
    }
  };
  const edit = (t: Track, after: Record<string, string | string[] | null>, done: string) =>
    send({ op: "edit_track", target: { track_id: t.id }, before: {}, after } as Schemas["SimpleChangeIn"], done, t.decider_name ?? null, asking(after), t.title);
  // track-order: one step up or down the company's track order per press, as the One-pagers rows' PRD order.
  const move = (t: Track, to: "up" | "down") => {
    setMoving(true);
    void send({ op: "move_track", target: { track_id: t.id }, before: {}, after: { to } } as Schemas["SimpleChangeIn"], `Moved ${t.title} ${to}.`, t.decider_name ?? null, "Move", t.title).finally(() => setMoving(false));
  };
  const toTrash = (t: Track) => {
    // Every feature on it moves, cut ones too: the API's count of what moves.
    const n = t.moves_count ?? 0;
    const done = n ? `Moved ${t.title} to Trash · ${features(n)} now ${n === 1 ? "has" : "have"} no track` : `Moved ${t.title} to Trash`;
    void send({ op: "delete_track", target: { track_id: t.id }, before: {}, after: {} } as Schemas["SimpleChangeIn"], done, t.decider_name ?? null, "Move to Trash", t.title).then((ok) => ok && (setOpened(null), setTrashing(null)));
  };
  return (
    <>
      <Button className="!h-8" data-testid="tracks-open" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        {/* at-followups: no count until the tracks are read (never "Tracks · 0" while they load). */}
        {data ? `Tracks · ${tracks.length}` : "Tracks"}
      </Button>
      <Sheet open={open} title="Tracks" onClose={() => setOpen(false)} side testId="tracks-sheet" tools={canChange ? undefined : <span className="text-sm text-text2">View only</span>}>
        <div className="px-4 pb-4">
          {canChange && !adding && (
            <div className="mb-1 flex">
              <button type="button" className={PRIMARY} onClick={() => setAdding(true)} data-testid="track-add">
                {data?.can_add ? "+ Add track" : "+ Propose a track"}
              </button>
            </div>
          )}
          {adding && data && <AddTrack data={data} onCancel={() => setAdding(false)} onAdd={async (after) => (await send({ op: "add_track", target: {}, before: {}, after } as Schemas["SimpleChangeIn"], `Added ${after.title}`, data.add_decider_name ?? null, "New track", after.title)) && setAdding(false)} />}
          <ul className="flex flex-col">
            {tracks.map((t, n) => {
              const expanded = opened === t.id;
              const count = t.feature_count ?? 0;
              const moves = t.moves_count ?? 0;
              return (
                <li key={t.id} data-testid="track-row" className={`border-b border-line py-2 ${expanded ? "-mx-2 rounded-lg bg-surface2 px-2" : ""}`}>
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className={`font-medium break-words ${t.status === "closed" ? "text-text2" : ""}`}>{t.title}</p>
                      <p className="text-sm text-text2">
                        {t.owner_name ?? "No owner"} · {features(count)}
                        {t.status !== "active" ? ` · ${STATE[t.status]}` : ""}
                      </p>
                    </div>
                    <button type="button" aria-expanded={expanded} aria-label={`${expanded ? "Hide" : canChange ? "Change" : "Open"} ${t.title}`} onClick={() => (setOpened(expanded ? null : t.id), setTrashing(null))} className="h-8 rounded px-2 text-sm text-accent-ink hover:bg-surface">
                      {expanded ? "Hide" : canChange ? "Change" : "Open"}
                    </button>
                  </div>
                  {expanded && (
                    <div className="mt-1">
                      <TrackFields t={t} may={canChange} people={data?.people ?? []} prds={data?.prds ?? []} goals={data?.goals ?? []} onEdit={(after, done) => edit(t, after, done)} />
                      {canChange && tracks.length > 1 && (
                        <div className="mt-1 flex gap-1.5">
                          <Button className="!h-8" disabled={moving || n === 0} onClick={() => move(t, "up")}>
                            Move up
                          </Button>
                          <Button className="!h-8" disabled={moving || n === tracks.length - 1} onClick={() => move(t, "down")}>
                            Move down
                          </Button>
                        </div>
                      )}
                      {canChange && t.can_decide && trashing !== t.id && (
                        <button
                          type="button"
                          className="mt-1 text-sm font-medium text-crit hover:underline"
                          // A track with features asks once, saying where they go; an empty one moves at once.
                          onClick={() => (moves ? setTrashing(t.id) : toTrash(t))}
                        >
                          Move to Trash
                        </button>
                      )}
                      {canChange && t.can_decide && trashing === t.id && (
                        <div className="mt-1 grid gap-1.5" data-testid="track-trash-confirm">
                          <p className="text-sm">
                            {movesLine(count, moves)}
                          </p>
                          <div className="flex gap-1.5">
                            <Button variant="danger" onClick={() => toTrash(t)}>
                              Move to Trash
                            </Button>
                            <Button className="!h-8" onClick={() => setTrashing(null)}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      )}
                      {canChange && !t.can_decide && t.decider_name && (
                        <p className="mt-2">
                          <span className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2 py-px text-sm font-medium text-text">Waits for {t.decider_name}</span>
                        </p>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </Sheet>
    </>
  );
}

function TrackFields({ t, may, people, prds, goals, onEdit }: { t: Track; may: boolean; people: Schemas["SimplePerson"][]; prds: Schemas["SimpleTrackPrdChoice"][]; goals: Schemas["SimpleTrackGoal"][]; onEdit: (after: Record<string, string | string[] | null>, done: string) => Promise<boolean> }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(t.title);
  const word = t.can_decide ? "Save" : "Propose";
  const held = t.prds ?? [];
  const ids = held.map((p) => p.id);
  const offered = prds.filter((p) => !ids.includes(p.id));
  const rename = async () => {
    const v = name.trim();
    if (!v || v === t.title) return setRenaming(false);
    if (await onEdit({ title: v }, `Renamed ${t.title} to ${v}`)) setRenaming(false);
  };
  return (
    <dl className="text-[15px]">
      <div className={ROW}>
        <dt className="text-sm text-text2">Name</dt>
        <dd>
          {renaming ? (
            <div className="grid gap-1.5">
              <input aria-label="Track name" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void rename()} className={FIELD} />
              <div className="flex gap-1.5">
                <button type="button" className={PRIMARY} onClick={() => void rename()}>
                  {word}
                </button>
                <Button className="!h-8" onClick={() => (setName(t.title), setRenaming(false))}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : may ? (
            <button type="button" aria-label={`Rename ${t.title}`} onClick={() => setRenaming(true)} className="text-left underline decoration-dotted underline-offset-4">
              {t.title}
            </button>
          ) : (
            t.title
          )}
        </dd>
      </div>
      <div className={ROW}>
        <dt className="text-sm text-text2">Owner</dt>
        <dd>
          {may ? (
            <select aria-label="Owner" value={t.owner_id ?? ""} onChange={(e) => void onEdit({ owner_id: e.target.value || null }, `${t.title}'s owner is now ${people.find((p) => p.id === e.target.value)?.name ?? "no one"}`)} className={FIELD}>
              <option value="">No owner</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          ) : (
            (t.owner_name ?? "No owner")
          )}
        </dd>
      </div>
      <div className={ROW}>
        <dt className="text-sm text-text2">State</dt>
        <dd className="flex gap-1">
          {may
            ? (["active", "paused", "closed"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={t.status === s}
                  onClick={() => t.status !== s && void onEdit({ status: s }, `${t.title} is ${STATE[s].toLowerCase()}`)}
                  className={`rounded-lg border px-2.5 py-0.5 text-sm ${t.status === s ? "border-accent bg-accent-soft font-medium text-accent-ink" : "border-line"}`}
                >
                  {STATE[s]}
                </button>
              ))
            : STATE[t.status]}
        </dd>
      </div>
      <div className={ROW}>
        <dt className="text-sm text-text2">PRDs</dt>
        <dd className="grid gap-1" data-testid="track-prds">
          {/* tracks-goal (owner Nov 9): a track holds many PRDs; a PRD is on one track, so one on another moves from it. */}
          {held.length === 0 && <span className="text-text2">No PRD</span>}
          {held.map((p) => (
            <span key={p.id} className="flex items-center gap-2" data-testid="track-prd">
              <span className="min-w-0 flex-1 break-words" data-testid="track-prd-title">{p.title}</span>
              {may && (
                <button type="button" aria-label={`Remove ${p.title} from ${t.title}`} onClick={() => void onEdit({ remove_prd_id: p.id }, `Removed ${p.title} from ${t.title}`)} className="h-7 rounded px-1.5 text-sm text-accent-ink hover:bg-surface">
                  Remove
                </button>
              )}
            </span>
          ))}
          {may && offered.length > 0 && (
            <select aria-label="Add a PRD" value="" onChange={(e) => e.target.value && void onEdit({ add_prd_id: e.target.value }, `Added ${prds.find((p) => p.id === e.target.value)?.title ?? "a PRD"} to ${t.title}`)} className={FIELD}>
              <option value="">Add a PRD</option>
              {offered.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.track_title ? `${p.title} · move from ${p.track_title}` : p.title}
                </option>
              ))}
            </select>
          )}
        </dd>
      </div>
      <div className={ROW}>
        <dt className="text-sm text-text2">Goal</dt>
        <dd>
          {may ? (
            <GoalSelect label="Goal" value={t.goal_id ?? ""} goals={goals} onChange={(v) => void onEdit({ goal_id: v || null }, `${t.title}'s goal is now ${goals.find((g) => g.id === v)?.name ?? "none"}`)} />
          ) : (
            (t.goal_name ?? "No goal")
          )}
        </dd>
      </div>
    </dl>
  );
}

/** tracks-goal: "No goal" and the company's goals by their names. */
function GoalSelect({ label, value, goals, onChange }: { label: string; value: string; goals: Schemas["SimpleTrackGoal"][]; onChange: (v: string) => void }) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className={FIELD}>
      <option value="">No goal</option>
      {goals.map((g) => (
        <option key={g.id} value={g.id}>
          {g.name}
        </option>
      ))}
    </select>
  );
}

function AddTrack({ data, onAdd, onCancel }: { data: Schemas["SimpleTracks"]; onAdd: (after: { title: string; prd_ids: string[]; owner_id: string | null; goal_id: string | null }) => Promise<unknown>; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  // tracks-goal: a track's PRD is optional; one already on a track is offered as "move from" it.
  const [prd, setPrd] = useState(data.prds.find((p) => !p.track_id)?.id ?? "");
  const [owner, setOwner] = useState("");
  const [goal, setGoal] = useState("");
  const why = title.trim() ? undefined : "Name the track";
  return (
    <div className="mb-2 grid gap-1.5 rounded-lg border border-line p-2" data-testid="track-new">
      <input aria-label="New track name" autoFocus placeholder="Track name" value={title} onChange={(e) => setTitle(e.target.value)} className={FIELD} />
      <select aria-label="New track PRD" value={prd} onChange={(e) => setPrd(e.target.value)} className={FIELD}>
        <option value="">No PRD</option>
        {data.prds.map((p) => (
          <option key={p.id} value={p.id}>
            {p.track_title ? `${p.title} · move from ${p.track_title}` : p.title}
          </option>
        ))}
      </select>
      <GoalSelect label="New track goal" value={goal} goals={data.goals ?? []} onChange={setGoal} />
      <select aria-label="New track owner" value={owner} onChange={(e) => setOwner(e.target.value)} className={FIELD}>
        <option value="">No owner</option>
        {data.people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <div className="flex gap-1.5">
        <button type="button" className={PRIMARY} disabled={!!why} title={why} onClick={() => void onAdd({ title: title.trim(), prd_ids: prd ? [prd] : [], owner_id: owner || null, goal_id: goal || null })}>
          {data.can_add ? "Add" : "Propose"}
        </button>
        <Button className="!h-8" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
