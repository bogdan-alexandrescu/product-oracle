"use client";

// MOCK-HOOK: the whole file. Mock-up variants of Home counting the Ground Truth flags (the owner's
// Nov 5 rule "define and enforce Ground Truth"), switched by the local-only ?gtf=a|b|c|d (and
// ?gtn=30 for the hard case). Not a product change: nothing renders without ?gtf.

import { useMemo, useState, useSyncExternalStore } from "react";

import { GroundTruthFlags } from "@/app/baseline/_components/GroundTruthFlags";
import { HomeCard } from "@/app/simple/_home/cards";
import { Dialog } from "@/components/ds/Dialog";
import { Icon } from "@/components/ds/Icon";
import { InfoTip } from "@/components/ds/InfoTip";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useQuery } from "@/lib/use-query";

type Check = Schemas["GroundTruthOut"];
type Flag = Schemas["GroundTruthFlag"];
export type GtVariant = "a" | "b" | "c" | "d";

export type Gt = {
  variant: GtVariant | null;
  check: Check | undefined;
  graph: Schemas["GraphOut"] | undefined;
  proposals: Schemas["ProposalOut"][] | undefined;
  canWrite: boolean;
  canPropose: boolean;
  canChangeRoadmap: boolean;
  reload: () => void;
};

/** MOCK-HOOK: the hard case's invented flags, padding the check to 30 of four kinds. */
const EXTRA_NAMES = [
  "Bulk invite", "Saved filters", "Audit trail", "Dark export", "Usage alerts", "Team spaces", "Quick notes", "Seat transfer",
  "Billing emails", "Shared views", "Inline edit", "Data retention", "Custom fields", "Pin to top", "Reply by email", "Weekly digest",
  "Status page", "API tokens", "Calendar sync", "Read receipts", "Bulk archive", "Mobile widgets", "Tag colors", "Smart sort",
  "Offline mode", "Single sign-on", "Merge records", "Snooze", "Quiet hours", "Field history",
];
const EXTRA_KINDS: { kind: Flag["kind"]; action: Schemas["GroundTruthFix"]["action"]; words: string }[] = [
  { kind: "unlinked_item", action: "add_to_ground_truth", words: "Add to Ground Truth" },
  { kind: "prd_feature_missing", action: "link_to_feature", words: "Link to a feature" },
  { kind: "no_code", action: "give_code", words: "Give it a code" },
  { kind: "no_goal", action: "pick_goal", words: "Pick a goal" },
];
const EXTRA_WORDS: Record<string, string> = {
  unlinked_item: "This roadmap item is not a feature in the Ground Truth.",
  prd_feature_missing: "This PRD's feature is not in the Ground Truth.",
  no_code: "This feature has no feature code yet.",
  no_goal: "This feature serves no goal.",
};

function padTo(check: Check, n: number): Check {
  const keep = check.flags.filter((f) => EXTRA_KINDS.some((k) => k.kind === f.kind));
  const goal = check.flags.find((f) => f.goal)?.goal ?? null;
  const flags = [...keep];
  for (let i = 0; flags.length < n; i++) {
    const k = EXTRA_KINDS[i % EXTRA_KINDS.length];
    const name = EXTRA_NAMES[i % EXTRA_NAMES.length];
    const ref = { id: `mock-gt-${i}`, code: null, name };
    // Rows read "PRD <title>" and "<roadmap title>": invented names, never "PRD Example PRD".
    const where = { roadmap: { id: "mock-roadmap", title: "Growth roadmap" }, prd: { id: "mock-prd", title: "Growth" } };
    flags.push({
      kind: k.kind,
      item: k.kind === "unlinked_item" ? ref : null,
      feature: k.kind === "unlinked_item" ? null : ref,
      goal: k.kind === "no_goal" ? null : i % 3 === 0 ? null : goal,
      where,
      words: EXTRA_WORDS[k.kind],
      fixes: [{ action: k.action, target: ref.id, words: k.words }],
    });
  }
  const counts: Record<string, number> = {};
  for (const f of flags) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
  return { flags, counts, total: flags.length };
}

const noSubscribe = () => () => {};

