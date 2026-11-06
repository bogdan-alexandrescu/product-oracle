"use client";

import { useMemo, useState } from "react";

import { Button, Dialog, InfoTip, Notice } from "@/components/ds";
import { api, unwrap, type GraphOut, type Schemas } from "@/lib/api/client";
import { named } from "@/lib/codes";
import { errorMessage } from "@/lib/use-query";

import { goalCodes, goalTags } from "./common";

type Check = Schemas["GroundTruthOut"];
type Flag = Schemas["GroundTruthFlag"];
type Kind = Flag["kind"];

/** docs/ground-truth.md's kinds, in the check's order: the count's name and, behind its (i), why. */
const KINDS: { kind: Kind; label: string; why: string }[] = [
  { kind: "unlinked_item", label: "Not in the Ground Truth", why: "Roadmap items that are no feature of the Ground Truth, or one only proposed so far." },
  { kind: "slice_parent_missing", label: "Slices not in the Ground Truth", why: "Slices of a PRD feature (one per milestone it spans) whose feature is not in the Ground Truth." },
  { kind: "prd_feature_missing", label: "PRD features not in the Ground Truth", why: "Features of a PRD's approved version that are not in the Ground Truth." },
  { kind: "no_code", label: "No feature code", why: "Ground Truth features without an F-code, so no PRD or roadmap can name them." },
  { kind: "no_goal", label: "Serves no goal", why: "Ground Truth features that serve no goal." },
  { kind: "runs_today_on_roadmap", label: "Runs today, still on the roadmap", why: "Features that run today, with proof, but are still on the roadmap." },
];

/** What the row is: the item (or slice) when there is one, else the feature. */
const subject = (f: Flag) => f.item ?? f.feature!;
const shown = (r: Schemas["GroundTruthRef"]) => (r.code ? `${r.code} ${r.name}` : r.name);
/** A row's own key, to mark it waiting for approval once a fix was sent. */
const rowKey = (f: Flag) => `${f.kind}:${subject(f).id ?? subject(f).code ?? subject(f).name}`;
/** The roadmap item keys a feature links (attrs.roadmap_items, docs/ground-truth.md). */
const itemsOf = (e: { attrs?: Record<string, unknown> | null }) =>
  Array.isArray(e.attrs?.roadmap_items) ? (e.attrs.roadmap_items as unknown[]).filter((k): k is string => typeof k === "string") : [];

/** A key for a new feature from its name, not one the graph has (as page.tsx's addSubgoal). */
function newKey(name: string, graph: GraphOut | undefined): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "feature";
  const taken = new Set((graph?.entities ?? []).map((e) => e.key));
  let key = slug;
  for (let n = 2; taken.has(key); n++) key = `${slug}-${n}`;
  return key;
}

type Picking = { flag: Flag; what: "feature" | "goal" };

/**
 * The Ground Truth check's band (the owner, Nov 5: anything that breaks the Ground Truth is
 * allowed but flagged): the count per kind, each opening its flagged items, each item with the
 * fixes the check names, made through the baseline's and the roadmap's own routes. A fix reloads
 * the check, so its flag and every count go at once. Viewers read the flags with no fixes.
 */
