"use client";

import Link from "next/link";
import { useState } from "react";

import { Button, Chip, Notice, Panel } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { errorMessage, useQuery } from "@/lib/use-query";

import { HORIZON_LABEL, HORIZONS, type Horizon } from "./_lib";

type ChangeSet = Schemas["ChangeSetOut"];
type Change = ChangeSet["changes"][number];
export type PlanRoadmap = { slug: string; version: number };

const sets = (slug: string) => unwrap(api.GET("/v1/roadmaps/{doc}/change-sets", { params: { path: { doc: slug } } }));

/** The approved roadmaps on the Plan (each item's roadmap version, when it is the approved one). */
export function approvedRoadmaps(items: Schemas["PlanItem"][] | undefined): PlanRoadmap[] {
  const out = new Map<string, number>();
  for (const i of items ?? []) if (i.origin === "approved") out.set(i.roadmap.slug, Math.max(i.roadmap.version, out.get(i.roadmap.slug) ?? 0));
  return [...out].map(([slug, version]) => ({ slug, version }));
}

/** The Roadmap panel's Edit plan button: opens (or returns to) the roadmap's draft change set. */
export function EditPlanButton({ roadmaps, onOpened }: { roadmaps: PlanRoadmap[]; onOpened: (s: ChangeSet) => void }) {
  const [slug, setSlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const picked = slug ?? roadmaps[0]?.slug;
  if (!picked) return null;
  const open = async () => {
    setError(null);
    try {
      onOpened(await unwrap(api.POST("/v1/roadmaps/{doc}/change-sets", { params: { path: { doc: picked } } })));
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    // The Roadmap panel's head has no room on a phone (as its legend): the plan is edited on a wider screen.
    <span className="inline-flex items-center gap-2 max-[600px]:hidden">
      {roadmaps.length > 1 && (
        <select aria-label="Roadmap to edit" value={picked} onChange={(e) => setSlug(e.target.value)} className="h-8 rounded-lg border border-line-strong bg-surface px-2 text-sm">
          {roadmaps.map((r) => (
            <option key={r.slug} value={r.slug}>
              {r.slug}
            </option>
          ))}
        </select>
      )}
      <Button onClick={open} data-testid="plan-edit">
        Edit plan
      </Button>
      {error && <span className="text-sm text-crit">{error}</span>}
    </span>
  );
}

function diffLine(d: Schemas["ChangeSetDiffItem"]): string {
  if (d.status === "added") return `Added · ${d.title}`;
  if (d.status === "dropped") return `Cut · ${d.title}${d.reason ? ` · ${d.reason}` : ""}`;
  if (d.status === "moved" && d.from_horizon && d.to_horizon) return `Moved · ${d.title} · ${HORIZON_LABEL[d.from_horizon]} → ${HORIZON_LABEL[d.to_horizon]}`;
  if (d.reordered) return `Reordered · ${d.title}`;
  return `Changed · ${d.title}`;
}

/** The diff of a change set against the approved version (E3's item diff), changed items only. */
function Diff({ set }: { set: ChangeSet }) {
  const rows = set.diff.filter((d) => d.status !== "unchanged" || d.reordered);
  if (!rows.length) return <p className="text-sm text-text2">No changes yet.</p>;
  return (
    <ul className="flex flex-col gap-1" aria-label="Changes against the approved plan">
      {rows.map((d) => (
        <li key={`${d.status}-${d.key}`} data-testid="plan-diff-row" data-status={d.status} className="text-sm">
          {diffLine(d)}
        </li>
      ))}
    </ul>
  );
}

function Editor({ set, onChange }: { set: ChangeSet; onChange: (s: ChangeSet | null) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [cutting, setCutting] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [title, setTitle] = useState("");
  const [feature, setFeature] = useState("");
  const [horizon, setHorizon] = useState<Horizon>("now");
  const features = useQuery("plan-edit|features", () => unwrap(api.GET("/v1/baseline/entities", { params: { query: { type: "feature" } } })));
  const path = { params: { path: { doc: set.roadmap, set_id: set.id } } };

  const save = async (changes: Change[]) => {
    setError(null);
    try {
      onChange(await unwrap(api.PATCH("/v1/roadmaps/{doc}/change-sets/{set_id}", { ...path, body: { changes, lock_version: set.lock_version } })));
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  };
  const add = (c: Change) => save([...set.changes, c]);
  const propose = async () => {
    setError(null);
    try {
      onChange(await unwrap(api.POST("/v1/roadmaps/{doc}/change-sets/{set_id}/propose", path)));
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const discard = async () => {
    setError(null);
    try {
      await unwrap(api.DELETE("/v1/roadmaps/{doc}/change-sets/{set_id}", path));
      onChange(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const picked = features.data?.find((f) => f.id === feature);

  return (
    <div className="flex flex-col gap-4 px-4 py-3">
      <p className="text-sm text-text2">
        Changes to approved version {set.base_version} of {set.roadmap_title}. Nobody edits the approved version: Propose changes makes them a new
        version for the decider.
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      {HORIZONS.map((h) => {
        const lane = set.items.filter((i) => i.horizon === h);
        return (
          <div key={h} data-testid="edit-lane" data-horizon={h}>
            <h3 className="mb-1 font-semibold">{HORIZON_LABEL[h]}</h3>
            {lane.length === 0 && <p className="text-sm text-text2">No items</p>}
            <ul className="flex flex-col gap-1">
              {lane.map((i, at) => (
                <li key={i.key} data-testid="edit-item" data-item={i.key} className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-2 py-1.5">
                  <span className="min-w-0 flex-1 truncate font-medium">{i.title}</span>
                  {i.new && <Chip kind="acc">New</Chip>}
                  {i.deferred && <Chip kind="warn">Deferred</Chip>}
                  <select
                    aria-label={`Horizon of ${i.title}`}
                    value={i.horizon}
                    onChange={(e) => add({ op: "move", key: i.key, horizon: e.target.value as Horizon })}
                    className="h-8 rounded-lg border border-line-strong bg-surface px-2 text-sm"
                  >
                    {HORIZONS.map((x) => (
                      <option key={x} value={x}>
                        {HORIZON_LABEL[x]}
                      </option>
                    ))}
                  </select>
                  <Button variant="ghost" aria-label={`Move ${i.title} up`} disabled={at === 0} onClick={() => add({ op: "reorder", key: i.key, position: at - 1 })}>
                    Up
                  </Button>
                  <Button variant="ghost" aria-label={`Move ${i.title} down`} disabled={at === lane.length - 1} onClick={() => add({ op: "reorder", key: i.key, position: at + 1 })}>
                    Down
                  </Button>
                  {h !== "later" && (
                    <Button variant="ghost" onClick={() => add({ op: "defer", key: i.key })}>
                      Defer
                    </Button>
                  )}
                  <Button variant="danger" onClick={() => (setCutting(i.key), setReason(""))}>
                    Cut
                  </Button>
                  {cutting === i.key && (
                    <span className="flex w-full items-center gap-2">
                      <input
                        aria-label={`Why cut ${i.title}`}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="Reason"
                        className="h-8 min-w-0 flex-1 rounded-lg border border-line-strong bg-surface px-2 text-sm"
                      />
                      <Button
                        variant="danger"
                        disabled={!reason.trim()}
                        onClick={async () => {
                          if (await add({ op: "cut", key: i.key, reason: reason.trim() })) setCutting(null);
                        }}
                      >
                        Cut item
                      </Button>
                      <Button variant="ghost" onClick={() => setCutting(null)}>
                        Cancel
                      </Button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {set.cut.length > 0 && (
        <div>
          <h3 className="mb-1 font-semibold">Cut</h3>
          <ul className="flex flex-col gap-1">
            {set.cut.map((c) => (
              <li key={c.key} data-testid="edit-cut" className="text-sm">
                <span className="font-medium line-through">{c.title}</span> · {c.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        aria-label="Add an item"
        onSubmit={async (e) => {
          e.preventDefault();
          const name = picked?.title ?? title.trim();
          if (!name) return;
          if (await add({ op: "add", title: name, horizon, ...(picked ? { feature_id: picked.id } : {}) })) {
            setTitle("");
            setFeature("");
          }
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          From Baseline
          <select aria-label="Baseline feature" value={feature} onChange={(e) => setFeature(e.target.value)} className="h-8 rounded-lg border border-line-strong bg-surface px-2">
            <option value="">A new item</option>
            {(features.data ?? []).map((f) => (
              <option key={f.id} value={f.id}>
                {f.title}
              </option>
            ))}
          </select>
        </label>
        {!picked && (
          <label className="flex flex-col gap-1 text-sm">
            Title
            <input aria-label="New item title" value={title} onChange={(e) => setTitle(e.target.value)} className="h-8 rounded-lg border border-line-strong bg-surface px-2" />
          </label>
        )}
        <label className="flex flex-col gap-1 text-sm">
          Horizon
          <select aria-label="Horizon of the new item" value={horizon} onChange={(e) => setHorizon(e.target.value as Horizon)} className="h-8 rounded-lg border border-line-strong bg-surface px-2">
            {HORIZONS.map((x) => (
              <option key={x} value={x}>
                {HORIZON_LABEL[x]}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="solid" disabled={!picked && !title.trim()}>
          Add item
        </Button>
      </form>
      <div>
        <h3 className="mb-1 font-semibold">Against approved version {set.base_version}</h3>
        <Diff set={set} />
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={discard}>
          Discard
        </Button>
        <Button variant="solid" disabled={set.changes.length === 0} onClick={propose}>
          Propose changes
        </Button>
      </div>
    </div>
  );
}

/** A proposed version waiting for its decider: the diff, and Approve for the one who may. */
function Proposal({ set, me, canWrite, onApproved }: { set: ChangeSet; me: string | null; canWrite: boolean; onApproved: (n: number) => void }) {
  const [error, setError] = useState<string | null>(null);
  const n = set.proposed_version!;
  const mine = set.decider_id ? set.decider_id === me : canWrite;
  const who = set.decider_id ? (set.decider_id === me ? "you (the decider)" : "the decider") : "an approver";
  const approve = async () => {
    setError(null);
    try {
      await unwrap(api.POST("/v1/documents/{doc}/versions/{n}/approve", { params: { path: { doc: set.roadmap, n } } }));
      onApproved(n);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <div data-testid="plan-proposal" className="flex flex-col gap-3 px-4 py-3">
      <p className="text-sm">
        <span className="font-semibold">Version {n} proposed</span> from approved version {set.base_version} · waiting for {who}
      </p>
      <Diff set={set} />
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex items-center justify-end gap-2">
        <Link href={`/documents/${set.roadmap}/v/${n}`} className="text-sm font-semibold text-accent-ink underline-offset-2 hover:underline">
          Open version {n}
        </Link>
        {mine && (
          <Button variant="solid" onClick={approve}>
            Approve version {n}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Plan changes (#346): the draft change set being edited, and proposals waiting for the
 * decider, for the Plan's approved roadmaps. Approving a proposal makes it the live plan.
 */
export function PlanChanges({
  roadmap,
  opened,
  me,
  canWrite,
  onPlanChanged,
}: {
  roadmap: PlanRoadmap;
  opened: ChangeSet | null;
  me: string | null;
  canWrite: boolean;
  onPlanChanged: () => void;
}) {
  const q = useQuery(`plan-edit|${roadmap.slug}|${opened?.id ?? ""}|${opened?.lock_version ?? ""}`, () => sets(roadmap.slug), { keepPrevious: true });
  const [local, setLocal] = useState<ChangeSet | null | undefined>(undefined);
  const [live, setLive] = useState<number | null>(null);
  const all = q.data ?? [];
  const draft = local !== undefined ? (local?.status === "draft" ? local : null) : (opened ?? all.find((s) => s.status === "draft") ?? null);
  const proposed = [...(local?.status === "proposed" ? [local] : []), ...all.filter((s) => s.status === "proposed" && !s.approved && s.id !== local?.id)];
  if (!draft && proposed.length === 0 && live == null) return null;
  return (
    <Panel title="Plan changes" testId="plan-changes" tools={<span className="text-sm text-text2">{roadmap.slug}</span>}>
      {live != null && (
        <div className="px-4 pt-3">
          <Notice tone="pass" testId="plan-live">
            Version {live} is the live plan.
          </Notice>
        </div>
      )}
      {q.error && <Notice tone="error">{q.error}</Notice>}
      {draft && canWrite && <Editor set={draft} onChange={(s) => (setLocal(s), q.reload())} />}
      {proposed.map((s) => (
        <Proposal
          key={s.id}
          set={s}
          me={me}
          canWrite={canWrite}
          onApproved={(n) => {
            setLive(n);
            setLocal(null);
            void q.reload();
            onPlanChanged();
          }}
        />
      ))}
    </Panel>
  );
}