/** MOCK-HOOK: the check, the graph and open proposals, read once for Home's variant. */
export function useGt(perm: { canWrite: boolean; canPropose: boolean; canChangeRoadmap: boolean }): Gt {
  // Read from the address once hydrated (the server's snapshot is empty): local-only, no Suspense boundary needed on Home.
  const search = useSyncExternalStore(noSubscribe, () => window.location.search, () => "");
  const params = new URLSearchParams(search);
  const raw = params.get("gtf");
  const variant: GtVariant | null = raw === "a" || raw === "b" || raw === "c" || raw === "d" ? raw : null;
  const pad = Number(params.get("gtn") ?? 0);
  const on = variant !== null;
  const check = useQuery(`home-gt-check-${on}`, () => (on ? unwrap(api.GET("/v1/baseline/check")) : Promise.resolve(undefined)));
  const graph = useQuery(`home-gt-graph-${on}`, () => (on ? unwrap(api.GET("/v1/baseline/graph")) : Promise.resolve(undefined)));
  const proposals = useQuery(`home-gt-proposals-${on}`, () =>
    on ? unwrap(api.GET("/v1/baseline/proposals", { params: { query: { status: "open" } } })) : Promise.resolve(undefined),
  );
  const data = useMemo(() => (check.data && pad > check.data.total ? padTo(check.data, pad) : check.data), [check.data, pad]);
  return {
    variant,
    check: data,
    graph: graph.data ?? undefined,
    proposals: proposals.data ?? undefined,
    ...perm,
    reload: () => {
      void check.reload();
      void proposals.reload();
      void graph.reload();
    },
  };
}

const subset = (check: Check, keep: (f: Flag) => boolean): Check => {
  const flags = check.flags.filter(keep);
  const counts: Record<string, number> = {};
  for (const f of flags) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
  return { flags, counts, total: flags.length };
};

/** The list: the Ground Truth page's own flags band, each flag with its fix. */
function List({ gt, check }: { gt: Gt; check: Check }) {
  return (
    <GroundTruthFlags
      check={check}
      graph={gt.graph}
      proposals={gt.proposals}
      canWrite={gt.canWrite}
      canPropose={gt.canPropose}
      canChangeRoadmap={gt.canChangeRoadmap}
      onChanged={gt.reload}
    />
  );
}

function Sheet({ gt, check, title, onClose }: { gt: Gt; check: Check; title: string; onClose: () => void }) {
  return (
    <Dialog title={`${title} · ${check.total}`} onClose={onClose} testId="gtf-sheet" phoneSheet scrollBody closeButton cancelLabel="Close">
      {/* The sheet's title holds the band's heading and total: the band drops its own, and its frame. */}
      <div className={BARE}>
        {check.total === 0 && <p className="simple-small">No flags</p>}
        {/* Kept mounted with no flags left (the band hides at a total of 0), so the last fix's Undo stays. */}
        <List gt={gt} check={check.total === 0 ? { ...check, total: 1 } : check} />
      </div>
    </Dialog>
  );
}

const BARE = "[&_[data-testid=gt-band]]:m-0 [&_[data-testid=gt-band]]:border-0 [&_[data-testid=gt-band]]:p-0 [&_[data-testid=gt-band]>div:first-child]:hidden";
/** (b)'s card: Home's card header holds the band's heading and total; the band drops its own, and its frame. */
const IN_CARD = `mt-3 ${BARE}`;

const flagsWord = (n: number) => (n === 1 ? "Ground Truth flag" : "Ground Truth flags");

/** (a) One line in the waiting card: the count, opening a sheet of each flag and its fix. */
export function GtWaitingLine({ gt }: { gt: Gt }) {
  const [open, setOpen] = useState(false);
  if (gt.variant !== "a" || !gt.check || (gt.check.total === 0 && !open)) return null;
  return (
    <>
      {/* At 0 the count goes and its open sheet stays, with the last fix's Undo. */}
      {gt.check.total > 0 && (
        <p data-testid="gtf-a-line" className="simple-small mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 border-t border-line pt-2">
          <Icon name="flag" size={16} />
          <button type="button" className="simple-link" data-testid="gtf-open" onClick={() => setOpen(true)}>
            <span className="tnum">{gt.check.total}</span> {flagsWord(gt.check.total)}
          </button>
          <InfoTip label="Ground Truth flags" align="start">
            Anything that breaks the Ground Truth is allowed, and flagged here with its fix.
          </InfoTip>
        </p>
      )}
      {open && <Sheet gt={gt} check={gt.check} title="Ground Truth flags" onClose={() => setOpen(false)} />}
    </>
  );
}