export function GroundTruthFlags({
  check,
  graph,
  canWrite,
  canPropose,
  canChangeRoadmap,
  onChanged,
}: {
  check: Check;
  graph: GraphOut | undefined;
  /** Approvers and owners (can("confirm_entity")): add, link, confirm and pick directly. */
  canWrite: boolean;
  /** Commenters (can("create_proposal")): Add to Ground Truth sends a proposal for approvers. */
  canPropose: boolean;
  /** can("create_simple_change"): Take it off the roadmap (a change the item's decider may need to approve). */
  canChangeRoadmap: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<Kind | null>(null);
  const [picking, setPicking] = useState<Picking | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; undo?: string } | null>(null);
  // Rows whose fix was sent for approval: no second click until the check changes.
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const wait = (flag: Flag, text: string) => {
    setPending((was) => new Set(was).add(rowKey(flag)));
    return { text };
  };
  const counts = KINDS.filter((k) => (check.counts[k.kind] ?? 0) > 0);
  const shownKind = open && (check.counts[open] ?? 0) > 0 ? open : null;

  async function act(run: () => Promise<{ text: string; undo?: string }>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await run());
      setPicking(null);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Add to Ground Truth, in one change: a roadmap item's feature lists the item's key (so a
   * published item is linked too); a PRD's feature or slice keeps its code (F-09) and then serves
   * the goal its PRD gives. Approvers and owners add at once; a commenter's add is a proposal with
   * the same link, which clears the flag once approved (the owner, Nov 5).
   */
  const add = (flag: Flag, target: string) =>
    act(async () => {
      const name = (flag.feature ?? flag.item)!.name;
      const itemKey = flag.kind === "unlinked_item" ? flag.item?.key : null;
      // An item from a PRD section keeps its code (F-06); a PRD's feature or slice, the PRD's.
      const code = itemKey ? flag.item?.code : target;
      const key = code && !(graph?.entities ?? []).some((e) => e.key === code) ? code : newKey(name, graph);
      const made = (graph?.entities ?? []).find((e) => e.type === "feature" && (itemKey ? itemsOf(e).includes(itemKey) : e.key === code));
      if (made) return wait(flag, `“${name}” is already waiting for approval.`);
      const fields = { type: "feature" as const, key, title: name, attrs: itemKey ? { roadmap_items: [itemKey] } : {} };
      if (!canWrite) {
        await unwrap(api.POST("/v1/baseline/proposals", { body: { op: "create", kind: "entity", fields } }));
        return wait(flag, `Sent “${name}” for approval.`);
      }
      const out = await unwrap(api.POST("/v1/baseline/entities", { body: { ...fields, origin: "user" } }));
      if (!out.entity) return wait(flag, `Sent “${name}” for approval.`);
      if (flag.goal?.id) {
        await unwrap(
          api.POST("/v1/baseline/edges", { body: { src_id: out.entity.id, dst_id: flag.goal.id, type: "supports", attrs: { contribution: 2 }, origin: "user" } }),
        );
      }
      return { text: `Added “${name}” to the Ground Truth.` };
    });

  const confirm = (flag: Flag, target: string) =>
    act(async () => {
      await unwrap(api.POST("/v1/baseline/entities/{entity_id}/confirm", { params: { path: { entity_id: target } } }));
      return { text: `Confirmed “${flag.feature?.name ?? subject(flag).name}”.` };
    });

  const takeOff = (flag: Flag, target: string) =>
    act(async () => {
      const name = subject(flag).name;
      const { change } = await unwrap(api.POST("/v1/simple/changes", { body: { op: "cut", target: { item_id: target }, before: { cut: false }, after: {} } }));
      if (change.status === "proposed") return wait(flag, `Sent “${name}” off the roadmap for approval.`);
      return { text: `Took “${name}” off the roadmap.`, undo: change.can_undo ? change.id : undefined };
    });

  const undo = (changeId: string) =>
    act(async () => {
      await unwrap(api.POST("/v1/simple/changes/{change_id}/undo", { params: { path: { change_id: changeId } } }));
      return { text: "Undone." };
    });

  /** Link to a feature: the feature lists the item's key, so a published item is linked too. */
  const pickFeature = (flag: Flag, feature: { id: string; title: string }) =>
    act(async () => {
      const itemKey = flag.item!.key!;
      const e = graph?.entities.find((x) => x.id === feature.id);
      const roadmap_items = [...new Set([...(e ? itemsOf(e) : []), itemKey])];
      const out = await unwrap(api.PATCH("/v1/baseline/entities/{entity_id}", { params: { path: { entity_id: feature.id } }, body: { attrs: { roadmap_items }, origin: "user" } }));
      if (!out.entity || !out.applied) return wait(flag, `Sent linking “${subject(flag).name}” for approval.`);
      return { text: `Linked “${subject(flag).name}” to “${feature.title}”.` };
    });

  const pickGoal = (flag: Flag, target: string, goal: { id: string; name: string }) =>
    act(async () => {
      await unwrap(
        api.POST("/v1/baseline/edges", { body: { src_id: target, dst_id: goal.id, type: "supports", attrs: { contribution: 2 }, origin: "user" } }),
      );
      return { text: `“${subject(flag).name}” now serves “${goal.name}”.` };
    });

  /** The fixes this person can make here; a fix with no route yet (Give it a code, linking a PRD's feature) shows none. */
  function fixes(flag: Flag) {
    if (pending.has(rowKey(flag))) return [];
    return flag.fixes.flatMap((fix) => {
      const t = fix.target;
      const on = (run: () => void) => [{ action: fix.action, words: fix.words, run }];
      switch (fix.action) {
        case "add_to_ground_truth":
          return canWrite || canPropose ? on(() => void add(flag, t)) : [];
        case "link_to_feature":
          return canWrite && flag.kind === "unlinked_item" && flag.item?.key ? on(() => setPicking({ flag, what: "feature" })) : [];
        case "confirm_feature":
          return canWrite ? on(() => void confirm(flag, t)) : [];
        case "pick_goal":
          return canWrite ? on(() => setPicking({ flag, what: "goal" })) : [];
        case "take_off_roadmap":
          return canChangeRoadmap ? on(() => void takeOff(flag, t)) : [];
        default:
          return [];
      }
    });
  }

  if (check.total === 0) return null;
  return (
    <section aria-label="Ground Truth flags" data-testid="gt-band" className="mb-4 rounded-lg border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[15px] font-semibold text-text">Ground Truth flags</h2>
        <span className="text-[13px] text-text2" data-testid="gt-total">{check.total}</span>
        <InfoTip label="Ground Truth flags">
          Anything that breaks the Ground Truth is allowed, and flagged here with its fix.
        </InfoTip>
      </div>
      <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Flags by kind">
        {counts.map((k) => (
          <span key={k.kind} className="inline-flex items-center gap-1">
            <button
              type="button"
              data-testid={`gt-count-${k.kind}`}
              aria-expanded={shownKind === k.kind}
              aria-controls={`gt-list-${k.kind}`}
              onClick={() => setOpen((o) => (o === k.kind ? null : k.kind))}
              className={`inline-flex h-9 items-center gap-2 rounded-md border px-3 text-[13px] ${
                shownKind === k.kind ? "border-accent bg-accent-soft text-accent-ink" : "border-line-strong text-text hover:bg-surface2"
              }`}
            >
              {k.label}
              <span className="rounded bg-crit-bg px-1.5 font-semibold text-crit">{check.counts[k.kind]}</span>
            </button>
            <InfoTip label={k.label}>{k.why}</InfoTip>
          </span>
        ))}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {notice && (
        <Notice
          testId="gt-notice"
          action={
            notice.undo ? (
              <Button disabled={busy} onClick={() => void undo(notice.undo!)}>
                Undo
              </Button>
            ) : undefined
          }
        >
          {notice.text}
        </Notice>
      )}
      {shownKind && (
        <ul id={`gt-list-${shownKind}`} data-testid={`gt-list-${shownKind}`} className="mt-3 flex flex-col divide-y divide-line">
          {check.flags
            .filter((f) => f.kind === shownKind)
            .map((f, n) => {
              const s = subject(f);
              const row = fixes(f);
              const waiting = pending.has(rowKey(f));
              // One short line; the flag's sentence is behind the (i).
              const line = waiting
                ? "Sent for approval"
                : f.item && f.feature && f.fixes.some((x) => x.action === "confirm_feature")
                  ? `Waiting to be confirmed: ${shown(f.feature)}`
                  : (f.where.roadmap?.title ?? (f.where.prd ? `PRD ${f.where.prd.title}` : null));
              return (
                <li key={`${s.id ?? s.code ?? s.name}-${n}`} data-testid="gt-row" className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="min-w-0">
                    <span className="flex items-center gap-1 text-[14px] text-text">
                      {s.code && <span className="mr-0.5 font-mono text-[13px] text-text2">{s.code}</span>}
                      {s.name}
                      <InfoTip label={s.name}>{f.words}</InfoTip>
                    </span>
                    {line && (
                      <span className="block text-[13px] text-text2" data-testid={waiting ? "gt-pending" : undefined}>
                        {line}
                      </span>
                    )}
                  </span>
                  {row.length > 0 && (
                    <span className="flex flex-wrap gap-2">
                      {row.map((x) => (
                        <Button key={x.action} disabled={busy} onClick={x.run} aria-label={`${x.words}: ${shown(s)}`}>
                          {x.words}
                        </Button>
                      ))}
                    </span>
                  )}
                </li>
              );
            })}
        </ul>
      )}
      {picking && (
        <Picker
          picking={picking}
          graph={graph}
          busy={busy}
          onClose={() => setPicking(null)}
          onFeature={(feature) => void pickFeature(picking.flag, feature)}
          onGoal={(goal) => {
            const t = picking.flag.fixes.find((x) => x.action === "pick_goal")!.target;
            void pickGoal(picking.flag, t, goal);
          }}
        />
      )}
    </section>
  );
}

