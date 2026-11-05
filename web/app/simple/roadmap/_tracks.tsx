"use client";

import { useState } from "react";

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

/** A track's features as the Gantt's track lane draws them: the roadmap's items on it, cut ones left out. */
export function trackFeatures(items: Item[], id: string): number {
  return items.filter((i) => i.track?.id === id && i.status !== "cut" && i.status !== "merged").length;
}

/**
 * removed-tracks (et B): "Tracks · N" beside the roadmap's filters opens a sheet of every track
 * (paused, closed and empty ones too) with its owner, state and features; a row opens to Name,
 * Owner, State and Move to Trash; "+ Add track" in its head. One who does not decide proposes.
 */
export function TracksButton({ items, canChange, onChanged }: { items: Item[]; canChange: boolean; onChanged: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [n, setN] = useState(0);
  const q = useQuery(`simple-tracks:${n}`, () => unwrap(api.GET("/v1/simple/tracks")));
  const [opened, setOpened] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const data = q.data;
  const tracks = data?.tracks ?? [];
  const refresh = async () => {
    setN((x) => x + 1);
    await onChanged();
  };
  const send = async (body: Schemas["SimpleChangeIn"], done: string, decider: string | null) => {
    try {
      const res = await propose(body);
      await refresh();
      if (res.change.status === "applied")
        toast({
          message: done,
          action: { label: "Undo", onClick: () => void undo(res.change.id).then(refresh, (e) => toast({ message: e instanceof ChangeFailed ? e.message : "Oracle could not undo it" })) },
        });
      else toast({ message: `Proposed · waits for ${decider ?? "an owner"}` });
      return true;
    } catch (e) {
      toast({ message: e instanceof ChangeFailed ? e.message : "Oracle could not change the track" });
      return false;
    }
  };
  const edit = (t: Track, after: Record<string, string | null>, done: string) =>
    send({ op: "edit_track", target: { track_id: t.id }, before: {}, after } as Schemas["SimpleChangeIn"], done, t.decider_name ?? null);
  return (
    <>
      <Button className="!h-8" data-testid="tracks-open" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        Tracks · {tracks.length}
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
          {adding && data && <AddTrack data={data} onCancel={() => setAdding(false)} onAdd={async (after) => (await send({ op: "add_track", target: {}, before: {}, after } as Schemas["SimpleChangeIn"], `Added ${after.title}`, data.add_decider_name ?? null)) && setAdding(false)} />}
          <ul className="flex flex-col">
            {tracks.map((t) => {
              const expanded = opened === t.id;
              const count = trackFeatures(items, t.id);
              return (
                <li key={t.id} data-testid="track-row" className={`border-b border-line py-2 ${expanded ? "-mx-2 rounded-lg bg-surface2 px-2" : ""}`}>
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className={`font-medium break-words ${t.status === "closed" ? "text-text2" : ""}`}>{t.title}</p>
                      <p className="text-sm text-text2">
                        {t.owner_name ?? "No owner"} · {count} {count === 1 ? "feature" : "features"}
                        {t.status !== "active" ? ` · ${STATE[t.status]}` : ""}
                      </p>
                    </div>
                    <button type="button" aria-expanded={expanded} aria-label={`${expanded ? "Hide" : "Change"} ${t.title}`} onClick={() => setOpened(expanded ? null : t.id)} className="h-8 rounded px-2 text-sm text-accent-ink hover:bg-surface">
                      {expanded ? "Hide" : canChange ? "Change" : "Open"}
                    </button>
                  </div>
                  {expanded && (
                    <div className="mt-1">
                      <TrackFields t={t} may={canChange} people={data?.people ?? []} onEdit={(after, done) => edit(t, after, done)} />
                      {canChange && t.can_decide && (
                        <button
                          type="button"
                          className="mt-1 text-sm font-medium text-crit hover:underline"
                          onClick={() => void send({ op: "delete_track", target: { track_id: t.id }, before: {}, after: {} } as Schemas["SimpleChangeIn"], `Moved ${t.title} to Trash`, t.decider_name ?? null).then((ok) => ok && setOpened(null))}
                        >
                          Move to Trash
                        </button>
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

function TrackFields({ t, may, people, onEdit }: { t: Track; may: boolean; people: Schemas["SimplePerson"][]; onEdit: (after: Record<string, string | null>, done: string) => Promise<boolean> }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(t.title);
  const word = t.can_decide ? "Save" : "Propose";
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
        <dt className="text-sm text-text2">PRD</dt>
        <dd>{t.prd_title ?? "None"}</dd>
      </div>
    </dl>
  );
}

function AddTrack({ data, onAdd, onCancel }: { data: Schemas["SimpleTracks"]; onAdd: (after: { title: string; prd_id: string; owner_id: string | null }) => Promise<unknown>; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [prd, setPrd] = useState(data.prds[0]?.id ?? "");
  const [owner, setOwner] = useState("");
  return (
    <div className="mb-2 grid gap-1.5 rounded-lg border border-line p-2" data-testid="track-new">
      <input aria-label="New track name" autoFocus placeholder="Track name" value={title} onChange={(e) => setTitle(e.target.value)} className={FIELD} />
      <select aria-label="PRD" value={prd} onChange={(e) => setPrd(e.target.value)} className={FIELD}>
        {data.prds.map((p) => (
          <option key={p.id} value={p.id}>
            {p.title}
          </option>
        ))}
      </select>
      <select aria-label="New track owner" value={owner} onChange={(e) => setOwner(e.target.value)} className={FIELD}>
        <option value="">No owner</option>
        {data.people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <div className="flex gap-1.5">
        <button type="button" className={PRIMARY} disabled={!title.trim() || !prd} onClick={() => void onAdd({ title: title.trim(), prd_id: prd, owner_id: owner || null })}>
          {data.can_add ? "Add" : "Propose"}
        </button>
        <Button className="!h-8" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