/** (b) A small Ground Truth card beside the broken links: the counts per kind, each opening its flags in place. */
export function GtCard({ gt }: { gt: Gt }) {
  if (gt.variant !== "b" || !gt.check || gt.check.total === 0) return null;
  return (
    <div data-testid="gtf-b-card">
      <HomeCard
        id="gtf-ground-truth"
        icon="flag"
        title="Ground Truth flags"
        count={gt.check.total}
        info={
          <InfoTip label="Ground Truth flags" align="start">
            Anything that breaks the Ground Truth is allowed, and flagged here with its fix.
          </InfoTip>
        }
      >
        <div className={IN_CARD}>
          <List gt={gt} check={gt.check} />
        </div>
      </HomeCard>
    </div>
  );
}

/** (c) The flags of one goal's features, on its card: a count opening them. */
export function GtGoalChip({ gt, goalId, goalName }: { gt: Gt; goalId: string; goalName: string }) {
  const [open, setOpen] = useState(false);
  const mine = useMemo(() => (gt.check ? subset(gt.check, (f) => f.goal?.id === goalId) : undefined), [gt.check, goalId]);
  if (gt.variant !== "c" || !mine || (mine.total === 0 && !open)) return null;
  return (
    <>
      {mine.total > 0 && (
        <button type="button" data-testid="gtf-c-chip" onClick={() => setOpen(true)} className="simple-small inline-flex items-center gap-1 rounded-full bg-crit-bg px-2 py-0.5 font-semibold text-crit" aria-label={`${mine.total} ${flagsWord(mine.total)}: ${goalName}`}>
          <Icon name="flag" size={16} />
          <span className="tnum">{mine.total}</span>
        </button>
      )}
      {open && <Sheet gt={gt} check={mine} title={goalName} onClose={() => setOpen(false)} />}
    </>
  );
}

/** (c) The flags that serve no goal shown on Home: one count under the goals. */
export function GtNoGoalLine({ gt, goalIds }: { gt: Gt; goalIds: string[] }) {
  const [open, setOpen] = useState(false);
  const rest = useMemo(() => (gt.check ? subset(gt.check, (f) => !f.goal?.id || !goalIds.includes(f.goal.id)) : undefined), [gt.check, goalIds]);
  if (gt.variant !== "c" || !rest || (rest.total === 0 && !open)) return null;
  return (
    <>
      {rest.total > 0 && (
        <p data-testid="gtf-c-rest" className="simple-small mt-2 flex items-center gap-1.5">
          <Icon name="flag" size={16} />
          <button type="button" className="simple-link" onClick={() => setOpen(true)}>
            <span className="tnum">{rest.total}</span> {flagsWord(rest.total)} with no goal
          </button>
          <InfoTip label="Ground Truth flags" align="start">
            Anything that breaks the Ground Truth is allowed, and flagged with its fix.
          </InfoTip>
        </p>
      )}
      {open && <Sheet gt={gt} check={rest} title="No goal" onClose={() => setOpen(false)} />}
    </>
  );
}

/** (d) A badge on the Home title: the count, opening the list. */
export function GtTitleBadge({ gt }: { gt: Gt }) {
  const [open, setOpen] = useState(false);
  if (gt.variant !== "d" || !gt.check || (gt.check.total === 0 && !open)) return null;
  return (
    <>
      {gt.check.total > 0 && (
        <button
          type="button"
          data-testid="gtf-d-badge"
          onClick={() => setOpen(true)}
          title={`${gt.check.total} ${flagsWord(gt.check.total)}`}
          aria-label={`${gt.check.total} ${flagsWord(gt.check.total)}`}
          className="inline-flex h-7 items-center gap-1 rounded-full bg-crit-bg px-2.5 text-[13px] font-semibold text-crit hover:opacity-90"
        >
          <Icon name="flag" size={16} />
          <span className="tnum">{gt.check.total}</span>
        </button>
      )}
      {open && <Sheet gt={gt} check={gt.check} title="Ground Truth flags" onClose={() => setOpen(false)} />}
    </>
  );
}
