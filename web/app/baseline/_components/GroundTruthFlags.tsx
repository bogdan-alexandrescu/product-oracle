"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { Button, Dialog, InfoTip, Notice } from "@/components/ds";
import { api, unwrap, type GraphOut, type Schemas } from "@/lib/api/client";
import { named } from "@/lib/codes";
import { errorMessage } from "@/lib/use-query";

import { goalCodes, goalTags } from "./common";

type Check = Schemas["GroundTruthOut"];
type Flag = Schemas["GroundTruthFlag"];
type Kind = Flag["kind"];
type Action = Schemas["GroundTruthFix"]["action"];

/** docs/ground-truth.md's kinds, in the check's order: the count's name and, behind its (i), why. */
const KINDS: { kind: Kind; label: string; why: string }[] = [
  { kind: "unlinked_item", label: "Not in the Ground Truth", why: "Roadmap items that are no feature of the Ground Truth, or one only proposed so far." },
  { kind: "slice_parent_missing", label: "Slices not in the Ground Truth", why: "Roadmap slices of a PRD feature (one per milestone it spans) whose feature is not in the Ground Truth." },
  { kind: "prd_feature_missing", label: "PRD features not in the Ground Truth", why: "Features of a PRD's approved version that are not in the Ground Truth." },
  { kind: "no_code", label: "No feature code", why: "Ground Truth features without an F-code, so no PRD or roadmap can name them." },
  { kind: "no_goal", label: "Serves no goal", why: "Ground Truth features that serve no goal." },
  { kind: "runs_today_on_roadmap", label: "Runs today, still on the roadmap", why: "Features that run today, with proof, but are still on the roadmap." },
];

const FIX_LABEL: Record<Action, string> = {
  add_to_ground_truth: "Add to Ground Truth",
  link_to_feature: "Link to a feature",
  give_code: "Give it a code",
  pick_goal: "Pick a goal",
  confirm_feature: "Confirm it",
  take_off_roadmap: "Take it off the roadmap",
};

/** What the row is: the item (or slice) when there is one, else the feature. */
const subject = (f: Flag) => f.item ?? f.feature!;
const shown = (r: Schemas["GroundTruthRef"]) => (r.code ? `${r.code} ${r.name}` : r.name);

/** A feature code (F-09, F-15), or a slice's (F-15a): its feature's code and the letter. */
const CODE = /^([A-Z]{1,3}-\d+)([a-j])?$/;

/**
 * The code the feature Add to Ground Truth makes should have: the fix's target when it is one (a
 * PRD's feature F-09; a slice flag's feature F-15, so one add clears every slice of it by code),
 * else the flagged item's own code or its slice's feature's (F-02; F-09 for an item F-09a).
 */
function addCode(flag: Flag, target: string): string | undefined {
  return CODE.exec(target)?.[1] ?? CODE.exec(flag.item?.code ?? "")?.[1];
}

/** A code read one way, as the API reads a code key (F-9 and F-009 read F-09; a slice keeps its letter, F-09a). */
function canonical(code: string): string | null {
  const m = /^([A-Z]{1,3})-(\d+)((?:\.\d+)?)([a-j]?)$/.exec(code.trim());
  return m ? `${m[1]}-${String(Number(m[2])).padStart(2, "0")}${m[3]}${m[4]}` : null;
}

/**
 * A key for a new feature: its code when no feature has that code as the API reads it (any
 * feature's key read one way, and every feature code the check names, as a feature's code may
 * come from its roadmap item's PRD section), since the API refuses a code another feature has;
 * the check reads a code from the key, so the feature is in the Ground Truth by that code and
 * needs no Give it a code. Else from its name, not one the graph has (as page.tsx's addSubgoal).
 */
function newKey(name: string, graph: GraphOut | undefined, check: Check, code?: string): string {
  const want = code ? canonical(code) : null;
  const had = [
    ...(graph?.entities ?? []).filter((e) => e.type === "feature").map((e) => e.key),
    ...check.flags.flatMap((f) => (f.feature?.id && f.feature.code ? [f.feature.code] : [])),
  ];
  if (want && !had.some((k) => (canonical(k) ?? k) === want)) return want;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "feature";
  const taken = new Set((graph?.entities ?? []).map((e) => e.key));
  let key = slug;
  for (let n = 2; taken.has(key); n++) key = `${slug}-${n}`;
  return key;
}

