"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import {
  Chip,
  DataTable,
  Empty,
  FilterChips,
  Inspector,
  InspectorSection,
  LinkButton,
  Notice,
  Page,
  PageHeader,
  Panel,
  SegmentedControl,
  Sheet,
  Split,
  ViewOnly,
  type Column,
} from "@/components/ds";
import { api, unwrap } from "@/lib/api/client";
import { shownDay } from "@/lib/dates";
import { formatDate, formatPercent, plural } from "@/lib/format";
import { useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

import {
  CATEGORY,
  FRESH,
  GROUP_AT,
  keyOf,
  outputTitle,
  proposalOf,
  stalest,
  statusLabel,
  upstreamLine,
  upstreamOf,
  upstreamsOf as upstreamsOfIn,
  type ImpactSource,
  type Output,
  type Report,
  type Upstream,
} from "./_lib";
import { NamesContext, subjectWords, useNames, useNamesOf, type SubjectWords } from "./_names";
import { PlanSteps, type RowResult } from "./_steps";

type View = "lineage" | "table";
const PHONE = "(max-width: 600px)";

function load(source: ImpactSource): Promise<Report> {
  if (source.kind === "version") {
    return unwrap(api.GET("/v1/documents/{doc}/versions/{n}/impact", { params: { path: { doc: source.doc, n: source.n } } }));
  }
  if (source.kind === "entity") {
    return unwrap(api.GET("/v1/baseline/entities/{entity_id}/impact", { params: { path: { entity_id: source.id } } }));
  }
  return unwrap(api.GET("/v1/trace/changes/{change_id}/impact", { params: { path: { change_id: source.id } } }));
}

function usePhone(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(PHONE);
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}

/**
 * v2 screen 2, the Impact explorer and targeted regeneration plan (owner's pick 2026-10-25):
 * B's lineage graph with the plan as its sidebar is the main view, A's table and inspector the
 * second; each plan row carries C's three stages. One ImpactReport drives it, whichever of
 * the three routes it came from.
 */
export function ImpactExplorer({ source }: { source: ImpactSource }) {
  const { can } = useMe();
  const key = source.kind === "version" ? `impact|v|${source.doc}|${source.n}` : `impact|${source.kind}|${source.id}`;
  const q = useQuery(key, () => load(source), { keepPrevious: true });
  const [view, setView] = useState<View>("lineage");
  const [picked, setPicked] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [results, setResults] = useState<Record<string, RowResult>>({});
  const phone = usePhone();
  const report = q.data;
  const selected = report?.affected.find((o) => keyOf(o) === picked) ?? report?.affected[0] ?? null;
  const pick = (o: Output) => {
    setPicked(keyOf(o));
    if (phone) setSheet(true);
  };
  const reload = () => void q.reload();
  const rowProps = (o: Output) => ({
    output: o,
    proposal: report ? proposalOf(report, o) : undefined,
    result: results[keyOf(o)] ?? {},
    onResult: (r: RowResult) => setResults((m) => ({ ...m, [keyOf(o)]: r })),
    onChanged: reload,
  });

  const names = useNames(report);
  const subject = report ? subjectWords(report, names) : null;
  // qa-plan-59: every Impact page leads back to what it is about (the version, Baseline or Sources).
  const backTo =
    source.kind === "version"
      ? { href: `/documents/${source.doc}/v/${source.n}`, label: report?.subject.title ?? `${names.doc(source.doc)} v${source.n}` }
      : source.kind === "entity"
        ? { href: "/baseline", label: "Baseline" }
        : subject?.back;
  const back = backTo ? (
    <Link href={backTo.href} data-testid="impact-back" className="hover:underline">
      ← {backTo.label}
    </Link>
  ) : undefined;
  const counts = report ? countFreshness(report.affected) : null;
  const status = report && (
    <>
      {!can("act_on_staleness") && <ViewOnly />}
      <Chip kind={report.preview ? "acc" : "line"}>{report.preview ? "Preview" : "Recorded"}</Chip>
      {counts!.potentially_stale > 0 && (
        <Chip kind="warn" dot>
          {counts!.potentially_stale} potentially stale
        </Chip>
      )}
      {counts!.under_review > 0 && <Chip kind="na">{counts!.under_review} under review</Chip>}
    </>
  );
  // qa-plan-61: one sentence, "Impact: Guided setup", not the title and a suffix run together.
  const title = subject ? `Impact: ${subject.title}` : "Impact";

  return (
    <NamesContext.Provider value={names}>
    <Page>
      <PageHeader
        title={title}
        back={back}
        status={status}
        action={
          report && report.affected.length > 0 ? (
            <SegmentedControl<View>
              label="View"
              value={view}
              onChange={setView}
              items={[
                { value: "lineage", label: "Lineage" },
                { value: "table", label: "Table" },
              ]}
            />
          ) : undefined
        }
      />
      {q.error && !report ? (
        <Notice tone="error" action={source.kind === "version" ? <LinkButton href={`/documents/${source.doc}`}>Back to the document</LinkButton> : undefined}>
          {q.error}
        </Notice>
      ) : !report ? (
        <LoadingBoard />
      ) : (
        <div className="flex flex-col gap-4 max-[600px]:gap-3">
          <Notice>{intro(report, source, subject!)}</Notice>
          {report.truncated && (
            <Notice tone="warn">Lineage cut off at the walk limit (depth 8, 2000 nodes or 500 roots). Some outputs may be missing.</Notice>
          )}
          {q.error && <Notice tone="error">{q.error}</Notice>}
          {report.affected.length === 0 ? (
            <Panel>
              <Empty icon="check" testId="impact-empty">
                {source.kind === "version"
                  ? `No outputs depend on what v${source.n} changed. Nothing to regenerate.`
                  : "No outputs depend on this. Nothing to regenerate."}
              </Empty>
            </Panel>
          ) : view === "lineage" ? (
            // On a phone the plan and the inspector give way to the sheet (both mockups), so an
            // output's steps are drawn once; the CSS hides them before the media query answers.
            <Split
              inspector={
                !phone && (
                  <div className="max-[600px]:hidden">
                    <PlanSidebar report={report} source={source} selected={selected} onPick={pick} rowProps={rowProps} />
                  </div>
                )
              }
            >
              <Lineage report={report} source={source} subject={subject!} selected={selected} onPick={pick} />
              <AffectedList report={report} selected={selected} onPick={pick} />
            </Split>
          ) : (
            <Split
              inspector={
                selected &&
                !phone && (
                  <div className="max-[600px]:hidden">
                    <OutputInspector report={report} {...rowProps(selected)} />
                  </div>
                )
              }
            >
              <OutputTable report={report} selected={selected} onPick={pick} />
              <PlanList report={report} />
              {report.affected_entities.length > 0 && <EntitiesPanel report={report} />}
            </Split>
          )}
        </div>
      )}
      {report && selected && (
        <Sheet open={sheet && phone} title={outputTitle(selected)} onClose={() => setSheet(false)}>
          <OutputDetail report={report} {...rowProps(selected)} />
        </Sheet>
      )}
    </Page>
    </NamesContext.Provider>
  );
}

function countFreshness(affected: Output[]) {
  const c = { potentially_stale: 0, under_review: 0 };
  for (const o of affected) if (o.freshness === "potentially_stale" || o.freshness === "under_review") c[o.freshness] += 1;
  return c;
}

function intro(report: Report, source: ImpactSource, subject: SubjectWords): string {
  if (!report.preview) return "Recorded: this change marked these outputs Potentially stale.";
  if (source.kind === "entity") return `What if ${report.subject.title ?? subject.title} changed? Preview only; nothing is marked stale.`;
  const n = source.kind === "version" ? source.n : null;
  return `Preview: nothing has been marked stale. The lines show what each output was built from in earlier versions${
    n ? `; v${n} changed the sections in the middle column` : ""
  }.`;
}

function LoadingBoard() {
  return (
    <Panel title="Lineage" busy>
      <p role="status" className="sr-only">
        Loading the impact…
      </p>
      <div aria-hidden className="grid grid-cols-3 items-center gap-4 p-4 max-[600px]:grid-cols-1">
        <span className="h-12 animate-pulse rounded-button bg-surface2" />
        <div className="flex flex-col gap-3">
          <span className="h-7 animate-pulse rounded-button bg-surface2" />
          <span className="h-7 animate-pulse rounded-button bg-surface2" />
        </div>
        <div className="flex flex-col gap-3">
          <span className="h-7 animate-pulse rounded-button bg-surface2" />
          <span className="h-7 animate-pulse rounded-button bg-surface2" />
          <span className="h-7 animate-pulse rounded-button bg-surface2" />
        </div>
      </div>
    </Panel>
  );
}

// --- B: lineage graph -----------------------------------------------------------------

const ROW = 76;
const NODE = 64;
/** Column edges in percent of the graph's width: subject, upstreams, outputs. */
const COL = { subject: [0, 22], upstream: [30, 62], output: [70, 100] } as const;

type OutNode = { key: string; label: string; sub: string; freshness: Output["freshness"]; ups: Set<string>; output?: Output; category?: Output["category"]; count?: number };

function Lineage({
  report,
  source,
  subject,
  selected,
  onPick,
}: {
  report: Report;
  source: ImpactSource;
  subject: SubjectWords;
  selected: Output | null;
  onPick: (o: Output) => void;
}) {
  const names = useNamesOf();
  const [openCategory, setOpenCategory] = useState<Output["category"] | null>(null);
  const upstreamsOf = (o: Output) => upstreamsOfIn(o, names);
  const ups = (() => {
    const m = new Map<string, Upstream & { builtOn?: string }>();
    for (const o of report.affected) {
      for (const d of o.dependencies ?? []) {
        const u = upstreamOf(d, names);
        if (m.has(u.key)) continue;
        // qa-plan-58: a recorded change names one version (v2); the section it reached is that
        // version's, as the subject says. The version the outputs were built on is said apart.
        const v = subject.version;
        const up = d.upstream;
        if (source.kind === "change" && v && up.document_slug === v.slug && u.kind === "section") {
          const built = up.version_number != null && up.version_number !== v.n ? `Outputs were built on v${up.version_number}` : undefined;
          m.set(u.key, { ...u, sub: `Section of ${names.doc(v.slug)} v${v.n}`, builtOn: built });
        } else m.set(u.key, u);
      }
    }
    return [...m.values()];
  })();
  // Past GROUP_AT outputs, one node per category (its count and stalest freshness, edges
  // from all its outputs' upstreams); choosing one shows just that category's outputs.
  const grouped = report.affected.length > GROUP_AT;
  const nodes: OutNode[] = useMemo(() => {
    const shown = grouped && openCategory ? report.affected.filter((o) => o.category === openCategory) : report.affected;
    if (grouped && !openCategory) {
      const by = new Map<Output["category"], Output[]>();
      for (const o of report.affected) by.set(o.category, [...(by.get(o.category) ?? []), o]);
      return [...by.entries()].map(([c, os]) => ({
        key: `c:${c}`, label: CATEGORY[c], sub: `${os.length} outputs`, category: c, count: os.length,
        freshness: stalest(os.map((o) => o.freshness)), ups: new Set(os.flatMap((o) => upstreamsOfIn(o).map((u) => u.key))),
      }));
    }
    return shown.map((o) => ({
      key: keyOf(o), label: outputTitle(o), sub: statusLabel(o.status), freshness: o.freshness, output: o,
      ups: new Set(upstreamsOfIn(o).map((u) => u.key)),
    }));
  }, [report, grouped, openCategory]);
  const shownUps = ups.filter((u) => nodes.some((n) => n.ups.has(u.key)));
  const path = new Set(selected ? upstreamsOf(selected).map((u) => u.key) : []);
  const rows = Math.max(shownUps.length, nodes.length, 1);
  const height = rows * ROW;
  const y = (i: number, count: number) => (height - count * ROW) / 2 + i * ROW + NODE / 2 + 6;
  const subjectY = height / 2;
  const upY = new Map(shownUps.map((u, i) => [u.key, y(i, shownUps.length)]));
  const edge = (x1: number, y1: number, x2: number, y2: number) => {
    const xm = (x1 + x2) / 2;
    return `M ${x1} ${y1} C ${xm} ${y1}, ${xm} ${y2}, ${x2} ${y2}`;
  };

  return (
    <Panel
      title="Lineage"
      className="max-[600px]:hidden"
      tools={
        <>
          {grouped && openCategory && (
            <button type="button" onClick={() => setOpenCategory(null)} className="text-sm font-medium text-accent-ink hover:underline">
              All categories
            </button>
          )}
          <span className="flex items-center gap-3 text-[13px] text-text2">
            <span className="flex items-center gap-1.5"><i aria-hidden className="h-0.5 w-4 bg-line-strong" />depends on</span>
            <span className="flex items-center gap-1.5"><i aria-hidden className="h-0.5 w-4 bg-accent" />selected path</span>
            <span className="flex items-center gap-1.5"><i aria-hidden className="h-0 w-4 border-t-2 border-dashed border-crit" />deleted upstream</span>
          </span>
        </>
      }
    >
      <div className="grid grid-cols-[22fr_8fr_32fr_8fr_30fr] px-4 pt-3 text-[13px] font-semibold text-text2">
        <span>Subject</span>
        <span />
        <span>{source.kind === "change" ? "What it reached" : "Changed sections & baseline items"}</span>
        <span />
        <span>{grouped && !openCategory ? `Outputs by category · past ${GROUP_AT}` : "Affected outputs · stalest first"}</span>
      </div>
      <div className="overflow-x-auto p-4 pt-2">
        <div className="relative min-w-[640px]" style={{ height }}>
          <svg aria-hidden className="absolute inset-0 h-full w-full" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none">
            {shownUps.map((u) => {
              const on = path.has(u.key);
              return (
                <path
                  key={`s-${u.key}`}
                  d={edge(COL.subject[1], subjectY, COL.upstream[0], upY.get(u.key)!)}
                  fill="none"
                  vectorEffect="non-scaling-stroke"
                  strokeWidth={on ? 2.5 : 1.5}
                  strokeDasharray={u.deleted ? "5 4" : undefined}
                  className={u.deleted ? "stroke-crit" : on ? "stroke-accent" : "stroke-line-strong"}
                />
              );
            })}
            {nodes.flatMap((n, i) =>
              [...n.ups].filter((k) => upY.has(k)).map((k) => {
                const u = shownUps.find((x) => x.key === k)!;
                const on = selected != null && n.output != null && keyOf(n.output) === keyOf(selected);
                return (
                  <path
                    key={`o-${n.key}-${k}`}
                    d={edge(COL.upstream[1], upY.get(k)!, COL.output[0], y(i, nodes.length))}
                    fill="none"
                    vectorEffect="non-scaling-stroke"
                    strokeWidth={on ? 2.5 : 1.5}
                    strokeDasharray={u.deleted ? "5 4" : undefined}
                    className={u.deleted ? "stroke-crit" : on ? "stroke-accent" : "stroke-line-strong"}
                  />
                );
              }),
            )}
          </svg>
          <SubjectNode report={report} subject={subject} style={{ left: `${COL.subject[0]}%`, width: `${COL.subject[1] - COL.subject[0]}%`, top: subjectY - NODE / 2 }} />
          {shownUps.map((u, i) => (
            <div
              key={u.key}
              data-testid="lineage-upstream"
              data-on-path={path.has(u.key) ? "true" : "false"}
              className={`absolute flex flex-col justify-center rounded-button border bg-surface px-3 py-1.5 ${
                u.deleted ? "border-crit" : path.has(u.key) ? "border-accent" : "border-line"
              }`}
              style={{ left: `${COL.upstream[0]}%`, width: `${COL.upstream[1] - COL.upstream[0]}%`, top: y(i, shownUps.length) - NODE / 2, height: NODE }}
            >
              <span className="truncate text-sm font-semibold" title={u.label}>
                {u.label}
              </span>
              <span className="flex min-w-0 items-center gap-1.5 truncate text-[13px] text-text2">
                {u.deleted && <Chip kind="crit">Deleted</Chip>}
                {(() => {
                  const sub = u.deleted && u.deletedAt ? `${u.entityKey ?? u.label} · ${formatDate(u.deletedAt)}` : u.sub;
                  const built = u.builtOn;
                  return (
                    <span className="truncate" data-testid="lineage-upstream-sub" title={built ? `${sub}. ${built}.` : sub}>
                      {sub}
                    </span>
                  );
                })()}
                {u.entityId && !u.deleted && (
                  <Link href={`/impact/entities/${u.entityId}`} className="ml-auto flex-none font-medium text-accent-ink hover:underline">
                    What if {u.entityKey} changed?
                  </Link>
                )}
              </span>
            </div>
          ))}
          {nodes.map((n, i) => {
            const on = selected != null && n.output != null && keyOf(n.output) === keyOf(selected);
            const style = { left: `${COL.output[0]}%`, width: `${COL.output[1] - COL.output[0]}%`, top: y(i, nodes.length) - NODE / 2, height: NODE };
            const inner = (
              <>
                <span aria-hidden className={`w-1 flex-none self-stretch rounded-full ${BAR[n.freshness]}`} />
                <span className="flex min-w-0 flex-1 flex-col text-left">
                  <span className="truncate text-sm font-semibold" title={n.label}>
                    {n.label}
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-text2">
                    <Chip kind={FRESH[n.freshness].kind}>{FRESH[n.freshness].label}</Chip>
                    <span className="truncate" title={n.sub}>
                      {n.sub}
                    </span>
                  </span>
                </span>
              </>
            );
            return n.output ? (
              <button
                key={n.key}
                type="button"
                data-testid="lineage-output"
                aria-pressed={on}
                onClick={() => onPick(n.output!)}
                className={`absolute flex items-center gap-2.5 rounded-button border bg-surface px-2.5 hover:bg-surface2 ${on ? "border-accent ring-2 ring-accent/30" : "border-line"}`}
                style={style}
              >
                {inner}
              </button>
            ) : (
              <button
                key={n.key}
                type="button"
                data-testid="lineage-group"
                onClick={() => setOpenCategory(n.category!)}
                className="absolute flex items-center gap-2.5 rounded-button border border-line bg-surface px-2.5 hover:bg-surface2"
                style={style}
              >
                {inner}
              </button>
            );
          })}
        </div>
      </div>
    </Panel>
  );
}

const BAR: Record<Output["freshness"], string> = {
  fresh: "bg-pass",
  reconciled: "bg-pass",
  potentially_stale: "bg-warn",
  under_review: "bg-na",
};

/** The subject in words (qa-plan-10): "Checkout redesign PRD v2 › Success metrics section edited". */
function SubjectNode({ report, subject, style }: { report: Report; subject: SubjectWords; style: React.CSSProperties }) {
  const c = report.change;
  const sub = c ? `Recorded ${formatDate(c.created_at)}` : report.preview ? "Preview" : null;
  return (
    <div
      data-testid="lineage-subject"
      title={subject.title}
      className="absolute flex flex-col justify-center rounded-button border border-accent bg-accent-soft px-3 py-1.5 text-accent-ink"
      style={{ ...style, height: NODE }}
    >
      <span className={`text-sm leading-5 font-semibold [overflow-wrap:anywhere] ${sub ? "line-clamp-2" : "line-clamp-3"}`}>{subject.title}</span>
      {sub && <span className="truncate text-[13px]">{sub}</span>}
    </div>
  );
}

/** B's grouped list, instead of the graph on a phone only: outputs by what they were built from. */
function AffectedList({ report, selected, onPick }: { report: Report; selected: Output | null; onPick: (o: Output) => void }) {
  const names = useNamesOf();
  const groups = new Map<string, Output[]>();
  for (const o of report.affected) {
    const label = `From ${upstreamsOfIn(o, names).map((u) => u.short).join(", ") || "the subject"}`;
    groups.set(label, [...(groups.get(label) ?? []), o]);
  }
  return (
    <Panel title="Affected outputs" count={report.affected.length} className="min-[601px]:hidden">
      {/* qa-plan-60: on a phone the plan opens per output; say so, and how big it is. */}
      <p data-testid="impact-phone-hint" className="border-b border-line px-4 py-2 text-sm text-text2">
        {report.plan.length > 0
          ? `The regeneration plan has ${plural(report.plan.length, "proposal", "proposals")}. Tap an output to see its proposal and act on it.`
          : "Nothing to propose: the affected outputs are superseded or rejected. Tap an output to see why."}
      </p>
      {[...groups.entries()].map(([label, os]) => (
        <div key={label} className="border-b border-line last:border-b-0">
          <div className="bg-surface2 px-4 py-1.5 text-[13px] font-semibold text-text2">{label}</div>
          {os.map((o) => {
            const on = selected != null && keyOf(o) === keyOf(selected);
            return (
              <button
                key={keyOf(o)}
                type="button"
                aria-pressed={on}
                onClick={() => onPick(o)}
                className={`flex min-h-11 w-full items-center gap-2 border-t border-line px-4 py-2 text-left first:border-t-0 hover:bg-surface2 ${on ? "bg-accent-soft" : ""}`}
              >
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                  {outputTitle(o)}
                  {o.status === "superseded" || o.status === "rejected" ? ` · ${o.status}` : ""}
                </span>
                <Chip kind={FRESH[o.freshness].kind}>{FRESH[o.freshness].label}</Chip>
              </button>
            );
          })}
        </div>
      ))}
    </Panel>
  );
}

// --- the plan (B's sidebar), with C's stages on the selected row -------------------------

type RowPropsOf = (o: Output) => {
  output: Output;
  proposal: ReturnType<typeof proposalOf>;
  result: RowResult;
  onResult: (r: RowResult) => void;
  onChanged: () => void;
};

function notInPlan(report: Report): Output[] {
  return report.affected.filter((o) => !proposalOf(report, o));
}

function PlanSidebar({
  report,
  source,
  selected,
  onPick,
  rowProps,
}: {
  report: Report;
  source: ImpactSource;
  selected: Output | null;
  onPick: (o: Output) => void;
  rowProps: RowPropsOf;
}) {
  const names = useNamesOf();
  const byKey = new Map(report.affected.map((o) => [keyOf(o), o]));
  return (
    <Inspector
      label="Regeneration plan"
      eyebrow="Regeneration plan"
      title={`${report.plan.length} ${report.plan.length === 1 ? "proposal" : "proposals"}`}
      action={source.kind === "version" ? <LinkButton variant="hero" href={`/documents/${source.doc}/v/${source.n}`}>Open v{source.n}</LinkButton> : undefined}
      chips={
        <>
          <Chip hero>Approved versions are kept</Chip>
          <Chip hero>One row at a time</Chip>
        </>
      }
      stats={[
        { label: "Affected", value: report.counts.total ?? report.affected.length, testId: "plan-stat-affected" },
        { label: "In plan", value: report.plan.length, testId: "plan-stat-in-plan" },
        { label: "Approved", value: report.counts.approved ?? 0, testId: "plan-stat-approved" },
      ]}
    >
      {report.plan.length === 0 && (
        <InspectorSection>
          <p className="text-sm text-text2">
            {report.affected.length} {report.affected.length === 1 ? "output is" : "outputs are"} affected, but superseded or rejected, so there is nothing to propose.
          </p>
        </InspectorSection>
      )}
      <ol>
        {report.plan.map((p, i) => {
          const o = byKey.get(keyOf(p));
          const open = o != null && selected != null && keyOf(o) === keyOf(selected);
          return (
            <li key={keyOf(p)} data-testid="plan-row" className="border-b border-line px-5 py-3 max-[600px]:px-4">
              <button type="button" aria-expanded={open} onClick={() => o && onPick(o)} className="flex w-full items-start gap-2.5 text-left">
                <span className="tnum grid size-6 flex-none place-items-center rounded-full bg-accent-soft text-[13px] font-bold text-accent-ink">{i + 1}</span>
                <span className="min-w-0 flex-1 font-semibold [overflow-wrap:anywhere]">{o ? outputTitle(o) : p.title}</span>
                <Chip kind={p.action === "review" ? "warn" : "acc"}>{p.action === "review" ? "Review" : "Regenerate"}</Chip>
              </button>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-8">
                {o && (
                  <Chip kind={FRESH[o.freshness].kind} data-testid="plan-freshness">
                    {FRESH[o.freshness].label}
                  </Chip>
                )}
                {p.approved && <Chip kind="pass">Approved</Chip>}
              </div>
              {open && o ? (
                <div className="mt-2.5 flex flex-col gap-2.5 pl-8">
                  <ProposalBody proposal={p} />
                  <PlanSteps {...rowProps(o)} />
                </div>
              ) : (
                <p className="mt-1 line-clamp-2 pl-8 text-sm text-text2" title={names.words(p.how)}>
                  {names.words(p.how)}
                </p>
              )}
            </li>
          );
        })}
        {notInPlan(report).map((o) => (
          <li key={keyOf(o)} data-testid="plan-not-in-plan" className="border-b border-line px-5 py-3 last:border-b-0 max-[600px]:px-4">
            <div className="flex items-start gap-2.5">
              <span className="grid size-6 flex-none place-items-center text-text2">–</span>
              <span className="min-w-0 flex-1 font-semibold [overflow-wrap:anywhere]">{outputTitle(o)}</span>
              <Chip kind="na">No proposal</Chip>
            </div>
            <p className="mt-1 pl-8 text-sm text-text2">{statusLabel(o.status)}, so it is not in the plan.</p>
          </li>
        ))}
      </ol>
    </Inspector>
  );
}

function ProposalBody({ proposal }: { proposal: NonNullable<ReturnType<typeof proposalOf>> }) {
  const names = useNamesOf();
  return (
    <>
      {proposal.section_keys.length > 0 && (
        <div className="flex flex-wrap gap-1.5" data-testid="plan-sections">
          {proposal.section_keys.map((k) => (
            <Chip key={k} kind="line">
              {names.section(k)}
            </Chip>
          ))}
        </div>
      )}
      <p data-testid="plan-how" className="text-sm">
        {names.words(proposal.how)}
      </p>
      {proposal.reasons.length > 0 && (
        <ul className="list-disc pl-5 text-sm text-text2">
          {proposal.reasons.map((r) => (
            <li key={r}>{names.words(r)}</li>
          ))}
        </ul>
      )}
    </>
  );
}

// --- A: table + inspector ---------------------------------------------------------------

/** Mockup A's filter chips over the table. */
type Filter = "all" | "stale" | "approved";
const FILTER: Record<Filter, (o: Output) => boolean> = {
  all: () => true,
  stale: (o) => o.freshness === "potentially_stale",
  approved: (o) => o.approved,
};

function OutputTable({ report, selected, onPick }: { report: Report; selected: Output | null; onPick: (o: Output) => void }) {
  const names = useNamesOf();
  const columns: Column<Output>[] = [
    {
      key: "output",
      header: "Output",
      phone: "title",
      cell: (o) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium" title={outputTitle(o)}>
            {outputTitle(o)}
          </span>
          {(() => {
            const why = o.status === "superseded" || o.status === "rejected" ? `${statusLabel(o.status)} · no proposal` : names.words(o.reasons?.[0] ?? "");
            return (
              <span className="truncate text-[13px] text-text2" title={why}>
                {why}
              </span>
            );
          })()}
        </span>
      ),
    },
    { key: "freshness", header: "Freshness", width: "160px", cell: (o) => <Chip kind={FRESH[o.freshness].kind} dot>{FRESH[o.freshness].label}</Chip> },
    { key: "approval", header: "Approval", width: "120px", cell: (o) => statusLabel(o.status) },
    {
      key: "plan",
      header: "Plan",
      width: "110px",
      cell: (o) => {
        const p = proposalOf(report, o);
        return p ? (p.action === "review" ? "Review" : "Regenerate") : "—";
      },
    },
  ];
  const [filter, setFilter] = useState<Filter>("all");
  const shown = report.affected.filter((o) => FILTER[filter](o));
  const rows = [...shown].sort((a, b) => a.category.localeCompare(b.category));
  return (
    <Panel
      title="Affected outputs"
      count={report.affected.length}
      tools={
        <FilterChips<Filter>
          label="Filter outputs"
          value={filter}
          onChange={setFilter}
          items={[
            { value: "all", label: "All", count: report.affected.length },
            { value: "stale", label: "Potentially stale", count: report.affected.filter(FILTER.stale).length },
            { value: "approved", label: "Approved", count: report.affected.filter(FILTER.approved).length },
          ]}
        />
      }
    >
      <DataTable<Output>
        label="Affected outputs"
        columns={columns}
        rows={rows}
        rowKey={keyOf}
        selected={selected ? keyOf(selected) : null}
        onSelect={(_, o) => onPick(o)}
        group={(o) => o.category}
        groupLabel={(g) => `${CATEGORY[g as Output["category"]] ?? g} · ${rows.filter((o) => o.category === g).length}`}
      />
    </Panel>
  );
}

