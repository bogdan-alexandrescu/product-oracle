"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { Button, Chip, CodeChip, Dialog, InfoTip, Notice } from "@/components/ds";
import { api, unwrap, type GraphOut, type Schemas } from "@/lib/api/client";
import { named, namedText } from "@/lib/codes";
import { errorMessage, useQuery } from "@/lib/use-query";

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
  { kind: "code_differs", label: "Code differs from its PRD", why: "Ground Truth features keyed by another number than the code their PRD or roadmap item gives them." },
  { kind: "no_goal", label: "Serves no goal", why: "Ground Truth features that serve no goal." },
  { kind: "runs_today_on_roadmap", label: "Runs today, still on the roadmap", why: "Features that run today, with proof, but are still on the roadmap." },
];

/** What the row is: the item (or slice) when there is one, else the feature. */
const subject = (f: Flag) => f.item ?? f.feature!;
/**
 * The row's code and name: the subject's own code, else (an item with no code of its own) its
 * feature's, as the item is that feature on the roadmap ("F-03 Night alerts").
 */
const subjectNamed = (f: Flag) => {
  const s = subject(f);
  return { code: s.code ?? (f.item ? (f.feature?.code ?? null) : null), name: s.name };
};
/** The row in words, its code before its name: "F-03 Night alerts". */
const shown = (f: Flag) => namedText(subjectNamed(f));
/** A row's own key, to mark it waiting for approval once a fix was sent. */
const rowKey = (f: Flag) => `${f.kind}:${subject(f).id ?? subject(f).code ?? subject(f).name}`;
/** The roadmap item a flag's Add or Link sets the feature of (unlinked items and slices). */
const itemOf = (f: Flag) => (f.kind === "unlinked_item" || f.kind === "slice_parent_missing" || f.kind === "code_differs" ? (f.item?.id ?? null) : null);
/** The code a PRD's feature or slice is added with (F-09, or F-15 for the slice F-15a). */
const codeOf = (f: Flag) => f.fixes.find((x) => x.action === "add_to_ground_truth" && f.kind !== "unlinked_item")?.target ?? null;

/**
 * Whether a fix for the flag waits for approval, read from the API so it holds after a reload: an
 * open proposal adding its feature (by the item it links, else by the PRD's code), or a roadmap
 * change of its item (its feature, or taking it off) proposed to the roadmap's decider.
 */
function waitsOn(f: Flag, proposals: Schemas["ProposalOut"][], changes: Schemas["SimpleChangeOut"][]): boolean {
  const item = itemOf(f) ?? (f.kind === "runs_today_on_roadmap" ? f.item?.id : null);
  const code = codeOf(f);
  const adds = proposals.some((p) => {
    const fields = (p.payload?.fields ?? {}) as Record<string, unknown>;
    if (p.payload?.op !== "create" || p.payload?.kind !== "entity" || fields.type !== "feature") return false;
    return item && f.kind === "unlinked_item" ? fields.roadmap_item_id === item : !!code && fields.key === code;
  });
  return adds || (!!item && changes.some((c) => c.target?.item_id === item && ["set_feature", "cut"].includes(c.op)));
}

/** A feature code (F-09, F-15), or a slice's (F-15a): its feature's code and the letter. */
const CODE = /^([A-Z]{1,3}-\d+)([a-j])?$/;

/**
 * The code the feature Add to Ground Truth makes should have: the fix's target when it is one (a
 * PRD's feature F-09; a slice flag's feature F-15, so one add clears every slice of it by code),
 * else the flagged item's own code or its slice's feature's (F-02; F-09 for an item F-09a).
 */