/** A commenter's fix proposal (oracle.baseline.fixes.propose): its payload's fix. */
type FixAsked = { action?: string; prd_document_id?: string; code?: string };

/** Whether an open proposal already asks for this flag's fix: Give it a code for its feature, or the link of its PRD's feature. */
function asked(open: Schemas["ProposalOut"][] | undefined, flag: Flag, action: Action, target: string): boolean {
  return (open ?? []).some((p) => {
    const fix = (p.payload as { fix?: FixAsked }).fix;
    if (p.status !== "open" || !fix) return false;
    if (action === "give_code") return fix.action === "give_code" && p.entity_id === target;
    return action === "link_to_feature" && fix.action === "link_prd_feature" && fix.prd_document_id === flag.where.prd?.id && fix.code === target;
  });
}

type Picking = { flag: Flag; what: "feature" | "goal" };
/** What a fix did, in words, and how to undo it when it can be. */
type Done = { text: string; undo?: () => Promise<unknown> };

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
  pending,
  onChanged,
}: {
  check: Check;
  graph: GraphOut | undefined;
  /** The open proposals: a fix a commenter asked for shows on its flag as waiting for an approver. */
  pending: Schemas["ProposalOut"][] | undefined;
  /** Approvers and owners (can("confirm_entity")): add, link, confirm and pick directly. */
  canWrite: boolean;
  /** Commenters (can("create_proposal")): Add to Ground Truth, Give it a code and linking a PRD's feature send a proposal for approvers. */
  canPropose: boolean;
  /** can("create_simple_change"): Take it off the roadmap (a change the item's decider may need to approve). */
  canChangeRoadmap: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<Kind | null>(null);
  const [picking, setPicking] = useState<Picking | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Done | null>(null);
  const counts = KINDS.filter((k) => (check.counts[k.kind] ?? 0) > 0);
  const shownKind = open && (check.counts[open] ?? 0) > 0 ? open : null;

  async function act(run: () => Promise<Done>) {
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

  /** S7's merge_item: the roadmap item becomes the feature's item (a proposal for one who does not edit the roadmap). */
  const linkItem = async (itemId: string, featureId: string) =>
    (await unwrap(api.POST("/v1/simple/changes", { body: { op: "merge_item", target: { item_id: itemId, feature_id: featureId }, before: {}, after: {} } }))).change;

  const add = (flag: Flag, target: string) =>
    act(async () => {
      const name = (flag.feature ?? flag.item)!.name;
      const key = newKey(name, graph, check, addCode(flag, target));
      if (!canWrite) {
        await unwrap(api.POST("/v1/baseline/proposals", { body: { op: "create", kind: "entity", fields: { type: "feature", key, title: name } } }));
        return { text: `Proposed “${name}” for the Ground Truth.` };
      }
      const out = await unwrap(api.POST("/v1/baseline/entities", { body: { type: "feature", key, title: name, attrs: {}, origin: "user" } }));
      if (!out.entity) return { text: `Proposed “${name}” for the Ground Truth.` };
      // Keyed by its code, it is in the Ground Truth by that code (every slice of it too); it is
      // also linked to what was flagged, the roadmap item (an unlinked item, a slice item) or the
      // PRD's feature, so the flag goes when the code was taken and the key is from its name.
      if (flag.item?.id) await linkItem(flag.item.id, out.entity.id);
      else if (flag.where.prd) await unwrap(api.POST("/v1/baseline/prd-links", { body: { prd_document_id: flag.where.prd.id, code: target, feature_id: out.entity.id } }));
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
      if (change.status === "proposed") return { text: `Sent “${name}” off the roadmap for approval.` };
      const undo = change.can_undo ? () => unwrap(api.POST("/v1/simple/changes/{change_id}/undo", { params: { path: { change_id: change.id } } })) : undefined;
      return { text: `Took “${name}” off the roadmap.`, undo };
    });

  const undo = (run: () => Promise<unknown>) =>
    act(async () => {
      await run();
      return { text: "Undone." };
    });

  /** Give it a code: the next F-number (a slice its feature's, with a letter); a commenter's goes to an approver. */
  const giveCode = (flag: Flag, target: string) =>
    act(async () => {
      const name = subject(flag).name;
      const path = { params: { path: { entity_id: target } } };
      const out = await unwrap(api.POST("/v1/baseline/entities/{entity_id}/code", path));
      if (out.status === "proposed") return { text: `Asked an approver to give “${name}” a code.` };
      return { text: `“${name}” is now ${out.code}.`, undo: () => unwrap(api.DELETE("/v1/baseline/entities/{entity_id}/code", path)) };
    });

  /** Link a PRD's feature (or a slice's feature) to a Ground Truth feature; a commenter's goes to an approver. */
  const linkPrd = (flag: Flag, code: string, feature: { id: string; title: string }) =>
    act(async () => {
      const prd = flag.where.prd!.id;
      const name = subject(flag).name;
      const out = await unwrap(api.POST("/v1/baseline/prd-links", { body: { prd_document_id: prd, code, feature_id: feature.id } }));
      if (out.status === "proposed") return { text: `Asked an approver to link “${name}” to “${feature.title}”.` };
      return {
        text: `Linked “${name}” to “${feature.title}”.`,
        undo: () => unwrap(api.DELETE("/v1/baseline/prd-links", { params: { query: { prd_document_id: prd, code } } })),
      };
    });

  const pickFeature = (flag: Flag, target: string, feature: { id: string; title: string }) =>
    act(async () => {
      const change = await linkItem(target, feature.id);
      if (change.status === "proposed") return { text: `Sent linking “${subject(flag).name}” to “${feature.title}” for approval.` };
      return { text: `Linked “${subject(flag).name}” to “${feature.title}”.` };
    });

  const pickGoal = (flag: Flag, target: string, goal: { id: string; name: string }) =>
    act(async () => {
      await unwrap(
        api.POST("/v1/baseline/edges", { body: { src_id: target, dst_id: goal.id, type: "supports", attrs: { contribution: 2 }, origin: "user" } }),
      );
      return { text: `“${subject(flag).name}” now serves “${goal.name}”.` };
    });

  /** The fixes asked for and waiting for an approver (an approver can still make them here). */
  const waiting = (flag: Flag) => flag.fixes.some((fix) => asked(pending, flag, fix.action, fix.target));

  /** The fixes this person can make here: a commenter asks once. */
  function fixes(flag: Flag) {
    return flag.fixes.flatMap((fix) => {
      const t = fix.target;
      if (!canWrite && asked(pending, flag, fix.action, t)) return [];
      const on = (run: () => void) => [{ action: fix.action, run }];
      switch (fix.action) {
        case "add_to_ground_truth":
          return canWrite || canPropose ? on(() => void add(flag, t)) : [];
        case "link_to_feature":
          // A roadmap item's link (an unlinked item, a slice item) is a roadmap write; a PRD's feature's is a link.
          if (flag.item?.id === t) return canWrite ? on(() => setPicking({ flag, what: "feature" })) : [];
          return (canWrite || canPropose) && flag.where.prd ? on(() => setPicking({ flag, what: "feature" })) : [];
        case "give_code":
          return canWrite || canPropose ? on(() => void giveCode(flag, t)) : [];
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
              return (
                <li key={`${s.id ?? s.code ?? s.name}-${n}`} data-testid="gt-row" className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="min-w-0">
                    <span className="block text-[14px] text-text">
                      {s.code && <span className="mr-1.5 font-mono text-[13px] text-text2">{s.code}</span>}
                      {s.name}
                    </span>
                    <span className="block text-[13px] text-text2">{f.words}</span>
                    {waiting(f) && (
                      <Link href="/baseline?tab=proposals" data-testid="gt-pending" className="block text-[13px] text-accent-ink underline">
                        Waiting for an approver
                      </Link>
                    )}
                  </span>
                  {row.length > 0 && (
                    <span className="flex flex-wrap gap-2">
                      {row.map((x) => (
                        <Button key={x.action} disabled={busy} onClick={x.run} aria-label={`${FIX_LABEL[x.action]}: ${shown(s)}`}>
                          {FIX_LABEL[x.action]}
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
          onFeature={(feature) => {
            const t = picking.flag.fixes.find((x) => x.action === "link_to_feature")!.target;
            if (picking.flag.item?.id === t) void pickFeature(picking.flag, t, feature);
            else void linkPrd(picking.flag, t, feature);
          }}
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