function PlanList({ report }: { report: Report }) {
  const names = useNamesOf();
  const byKey = new Map(report.affected.map((o) => [keyOf(o), o]));
  return (
    <Panel title="Regeneration plan" count={report.plan.length} tools={<span className="text-sm text-text2">Act on each row; nothing runs the whole plan at once</span>}>
      <ol>
        {report.plan.map((p, i) => {
          const o = byKey.get(keyOf(p));
          return (
            <li key={keyOf(p)} className="flex gap-3 border-b border-line px-4 py-3">
              <span className="tnum grid size-6 flex-none place-items-center rounded-full bg-accent-soft text-[13px] font-bold text-accent-ink">{i + 1}</span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold [overflow-wrap:anywhere]">{o ? outputTitle(o) : p.title}</span>
                  <Chip kind={p.action === "review" ? "warn" : "acc"}>{p.action === "review" ? "Review" : "Regenerate"}</Chip>
                  {p.section_keys.map((k) => (
                    <Chip key={k} kind="line">
                      {names.section(k)}
                    </Chip>
                  ))}
                  {p.entity_ids.length > 0 && <span className="text-[13px] text-text2">{p.entity_ids.length} baseline item{p.entity_ids.length === 1 ? "" : "s"}</span>}
                </div>
                <p className="text-sm text-text2">{names.words(p.how)}</p>
              </div>
            </li>
          );
        })}
        {notInPlan(report).map((o) => (
          <li key={keyOf(o)} className="flex gap-3 border-b border-line px-4 py-3 last:border-b-0">
            <span className="grid size-6 flex-none place-items-center text-text2">–</span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{outputTitle(o)}</span>
                <Chip kind="na">No proposal</Chip>
              </div>
              <p className="text-sm text-text2">{statusLabel(o.status)} outputs get no proposal.</p>
            </div>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function EntitiesPanel({ report }: { report: Report }) {
  return (
    <Panel title="Baseline items reached" count={report.affected_entities.length}>
      <ul>
        {report.affected_entities.map((e) => (
          <li key={e.id} className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5 text-sm last:border-b-0">
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
              {e.title} <span className="text-text2">({e.key})</span>
            </span>
            <span className="text-text2">
              {statusLabel(e.type)} · {e.status.replaceAll("_", " ")}
            </span>
            {e.confidence != null && <span className="tnum">{formatPercent(e.confidence)} confidence</span>}
            {e.locked && <Chip kind="line">Locked</Chip>}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function OutputInspector({ report, output, ...steps }: { report: Report; output: Output } & ReturnType<RowPropsOf>) {
  const deps = output.dependencies ?? [];
  const stale = deps.filter((d) => d.freshness !== "fresh").length;
  const since = deps.map((d) => d.stale_since).filter((x): x is string => Boolean(x)).sort()[0];
  return (
    <Inspector
      label={outputTitle(output)}
      eyebrow={`${CATEGORY[output.category]} · v${output.number}`}
      title={outputTitle(output)}
      chips={
        <>
          <Chip hero kind={FRESH[output.freshness].kind}>{FRESH[output.freshness].label}</Chip>
          <Chip hero>{statusLabel(output.status)}</Chip>
          {output.approved && <Chip hero>Keeps the approved version</Chip>}
        </>
      }
      stats={[
        { label: "Dependencies stale", value: stale, of: deps.length },
        { label: "Stale since", value: since ? shownDay(since, { month: "short", day: "numeric" }) : "—" },
      ]}
    >
      <OutputSections report={report} output={output} {...steps} />
    </Inspector>
  );
}

/** The inspector's (and the phone sheet's) sections: why, built from, proposal, the stages. */
function OutputSections({ report, output, ...steps }: { report: Report; output: Output } & ReturnType<RowPropsOf>) {
  const names = useNamesOf();
  const proposal = proposalOf(report, output);
  return (
    <>
      {(output.reasons ?? []).length > 0 && (
        <InspectorSection label="Why it's affected">
          <ul className="list-disc pl-5 text-sm">
            {output.reasons!.map((r) => (
              <li key={r}>{names.words(r)}</li>
            ))}
          </ul>
        </InspectorSection>
      )}
      <InspectorSection label="Built from">
        <ul className="flex flex-col gap-2">
          {(output.dependencies ?? []).map((d) => {
            const u = upstreamOf(d, names);
            return (
              <li key={d.id} data-testid="dependency" className="flex flex-col gap-0.5 text-sm">
                <span className="flex flex-wrap items-center gap-1.5">
                  <Chip kind={FRESH[d.freshness].kind}>{FRESH[d.freshness].label}</Chip>
                  <span className="min-w-0 [overflow-wrap:anywhere]">{upstreamLine(d, names)}</span>
                  {u.deleted && <Chip kind="crit">Deleted</Chip>}
                </span>
                <span className="flex flex-wrap gap-x-2 text-[13px] text-text2">
                  {u.deleted && u.deletedAt && <span>Removed {formatDate(u.deletedAt)}</span>}
                  {d.stale_since && <span>Stale since {formatDate(d.stale_since)}</span>}
                  {d.reconciled_at && <span>Reconciled {formatDate(d.reconciled_at)}</span>}
                  {d.upstream.composition_revision != null && !d.stale_since && <span>Composition revision {d.upstream.composition_revision}</span>}
                  {d.caused_by_change_id && (
                    <Link href={`/impact/changes/${d.caused_by_change_id}`} className="font-medium text-accent-ink hover:underline">
                      Recorded change
                    </Link>
                  )}
                  {u.entityId && !u.deleted && (
                    <Link href={`/impact/entities/${u.entityId}`} className="font-medium text-accent-ink hover:underline">
                      What if {u.entityKey} changed?
                    </Link>
                  )}
                </span>
                {d.note && <span className="text-[13px] text-text2">Note: {d.note}</span>}
              </li>
            );
          })}
        </ul>
      </InspectorSection>
      <InspectorSection label="Proposal">
        {proposal ? (
          <p className="text-sm">{names.words(proposal.how)}</p>
        ) : (
          <p className="text-sm text-text2">{statusLabel(output.status)}, so it is not in the plan.</p>
        )}
      </InspectorSection>
      {proposal && (
        <InspectorSection label="Act on it">
          <PlanSteps {...steps} output={output} proposal={proposal} />
        </InspectorSection>
      )}
    </>
  );
}

/** The phone sheet: an output's chips, then the inspector's sections. */
function OutputDetail({ report, output, ...steps }: { report: Report; output: Output } & ReturnType<RowPropsOf>) {
  const proposal = proposalOf(report, output);
  return (
    <div>
      <div className="flex flex-wrap gap-1.5 border-b border-line px-4 py-3">
        <Chip kind={FRESH[output.freshness].kind} dot>{FRESH[output.freshness].label}</Chip>
        <Chip kind="line">{statusLabel(output.status)}</Chip>
        {proposal && <Chip kind={proposal.action === "review" ? "warn" : "acc"}>{proposal.action === "review" ? "Review" : "Regenerate"}</Chip>}
      </div>
      <OutputSections report={report} output={output} {...steps} />
    </div>
  );
}