/** " as F-13": the code a feature got as it joined the Ground Truth, for the save's notice; none when it has no code. */
const asCode = (e: { key: string; title: string }) => {
  const code = named(e.title, e.key).code;
  return code ? ` as ${code}` : "";
};

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
  proposals,
  canWrite,
  canPropose,
  canChangeRoadmap,
  onChanged,
}: {
  check: Check;
  graph: GraphOut | undefined;
  /** The open baseline proposals: a commenter's Add, Give it a code or PRD link waits on its own. */
  proposals: Schemas["ProposalOut"][] | undefined;
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
  // Rows whose fix was sent for approval: no second click until the check changes.
  const [sent, setSent] = useState<Set<string>>(() => new Set());
  // Roadmap changes proposed to a decider (an item's feature, or taking it off).
  const proposed = useQuery("gt-proposed-changes", () => unwrap(api.GET("/v1/simple/changes", { params: { query: { status: "proposed" } } })));
  const reloadProposed = proposed.reload;
  /** A commenter's fix asked for in a baseline proposal (an approver can still make it here). */
  const asks = (f: Flag) => f.fixes.some((fix) => asked(proposals, f, fix.action, fix.target)) || waitsOn(f, proposals ?? [], []);
  const waits = (f: Flag) => sent.has(rowKey(f)) || asks(f) || waitsOn(f, [], proposed.data ?? []);
  const wait = (flag: Flag, text: string): Done => {
    setSent((was) => new Set(was).add(rowKey(flag)));
    return { text };
  };
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
      void reloadProposed();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Add to Ground Truth, in one call: the feature, keyed by its code when the code is free (a PRD's
   * feature F-09; a slice flag's feature F-15, so one add clears every slice of it by code; an
   * item's own code, F-09 for F-09a), the goal its PRD gives it and, for a roadmap item, the item's
   * own feature (set in its roadmap's working draft, so a published item is linked too). Approvers
   * and owners add at once; a commenter's add is one proposal carrying the same goal and item (the
   * owner, Nov 5).
   */
  const add = (flag: Flag, target: string) =>
    act(async () => {
      const name = (flag.feature ?? flag.item)!.name;
      const key = newKey(name, graph, check, addCode(flag, target));
      const item = itemOf(flag);
      const links = { ...(flag.goal?.id ? { serves: flag.goal.id } : {}), ...(item ? { roadmap_item_id: item } : {}) };
      const fields = { type: "feature" as const, key, title: name, attrs: {}, ...links };
      if (!canWrite) {
        await unwrap(api.POST("/v1/baseline/proposals", { body: { op: "create", kind: "entity", fields } }));
        return wait(flag, `Sent “${name}” for approval.`);
      }
      const out = await unwrap(api.POST("/v1/baseline/entities", { body: { ...fields, origin: "user" } }));
      if (!out.entity) return wait(flag, `Sent “${name}” for approval.`);
      // A PRD's feature whose code was taken (the key is from its name) is linked by its code too.
      if (!item && flag.where.prd && key !== target) await unwrap(api.POST("/v1/baseline/prd-links", { body: { prd_document_id: flag.where.prd.id, code: target, feature_id: out.entity.id } }));
      return { text: `Added “${name}” to the Ground Truth${asCode(out.entity)}.` };
    });

  const confirm = (flag: Flag, target: string) =>
    act(async () => {
      const e = await unwrap(api.POST("/v1/baseline/entities/{entity_id}/confirm", { params: { path: { entity_id: target } } }));
      return { text: `Confirmed “${flag.feature?.name ?? subject(flag).name}”${asCode(e)}.` };
    });

  const takeOff = (flag: Flag, target: string) =>
    act(async () => {
      const name = shown(flag);
      const { change } = await unwrap(api.POST("/v1/simple/changes", { body: { op: "cut", target: { item_id: target }, before: { cut: false }, after: {} } }));
      if (change.status === "proposed") return wait(flag, `Sent “${name}” off the roadmap for approval.`);
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
      const name = shown(flag);
      const path = { params: { path: { entity_id: target } } };
      const out = await unwrap(api.POST("/v1/baseline/entities/{entity_id}/code", path));
      if (out.status === "proposed") return { text: `Asked an approver to give “${name}” a code.` };
      return { text: `“${name}” is now ${out.code}.`, undo: () => unwrap(api.DELETE("/v1/baseline/entities/{entity_id}/code", path)) };
    });

  /** Use its code: a feature keyed by another number gets the code its PRD or roadmap item gives it. */
  const takeOwnCode = (flag: Flag, target: string) =>
    act(async () => {
      const out = await unwrap(api.POST("/v1/baseline/entities/{entity_id}/own-code", { params: { path: { entity_id: target } } }));
      return { text: `“${subject(flag).name}” is now ${out.code}.` };
    });

  /** Link a PRD's feature (or a slice's feature) to a Ground Truth feature; a commenter's goes to an approver. */
  const linkPrd = (flag: Flag, code: string, feature: { id: string; title: string }) =>
    act(async () => {
      const prd = flag.where.prd!.id;
      const name = shown(flag);
      const out = await unwrap(api.POST("/v1/baseline/prd-links", { body: { prd_document_id: prd, code, feature_id: feature.id } }));
      if (out.status === "proposed") return { text: `Asked an approver to link “${name}” to “${feature.title}”.` };
      return {
        text: `Linked “${name}” to “${feature.title}”.`,
        undo: () => unwrap(api.DELETE("/v1/baseline/prd-links", { params: { query: { prd_document_id: prd, code } } })),
      };
    });

  /** Link to a feature: the item's own feature, a change in its roadmap's working draft (a published item too). */
  const pickFeature = (flag: Flag, feature: { id: string; title: string }) =>
    act(async () => {
      const name = shown(flag);
      const body = { op: "set_feature" as const, target: { item_id: flag.item!.id! }, before: { feature_id: flag.feature?.id ?? null }, after: { feature_id: feature.id } };
      const { change } = await unwrap(api.POST("/v1/simple/changes", { body }));
      if (change.status === "proposed") return wait(flag, `Sent linking “${name}” to “${feature.title}” for approval.`);
      const undo = change.can_undo ? () => unwrap(api.POST("/v1/simple/changes/{change_id}/undo", { params: { path: { change_id: change.id } } })) : undefined;
      return { text: `Linked “${name}” to “${feature.title}”.`, undo };
    });

  const pickGoal = (flag: Flag, target: string, goal: { id: string; name: string }) =>
    act(async () => {
      await unwrap(
        api.POST("/v1/baseline/edges", { body: { src_id: target, dst_id: goal.id, type: "supports", attrs: { contribution: 2 }, origin: "user" } }),
      );
      return { text: `“${shown(flag)}” now serves “${goal.name}”.` };
    });

  /** The fixes this person can make here: a commenter asks once. */
  function fixes(flag: Flag) {
    // A commenter asks once; an approver can still make an asked fix, not one they sent.
    if (sent.has(rowKey(flag)) || (!canWrite && asks(flag)) || waitsOn(flag, [], proposed.data ?? [])) return [];
    return flag.fixes.flatMap((fix) => {
      const t = fix.target;
      const on = (run: () => void) => [{ action: fix.action, words: fix.words, run }];
      switch (fix.action) {
        case "add_to_ground_truth":
          return canWrite || canPropose ? on(() => void add(flag, t)) : [];
        case "link_to_feature":
          // A roadmap item's link (an unlinked item, a slice item) is a roadmap write; a PRD's feature's is a link.
          if (itemOf(flag) === t) return canWrite && canChangeRoadmap ? on(() => setPicking({ flag, what: "feature" })) : [];
          return (canWrite || canPropose) && flag.where.prd ? on(() => setPicking({ flag, what: "feature" })) : [];
        case "give_code":
          return canWrite || canPropose ? on(() => void giveCode(flag, t)) : [];
        case "confirm_feature":
          return canWrite ? on(() => void confirm(flag, t)) : [];
        case "use_code":
          return canWrite ? on(() => void takeOwnCode(flag, t)) : [];
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
    <section aria-label="Ground Truth checks" data-testid="gt-band" className="mb-4 rounded-lg border border-line bg-surface p-3">
      {/* Named apart from the Flagged items tab, which counts features, not checks (detailed-a 9). */}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[15px] font-semibold text-text">Ground Truth checks</h2>
        <span className="text-[13px] text-text2" data-testid="gt-total">{check.total}</span>
        <InfoTip label="Ground Truth checks">
          Anything that breaks the Ground Truth is allowed, and flagged here with its fix. Each check that fails counts
          here; Flagged items counts features, so the two can differ.
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
              const sn = subjectNamed(f);
              const row = fixes(f);
              const waiting = waits(f);
              // One short line; the flag's sentence is behind the (i). A feature a run proposed
              // waits for its yes: the status a chip, the feature its name with its code (D-12).
              const unconfirmed = !waiting && f.item && f.feature && f.fixes.some((x) => x.action === "confirm_feature") ? f.feature : null;
              // The item reads as its feature's code and name: the feature once, not a second time (QA Nov 12 #10).
              const same = !!unconfirmed && unconfirmed.code === sn.code && unconfirmed.name === sn.name;
              // An item whose code another feature holds: the feature it is on, by the number it is keyed by.
              const keyed = !waiting && f.kind === "code_differs" && f.item && f.feature?.code ? f.feature : null;
              const line = waiting || unconfirmed
                ? null
                : f.where.prd && !f.item?.id
                    ? `PRD ${f.where.prd.title}`
                    : (f.where.roadmap?.title ?? null);
              return (
                <li key={`${s.id ?? s.code ?? s.name}-${n}`} data-testid="gt-row" className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="min-w-0" data-testid={same ? "gt-unconfirmed" : undefined}>
                    <span className="flex items-center gap-1 text-[14px] text-text">
                      {sn.code ? (
                        <CodeChip kind="feature" entityId={f.item ? (s.code ? null : (f.feature?.id ?? null)) : s.id} entityKey={sn.code} title={sn.name} />
                      ) : (
                        sn.name
                      )}
                      <InfoTip label={s.name}>{f.words}</InfoTip>
                    </span>
                    {waiting ? (
                      <Link href={asks(f) ? "/ground-truth?tab=proposals" : "/simple/roadmap"} data-testid="gt-pending" className="block text-[13px] text-accent-ink underline">
                        Waiting for an approver
                      </Link>
                    ) : unconfirmed ? (
                      <span className="mt-1 flex flex-wrap items-center gap-1.5" data-testid={same ? undefined : "gt-unconfirmed"}>
                        <Chip kind="warn">Waiting to be confirmed</Chip>
                        {!same && <CodeChip kind="feature" entityId={unconfirmed.id} entityKey={unconfirmed.code} title={unconfirmed.name} />}
                      </span>
                    ) : keyed ? (
                      <span className="mt-1 flex flex-wrap items-center gap-1.5" data-testid="gt-keyed">
                        <CodeChip kind="feature" entityId={keyed.id} entityKey={keyed.code!} title={keyed.name} />
                        {line && <span className="text-[13px] text-text2">{line}</span>}
                      </span>
                    ) : (
                      line && <span className="block text-[13px] text-text2">{line}</span>
                    )}
                  </span>
                  {row.length > 0 && (
                    <span className="flex flex-wrap gap-2">
                      {row.map((x) => (
                        <Button key={x.action} disabled={busy} onClick={x.run} aria-label={`${x.words}: ${shown(f)}`}>
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
          onFeature={(feature) => {
            const t = picking.flag.fixes.find((x) => x.action === "link_to_feature")!.target;
            if (itemOf(picking.flag) === t) void pickFeature(picking.flag, feature);
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
  const name = shown(picking.flag);
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