/** Link to a feature: the Ground Truth's features by code and name; Pick a goal: its goals. */
function Picker({
  picking,
  graph,
  busy,
  onClose,
  onFeature,
  onGoal,
}: {
  picking: Picking;
  graph: GraphOut | undefined;
  busy: boolean;
  onClose: () => void;
  onFeature: (f: { id: string; title: string }) => void;
  onGoal: (g: { id: string; name: string }) => void;
}) {
  const [q, setQ] = useState("");
  const options = useMemo(() => {
    if (picking.what === "goal") {
      const codes = goalCodes(graph);
      const live = new Set((graph?.entities ?? []).filter((e) => e.type === "goal" && e.status !== "rejected").map((e) => e.id));
      return [...goalTags(graph)].filter(([id]) => live.has(id)).map(([id, name]) => ({ id, code: codes.get(id) ?? null, name }));
    }
    return (graph?.entities ?? [])
      .filter((e) => e.type === "feature" && e.status === "confirmed")
      .map((e) => ({ id: e.id, ...named(e.title, e.key) }))
      .sort((a, b) => (a.code ?? "~").localeCompare(b.code ?? "~", undefined, { numeric: true }) || a.name.localeCompare(b.name));
  }, [graph, picking.what]);
  const words = q.trim().toLowerCase();
  const found = words ? options.filter((o) => `${o.code ?? ""} ${o.name}`.toLowerCase().includes(words)) : options;
  const name = subject(picking.flag).name;
  return (
    <Dialog title={picking.what === "goal" ? `Pick a goal for ${name}` : `Link ${name} to a feature`} onClose={onClose} busy={busy} testId="gt-picker" scrollBody>
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={picking.what === "goal" ? "Find a goal" : "Find a feature by code or name"}
        aria-label={picking.what === "goal" ? "Find a goal" : "Find a feature"}
        className="mb-2 h-10 w-full rounded-md border border-line-strong bg-surface px-3 text-[14px] text-text"
      />
      <ul className="flex flex-col gap-1">
        {found.map((o) => (
          <li key={o.id}>
            <button
              type="button"
              disabled={busy}
              onClick={() => (picking.what === "goal" ? onGoal({ id: o.id, name: o.name }) : onFeature({ id: o.id, title: o.name }))}
              className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[14px] text-text hover:bg-surface2"
            >
              {o.code && <span className="font-mono text-[13px] text-text2">{o.code}</span>}
              {o.name}
            </button>
          </li>
        ))}
        {found.length === 0 && <li className="px-2 py-2 text-[14px] text-text2">None found.</li>}
      </ul>
    </Dialog>
  );
}
