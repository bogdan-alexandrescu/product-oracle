"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

import {
  Button,
  CardEyebrow,
  Chip,
  CodeChip,
  DataTable,
  HoverCard,
  Icon,
  InfoTip,
  Inspector,
  InspectorSection,
  Label,
  Meter,
  Notice,
  Page,
  PageHeader,
  Panel,
  Ring,
  Sheet,
  Split,
  ViewOnly,
  type ChipKind,
  type Column,
} from "@/components/ds";
import { usePhone } from "@/components/ds/page-info";
import { INPUT } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { named, namedText } from "@/lib/codes";
import { formatDateTime, isHttpUrl, plural } from "@/lib/format";
import { useMe } from "@/lib/me";
import { displayName } from "@/lib/names";
import { useScreenSubject } from "@/lib/screen-subject";
import { errorMessage, useQuery } from "@/lib/use-query";

import {
  ChangesPanel,
  NUMBERS_ONLY,
  OverrideSheet,
  RadioSwitch,
  RowActions,
  RowChips,
  YourChange,
  type Draft,
  type NameOf,
  type WhoOf,
} from "./_components/overrides";
import {
  confidencePercent,
  confidenceWords,
  dayText,
  evidenceName,
  formatScore,
  formulaText,
  inputLabel,
  scoreText,
  inputValueText,
  prdName,
  sourceName,
  stepWords,
} from "./_components/words";

type Method = Schemas["PriorityRanking"]["method"];
type RankedFeature = Schemas["RankedFeature"];
type CompareOut = Schemas["CompareOut"];
type CompareRow = Schemas["CompareRow"];
type PriorityProblem = Schemas["PriorityProblem"];

const METHODS: { method: Method; label: string }[] = [
  { method: "goal_weighted", label: "Goal-weighted" },
  { method: "rice", label: "RICE" },
  { method: "moscow", label: "MoSCoW" },
  { method: "wsjf", label: "WSJF" },
];
const METHOD_LABEL = Object.fromEntries(METHODS.map((m) => [m.method, m.label])) as Record<Method, string>;

/** Each flag: its label, a short one for the table's Flags column (qa-plan-49), its colour and meaning. */
const FLAGS: Record<string, { label: string; short?: string; kind: ChipKind; title: string }> = {
  no_confirmed_goal: {
    label: "Serves no confirmed goal",
    short: "No goal",
    kind: "crit",
    title: "Linked to no confirmed goal, so it is ranked after every feature that serves one.",
  },
  dependency_cycle: {
    label: "Dependency cycle",
    kind: "crit",
    title: "Part of a set of features that depend on each other.",
  },
  missing_inputs: { label: "Missing inputs", kind: "warn", title: "Some inputs this method needs are not set." },
  no_confidence: { label: "No confidence data", short: "No confidence", kind: "warn", title: "No evidence or confidence value: 50% assumed." },
  low_confidence: { label: "Low confidence", kind: "warn", title: "Confidence below 40%." },
  moved_for_dependency: {
    label: "Moved for a dependency",
    short: "Moved up",
    kind: "acc",
    title: "Placed earlier than its score because a higher-ranked feature depends on it.",
  },
  held_by_dependency: {
    label: "Held by a dependency",
    short: "Held back",
    kind: "warn",
    title: "A person's change could not place it above a feature it depends on.",
  },
};

const CONFIDENCE_SOURCE: Record<Schemas["ConfidenceUsed"]["source"], string> = {
  evidence: "from evidence",
  baseline: "from the baseline",
  attrs: "set on the feature",
  default: "assumed",
};

/** The check of a run's order (C8, oracle.priorities.run_order): a short label per code; the message is the chip's title. */
const PROBLEMS: Record<string, string> = {
  unreadable_yaml: "Unreadable file",
  wrong_version: "Wrong version",
  unknown_method: "Unknown method",
  duplicate_key: "Ranked twice",
  duplicate_rank: "Shared rank",
  rank_gap: "Gap in the ranks",
  unknown_feature: "Unknown feature",
  not_in_scope: "Not in the PRD scope",
  missing_feature: "Not ranked",
  before_prerequisite: "Above its prerequisite",
  differs_from_live: "Differs from live",
  no_goal: "No confirmed goal",
};

function ProblemChip({ p }: { p: PriorityProblem }) {
  return (
    <Chip kind={p.blocking ? "crit" : "warn"} title={p.message} data-testid={`problem-${p.code}`}>
      {PROBLEMS[p.code] ?? p.code.replace(/_/g, " ")}
      <span className="sr-only">: {p.message}</span>
    </Chip>
  );
}

/** Δ: how far the run ranks a feature above (↑) or below (↓) Oracle's live ranking. */
const deltaText = (d: number | null | undefined) => (d == null ? "—" : d === 0 ? "=" : d > 0 ? `↑${d}` : `↓${-d}`);

/** Flags that explain a row's place come first; the rest after, in this order. */
const FLAG_ORDER = [
  "dependency_cycle",
  "moved_for_dependency",
  "held_by_dependency",
  "no_confirmed_goal",
  "missing_inputs",
  "no_confidence",
  "low_confidence",
];
const flagRank = (f: string) => (FLAG_ORDER.includes(f) ? FLAG_ORDER.indexOf(f) : FLAG_ORDER.length);
const sortFlags = (flags: string[]) => [...flags].sort((a, b) => flagRank(a) - flagRank(b));

const flagOf = (flag: string) => FLAGS[flag] ?? { label: flag.replace(/_/g, " "), kind: "na" as const, title: flag };

/** A flag; in the table (compact) its short label on one line, the full one in its tooltip. */
function FlagChip({ flag, hero = false, compact = false }: { flag: string; hero?: boolean; compact?: boolean }) {
  const f = flagOf(flag);
  if (compact && f.short) {
    return (
      <Chip kind={f.kind} title={`${f.label}. ${f.title}`}>
        <span aria-hidden>{f.short}</span>
        <span className="sr-only">{f.label}</span>
      </Chip>
    );
  }
  return (
    <Chip kind={f.kind} hero={hero} title={compact ? `${f.label}. ${f.title}` : f.title} wrap={!compact}>
      {f.label}
    </Chip>
  );
}

/** The scorer's own rounding (two places), to find a factor in a step it wrote. */
const fmt = (n: number | null | undefined) => (n == null ? "—" : String(Math.round(n * 100) / 100));
/** Confidence 0-1 as 0-100, the ring's and the bar's fill; their figures are confidencePercent's. */
const pct = (n: number | null | undefined) => (n == null ? null : Math.round(n * 100));

/** A goal as words: its code and name ("G-B Growth"), never its key. */
const goalText = (key: string, title: string) => namedText(named(title, key));

/** A feature key as words: the ranked feature's name only, never its code (qa-plan-17). */
function featureText(features: RankedFeature[], key: string): string {
  return features.find((x) => x.key === key)?.title ?? key;
}

/** A feature key as its name only (beside other names, the code adds nothing). */
function featureName(features: RankedFeature[], key: string): string {
  return features.find((x) => x.key === key)?.title ?? key;
}

/**
 * A row's reason: a short label the chip shows on one line (qa-plan-49), the rest of the
 * sentence for screen readers and the tooltip, and why in general.
 */
type RankReason = { label: string; detail?: string; title: string; flag?: string };

/**
 * Why a row sits where its score alone would not put it (a higher score below it, or a lower
 * one above it): its own reason, in words, for the row itself. None when it is in score order.
 */
function rankReasons(f: RankedFeature, features: RankedFeature[], who: WhoOf): RankReason[] {
  const at = features.findIndex((x) => x.key === f.key);
  const s = (x: RankedFeature) => x.score ?? -Infinity;
  const outOfOrder =
    features.slice(0, at).some((x) => s(x) < s(f)) || features.slice(at + 1).some((x) => s(x) > s(f));
  if (!outOfOrder) return [];
  const out: RankReason[] = [];
  const names = (list: string) =>
    list
      .split(/,\s*/)
      .filter(Boolean)
      .map((k) => featureName(features, k));
  for (const o of f.explanation.order ?? []) {
    const earlier = o.match(/^placed earlier because (.+) depend\(s\) on it$/);
    if (earlier) {
      const n = names(earlier[1]!);
      out.push({
        label: "Ranked higher",
        detail: `: ${n.join(", ")} ${n.length > 1 ? "depend" : "depends"} on it`,
        title: "Placed above its score because a higher-ranked feature needs it first.",
        flag: "moved_for_dependency",
      });
    }
    const after = o.match(/^placed after its prerequisite\(s\) (.+)$/);
    if (after) {
      out.push({
        label: "Ranked lower",
        detail: `: depends on ${names(after[1]!).join(", ")}`,
        title: "Placed below its score because it needs these features first.",
      });
    }
  }
  if (f.flags.includes("dependency_cycle")) {
    out.push({ label: "Dependency cycle", title: "Part of a set of features that depend on each other: ordered by score until the cycle is broken.", flag: "dependency_cycle" });
  }
  if (!f.serves_goal) {
    out.push({
      label: "Ranked lower",
      detail: ": no confirmed goal",
      title: "Features that serve no confirmed goal rank after every feature that serves one, whatever their score.",
      flag: "no_confirmed_goal",
    });
  } else if (f.score == null) {
    const missing = f.explanation.missing.map(inputLabel).join(", ");
    out.push({
      label: "Not scored",
      detail: missing ? `: no ${missing}` : undefined,
      title: "Features with a goal but no score rank after the scored ones and before features with no goal.",
      flag: "missing_inputs",
    });
  }
  // A person moved or pinned a lower-scored feature above it (qa-plan-20): that says who,
  // beside any reason of its own, never left to read as a dependency's doing.
  const moved = (x: RankedFeature) => `${x.title} (moved by ${who(x.override!.by).name})`;
  const higher = features.slice(0, at).filter((x) => s(x) < s(f));
  const movedAbove = higher.filter((x) => !!x.override).map(moved);
  if (out.length === 0) {
    // Nothing of its own: features moved up for their dependencies sit above it.
    const above = higher.filter((x) => !x.override).map((x) => x.title);
    if (above.length > 0) {
      out.push({
        label: "Ranked lower",
        detail: `: below ${above.join(", ")}, placed earlier for a dependency`,
        title: "A feature that others depend on is placed above its score, so features scored higher can sit below it.",
      });
    }
    // Or it sits above features scored higher that rank lower for their own reason.
    const below = features
      .slice(at + 1)
      .filter((x) => s(x) > s(f))
      .map((x) => (x.override ? moved(x) : `${x.title} (${!x.serves_goal ? "no confirmed goal" : "waits for a dependency"})`));
    if (higher.length === 0 && below.length > 0) {
      out.push({
        label: "Ranked higher",
        detail: `: above ${below.join(", ")}`,
        title: "Features scored higher rank below this one: a person moved them, features with no confirmed goal come last, or a feature waits for those it depends on.",
      });
    }
  }
  if (movedAbove.length > 0) {
    out.push({
      label: "Ranked lower",
      detail: `: below ${movedAbove.join(", ")}`,
      title: "A person moved or pinned these features above their score.",
    });
  }
  return out;
}

/** Reasons with the same short label as one chip: their details and tips joined. */
function mergeReasons(reasons: RankReason[]): RankReason[] {
  const out: RankReason[] = [];
  for (const r of reasons) {
    const same = out.find((x) => x.label === r.label);
    if (!same) out.push({ ...r });
    else {
      const details = [same.detail, r.detail].map((d) => d?.replace(/^: /, "")).filter(Boolean);
      same.detail = details.length > 0 ? `: ${details.join("; ")}` : undefined;
      same.title = `${same.title} ${r.title}`;
      same.flag = same.flag ?? r.flag;
    }
  }
  return out;
}

type EvidenceUsed = Schemas["ConfidenceUsed"]["evidence"][number];

/** An evidence item by its source's title and date; its confidence and link in the card (#304). */
function EvidenceChip({ ev }: { ev: EvidenceUsed }) {
  const title = evidenceName(ev);
  const date = dayText(ev.date);
  const kind = sourceName(ev.source_kind);
  return (
    <HoverCard
      testId="evidence-chip"
      label={[title, date].filter(Boolean).join(", ")}
      className="max-w-full"
      trigger={
        <>
          <span className="min-w-0 truncate font-medium">{title}</span>
          {date && <span className="tnum flex-none text-text2">{date}</span>}
        </>
      }
    >
      <CardEyebrow>{["Evidence", kind].filter(Boolean).join(" · ")}</CardEyebrow>
      <span className="block font-semibold break-words">{title}</span>
      <span className="tnum mt-1 block text-text2">
        {[date, ev.confidence != null && `confidence ${confidencePercent(ev.confidence)}`].filter(Boolean).join(" · ")}
      </span>
      {/* Only an http(s) URL opens: an upload's file name or another scheme is no link. */}
      {ev.ref && isHttpUrl(ev.ref) && !ev.source_removed && (
        <a
          href={ev.ref}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-accent-ink hover:underline"
        >
          Open source ↗
        </a>
      )}
    </HoverCard>
  );
}

/**
 * A step with confidence as a percent wherever it is a factor, so its arithmetic stays true:
 * "score = 6 × 0.75 ÷ 2" reads "score = 6 × 75% ÷ 2", and "confidence = 0.75 × track record
 * 0.77 = 0.578" reads "confidence = 75% × track record 0.77 = 57.8%" (one way in every step).
 */
function stepText(step: string, confidence: number | null | undefined): string {
  const track = step.match(/^confidence = (\d+(?:\.\d+)?) × track record (\S+) = (\d+(?:\.\d+)?)$/);
  if (track) return `confidence = ${confidencePercent(Number(track[1]))} × track record ${track[2]} = ${confidencePercent(Number(track[3]))}`;
  if (confidence == null || !/^score\b/.test(step)) return step;
  // The last "× c": confidence is the last factor in every formula (impact comes before it in RICE).
  const factor = [` × ${confidence}`, ` × ${fmt(confidence)}`].find((f) => step.includes(f));
  if (!factor) return step;
  const at = step.lastIndexOf(factor);
  const end = at + factor.length;
  if (end < step.length && step[end] !== " ") return step;
  return `${step.slice(0, at)} × ${confidencePercent(confidence)}${step.slice(end)}`;
}

/** The ranking method: a radio group drawn as B1's segmented control. */
function MethodSwitch({ value, onChange, locked = false }: { value: Method; onChange: (m: Method) => void; locked?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent) => {
    if (locked || !["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(e.key)) return;
    e.preventDefault();
    const at = METHODS.findIndex((m) => m.method === value);
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
    const next = METHODS[(at + step + METHODS.length) % METHODS.length]!;
    onChange(next.method);
    ref.current?.querySelector<HTMLElement>(`[data-testid="method-${next.method}"]`)?.focus();
  };
  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label="Ranking method"
      onKeyDown={onKey}
      className="inline-flex max-w-full flex-none overflow-x-auto rounded-button border border-line-strong bg-surface max-[600px]:min-w-0 max-[600px]:flex-initial"
    >
      {METHODS.map((m) => {
        const on = value === m.method;
        return (
          <button
            key={m.method}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            data-testid={`method-${m.method}`}
            // A run's order is ranked by its own method: the switch is locked to it.
            disabled={locked && !on}
            title={locked && !on ? "The run's order is ranked by its own method" : undefined}
            onClick={() => onChange(m.method)}
            className={`flex h-9 items-center border-r border-line px-3.5 text-[15px] font-medium max-[600px]:px-2.5 max-[600px]:text-sm whitespace-nowrap last:border-r-0 disabled:cursor-not-allowed disabled:text-text2 ${
              on ? "bg-accent text-on-accent" : "text-text hover:bg-surface2 disabled:hover:bg-transparent"
            }`}
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * H3: how well past predictions held, as the factor it puts on confidence ("Track record
 * ×0.77 · 3 of 6 held"). Company-wide when it has enough assessed outcomes, else the lowest
 * goal's; nothing while there is too little record.
 */
function TrackRecord() {
  const q = useQuery("priorities|calibration", () => unwrap(api.GET("/v1/priorities/calibration")));
  const c = q.data;
  if (!c) return null;
  const goal = [...c.goals].filter((g) => g.factor != null).sort((a, b) => a.factor! - b.factor!)[0];
  const fig = c.company.factor != null ? c.company : goal;
  if (!fig || fig.factor == null) return null;
  return (
    <Notice tone="info">
      <span className="flex flex-wrap items-center gap-2" data-testid="track-record">
        <b className="tnum">
          Track record ×{fig.factor} · {fig.held} of {fig.n} held
        </b>
        {c.setting === "show" && <Chip kind="line">Shown, not applied</Chip>}
        <InfoTip label="Track record">
          Assessed predictions from the last year: held counts 1, partly held 0.5, not held 0. The factor is (held score
          + 1) ÷ (confidence predicted + 1), between {c.floor} and {c.ceiling}: a poor record lowers confidence, a good one
          never raises it. Each goal uses its own record once it has {c.min_outcomes} assessed predictions, otherwise the
          company&apos;s.
        </InfoTip>
      </span>
    </Notice>
  );
}

/** The selected feature: rank, confidence, score, then how the score was worked out. */
function FeatureInspector({
  f,
  id,
  run,
  change,
  features,
}: {
  f: RankedFeature;
  id: string;
  run?: CompareRow;
  change?: ReactNode;
  features: RankedFeature[];
}) {
  const e = f.explanation;
  // The steps name each goal by its code and name, not its key (#304).
  const words = (s: string) => e.goals.reduce((t, g) => t.split(`(${g.goal})`).join(`(${goalText(g.goal, g.title)})`), s);
  // A feature the run ranks that Oracle's live ranking lacks (a proposal of the run): its own line only.
  const live = !run || run.live_rank != null || f.entity_id !== "";
  const given = Object.entries(e.inputs ?? {}) as [string, Record<string, unknown> | null][];
  // Confidence is an input of every formula that multiplies by it: its row reads as the steps do.
  const inputs: [string, Record<string, unknown> | null][] =
    /confidence/.test(e.formula) && !given.some(([name]) => name === "confidence")
      ? [...given, ["confidence", { value: e.confidence.value, from: CONFIDENCE_SOURCE[e.confidence.source] }]]
      : given;
  return (
    <div id={id}>
      <Inspector
        eyebrow="Feature"
        title={f.title}
        label={`Feature ${f.title}`}
        testId="priority-inspector"
        // On the theme's card surface like every other card, not a dark hero (qa-plan-33).
        tone="card"
        chips={
          <>
            {f.flags.map((flag) => (
              <FlagChip key={flag} flag={flag} hero />
            ))}
          </>
        }
        stats={[
          {
            label: "Rank",
            value: f.formula_rank != null && f.formula_rank !== f.rank ? `#${f.rank} · Oracle #${f.formula_rank}` : `#${f.rank}`,
          },
          ...(run ? [{ label: "Live", value: run.live_rank == null ? "—" : `#${run.live_rank}` }] : []),
          { label: "Confidence", figure: <Ring value={pct(e.confidence.value)} text={confidencePercent(e.confidence.value)} size={46} /> },
          // The score always fits its tile (qa-plan-6): a long one ("5,400", "83.33") in smaller figures.
          { label: "Score", testId: "inspector-score", figure: <TileFigure text={scoreText(f.score, e.method)} /> },
        ]}
      >
        {run && (
          <InspectorSection label={`Why rank ${run.run_rank}`} testId="run-explanation">
            <p className="text-sm break-words">{run.run_explanation ?? "The run gave no explanation."}</p>
            <p className="tnum mt-1.5 text-sm text-text2">
              {run.live_rank == null ? "Not in Oracle's live ranking." : `Oracle's live ranking puts it #${run.live_rank} (${deltaText(run.delta)}).`}
            </p>
            {run.problems.length > 0 && (
              <ul className="mt-2 space-y-1 text-sm">
                {run.problems.map((p, i) => (
                  <li key={i} className="flex flex-col items-start gap-1">
                    <ProblemChip p={p} />
                    <span className="break-words">{p.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </InspectorSection>
        )}
        {change}
        {live && <div data-testid={`explanation-${f.key}`}>
          <InspectorSection
            label="Score"
            tools={
              <InfoTip label="Formula">
                <span>{formulaText(e.method, e.formula)}</span>
                {f.rank !== f.score_rank && <span className="mt-1 block">Rank by score alone: #{f.score_rank}</span>}
              </InfoTip>
            }
          >
            <ol className="tnum list-decimal space-y-1 pl-5 text-sm break-words" aria-label="Steps">
              {e.steps.map((s, i) => (
                <li key={i}>{words(stepWords(stepText(s, e.confidence.value), e.method))}</li>
              ))}
            </ol>
            {e.calibration && (
              <p className="mt-2 text-sm text-text2" data-testid="track-record-line">
                Track record ×{e.calibration.factor}
                {e.calibration.applied ? "" : " (shown, not applied)"}
                {e.calibration.basis ? ` · ${e.calibration.basis}` : ""}
              </p>
            )}
            {e.missing.length > 0 && (
              <p className="mt-2 flex flex-wrap items-center gap-1.5">
                <Chip kind="warn">Missing</Chip>
                <span className="text-sm">{e.missing.map(inputLabel).join(", ")}</span>
              </p>
            )}
          </InspectorSection>

          {inputs.length > 0 && (
            <InspectorSection label="Inputs">
              <table className="w-full table-fixed text-[13px] leading-5">
                <thead className="text-left text-text2">
                  <tr>
                    <th className="py-1 pr-2 font-semibold">Input</th>
                    <th className="w-[72px] py-1 pr-2 font-semibold">Value</th>
                    <th className="py-1 font-semibold">From</th>
                  </tr>
                </thead>
                <tbody>
                  {inputs.map(([name, v]) => (
                    <tr key={name} className="border-t border-line align-top">
                      <td className="py-1 pr-2 break-words">{inputLabel(name)}</td>
                      <td className="tnum py-1 pr-2 break-words">
                        {name === "confidence" && typeof v?.value === "number" ? confidencePercent(v.value) : inputValueText(name, v?.value)}
                      </td>
                      <td className="py-1 break-words text-text2">
                        {name === "goal_value"
                          ? v?.estimated
                            ? "A person's estimate"
                            : "The feature's goals"
                          : typeof v?.from === "string"
                            ? v.from.charAt(0).toUpperCase() + v.from.slice(1)
                            : v?.attr
                              ? // The Input column already names it: just where it came from (qa-plan-51).
                                inputLabel(String(v.attr)) === inputLabel(name)
                                ? "The feature"
                                : `The feature's ${inputLabel(String(v.attr)).toLowerCase()}`
                              : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </InspectorSection>
          )}

          {e.order && e.order.length > 0 && (
            <InspectorSection label="Order">
              <ul className="space-y-1.5 text-sm">
                {e.order.map((o, i) => (
                  <OrderReason key={i} reason={o} features={features} />
                ))}
              </ul>
            </InspectorSection>
          )}

          <InspectorSection
            label="Confidence"
            tools={
              <InfoTip label="Confidence used">
                <span data-testid="confidence-explain">{confidenceWords(e.confidence, e.calibration?.applied ? e.calibration.factor : null)}</span>
              </InfoTip>
            }
          >
            <div className="flex items-center gap-2.5">
              <b className="tnum" data-testid="confidence-figure">
                {confidencePercent(e.confidence.value)}
              </b>
              <span className="text-sm text-text2">{CONFIDENCE_SOURCE[e.confidence.source]}</span>
            </div>
            {e.confidence.evidence.length > 0 && (
              <ul className="mt-1.5 space-y-1 text-sm">
                {e.confidence.evidence.map((ev) => (
                  <li key={ev.id} className="flex min-w-0 items-center gap-2">
                    <span className="flex min-w-0 flex-1">
                      <EvidenceChip ev={ev} />
                    </span>
                    <span className="tnum flex-none text-text2" data-testid="evidence-confidence">
                      {ev.confidence != null ? confidencePercent(ev.confidence) : "—"}
                    </span>
                    {ev.source_removed && (
                      <Chip kind="na" data-testid="source-removed">
                        source removed
                      </Chip>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </InspectorSection>

          <InspectorSection label="Goals">
            {e.goals.length === 0 ? (
              <Chip kind="crit">Serves no confirmed goal</Chip>
            ) : (
              <ul className="space-y-2">
                {e.goals.map((g) => (
                  <li key={g.goal} className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <CodeChip kind="goal" entityKey={g.goal} title={g.title} wrap />
                    </div>
                    {g.parent && (
                      <div className="mt-0.5 text-[13px] text-text2" data-testid="goal-via-parent">
                        Subgoal of {g.parent_title ?? g.parent}: its weight is its share of the parent&apos;s
                      </div>
                    )}
                    <div className="tnum mt-1 flex flex-wrap items-center gap-x-1 text-[13px] text-text2">
                      Weight {formatScore(g.weight)}
                      {g.weight_assumed && <AssumedMark />} × contribution {formatScore(g.contribution)}
                      {g.contribution_assumed && <AssumedMark />} = {formatScore(g.term)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </InspectorSection>
        </div>}
      </Inspector>
    </div>
  );
}

/**
 * A tile's figure in the Numeral's face, sized to its length so it never runs past the
 * tile: 34 px up to four characters, then smaller; a very long one wraps, never cut.
 */
function TileFigure({ text }: { text: string }) {
  const size = text.length <= 4 ? "text-[34px] leading-9" : text.length <= 6 ? "text-[26px] leading-9" : "text-xl leading-9";
  return <span className={`tnum block font-display font-bold tracking-[-0.03em] break-all ${size}`}>{text}</span>;
}

/** A panel's count as neutral text: the panel's own count is accent blue, which reads as a link (qa-plan-27). */
function PlainCount({ n }: { n: number }) {
  return <span className="text-text2">{n}</span>;
}

function AssumedMark() {
  return (
    <span className="rounded-goal bg-warn-bg px-1.5 font-sans text-[13px] leading-5 font-semibold text-warn">assumed</span>
  );
}

type GoalRow = { id: string; title: string; count: number; top: number };

/** Each goal, the features ranked for it and its best rank. Derived from the ranking. */
function byGoal(features: RankedFeature[]): GoalRow[] {
  const m = new Map<string, GoalRow>();
  for (const f of features) {
    for (const g of f.explanation.goals) {
      const row = m.get(g.goal) ?? { id: g.goal, title: g.title, count: 0, top: f.rank };
      row.count += 1;
      row.top = Math.min(row.top, f.rank);
      m.set(g.goal, row);
    }
  }
  return [...m.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/**
 * Panel "Snapshots": the save controls (note and Save snapshot) sit with the list they add to
 * (qa-plan-20, qa-plan-21), so on a phone the ranking comes first and an empty list says how.
 */
function Snapshots({
  reloadKey,
  features,
  save,
}: {
  features: RankedFeature[];
  reloadKey: number;
  /** The note, Save snapshot and its notices; absent for who cannot save one. */
  save?: ReactNode;
}) {
  const q = useQuery(`priority-snapshots|${reloadKey}`, () => unwrap(api.GET("/v1/priorities/snapshots")));
  const list = q.data?.slice(0, 10);
  return (
    <Panel
      title="Snapshots"
      // A plain count in neutral text, never a link's blue (qa-plan-27).
      count={q.data?.length ? <PlainCount n={q.data.length} /> : undefined}
      testId="snapshots-panel"
    >
      {save && <div className="border-b border-line px-4 py-3 max-[600px]:px-3">{save}</div>}
      {q.error && (
        <div className="p-3">
          <Notice tone="error">{q.error}</Notice>
        </div>
      )}
      {q.loading && !q.data && <p className="px-4 py-3 text-text2">Loading…</p>}
      {q.data && q.data.length === 0 && (
        <p data-testid="snapshots-empty" className="px-4 py-6 text-center text-text2">
          {save ? "No snapshots yet. Save one above to keep this order and compare it later." : "No snapshots yet."}
        </p>
      )}
      {list && list.length > 0 && (
        <ul data-testid="snapshot-list">
          {list.map((s) => (
            <li
              key={s.id}
              className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-4 py-1.5 first:border-t-0 max-[600px]:px-3"
            >
              <span className="tnum">{formatDateTime(s.created_at)}</span>
              <Chip kind="acc">{METHOD_LABEL[s.method]}</Chip>
              {s.run_id && (
                <span className="min-w-0 truncate font-medium" data-testid="snapshot-prd">
                  {s.document ? `${prdName(s.document)} · ` : ""}approved order
                </span>
              )}
              <span className="tnum text-text2">{plural(s.feature_count, "feature")}</span>
              <span className="min-w-0 break-words text-text2">
                Top: {s.top.map((k) => featureText(features, k)).join(", ") || "—"}
              </span>
              {s.note && <span className="min-w-0 break-words text-text2">“{s.note}”</span>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** A row of a run's order the live ranking lacks: shown with the run's rank and line only. */
function placeholder(c: CompareRow, method: Method): RankedFeature {
  return {
    rank: c.run_rank,
    score_rank: c.run_rank,
    entity_id: "",
    key: c.key,
    title: c.title,
    status: "proposed",
    score: null,
    serves_goal: false,
    flags: [],
    depends_on: [],
    dependents: [],
    explanation: {
      method,
      formula: "",
      inputs: {},
      confidence: { value: 0, source: "default", explain: "", evidence: [] },
      goals: [],
      missing: [],
      steps: [],
      order: [],
    },
    run_explanation: c.run_explanation,
  };
}

const STATUS_TEXT = { saved: "Saved", proposed: "Proposed", discarded: "Discarded" } as const;

/**
 * Run mode's band (C8): whose order this is and where it stands, and the priority stop's
 * decision (the checkpoint decide route): Approve order, or Request changes with a note.
 */
function SnapshotBand({ c, onDecided }: { c: CompareOut; onDecided: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { snapshot: snap, run, checkpoint: cp } = c;
  const doc = snap.document;
  const prd = doc ? prdName(doc) : null;
  const deciding = snap.status === "proposed" && cp?.status === "pending";
  const blocked = cp?.cannot_approve ? `${cp.cannot_approve.charAt(0).toUpperCase()}${cp.cannot_approve.slice(1)}.` : null;

  async function decide(decision: "approved" | "changes_requested") {
    if (!run || !cp) return;
    setBusy(true);
    setError(null);
    try {
      await unwrap(
        api.POST("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/decide", {
          params: { path: { run_id: run.id, checkpoint_id: cp.id } },
          body: { decision, note: note.trim() || null },
        }),
      );
      setNote("");
      onDecided();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const line =
    snap.status === "proposed"
      ? [
          `Proposed by ${run?.flow_title ?? "a run"}`,
          prd,
          deciding && cp?.can_decide ? "waiting for you" : deciding ? `waiting for an ${cp?.approver_role ?? "approver"}` : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : snap.status === "saved"
        ? prd
          ? `Saved for ${prd}`
          : "Saved"
        : STATUS_TEXT.discarded;
  return (
    <section
      data-testid="snapshot-band"
      aria-label="The run's priority order"
      className="rounded-panel border border-line bg-surface px-4 py-3 max-[600px]:px-3"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Icon name="flag" size={16} className="text-accent-ink" />
        <span className="min-w-0 font-semibold break-words">{line}</span>
        <Chip kind={snap.status === "saved" ? "pass" : snap.status === "proposed" ? "warn" : "na"}>{STATUS_TEXT[snap.status ?? "saved"]}</Chip>
        <span className="flex-1" />
        {run && (
          <Link href={`/runs/${run.id}`} className="text-sm font-medium text-accent-ink hover:underline">
            Open the run
          </Link>
        )}
      </div>
      {deciding && cp?.can_decide && (
        <div className="mt-2.5">
          {blocked && (
            <p className="text-sm text-warn" data-testid="cannot-approve">
              {blocked}
            </p>
          )}
          <textarea
            aria-label="Note for the agents"
            placeholder="Note (required to request changes)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            className={`${INPUT} mt-2 placeholder:text-text2`}
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="solid" icon="check" disabled={busy || !!blocked} title={blocked ?? undefined} onClick={() => decide("approved")}>
              Approve order
            </Button>
            <Button disabled={busy || !note.trim()} onClick={() => decide("changes_requested")}>
              Request changes
            </Button>
          </div>
        </div>
      )}
      {error && (
        <div className="mt-2">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
    </section>
  );
}

const PRIORITIES_SUBJECT = { kind: "priorities" as const, subject: {} };

export default function PrioritiesPage() {
  // G7 3.3: the panel is about the priority order.
  useScreenSubject(PRIORITIES_SUBJECT, "Priority order");
  // The query string is read on the client: the page streams in under Suspense.
  return (
    <Suspense fallback={null}>
      <Priorities />
    </Suspense>
  );
}

function Priorities() {
  // Run mode (C8): /priorities?snapshot=<id> shows a run's order next to the live ranking.
  const snapshotId = useSearchParams().get("snapshot");
  const [compareKey, setCompareKey] = useState(0);
  const cq = useQuery(
    `priority-compare|${snapshotId}|${compareKey}`,
    () =>
      snapshotId
        ? unwrap(api.GET("/v1/priorities/snapshots/{snapshot_id}/compare", { params: { path: { snapshot_id: snapshotId } } }))
        : Promise.resolve(null),
    { keepPrevious: true },
  );
  const cmp = snapshotId ? (cq.data ?? null) : null;
  const [chosen, setMethod] = useState<Method>("goal_weighted");
  const method: Method = cmp?.snapshot.method ?? chosen;
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<Schemas["PrioritySnapshotOut"] | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [snapshotsKey, setSnapshotsKey] = useState(0);
  const [order, setOrder] = useState<"changes" | "oracle">("changes");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [changed, setChanged] = useState<string | null>(null);
  const [changeError, setChangeError] = useState<string | null>(null);
  const [changesKey, setChangesKey] = useState(0);
  const { can, capsReady } = useMe();
  const canSnapshot = can("create_priority_snapshot");
  // C9: approvers and owners move and pin features; everyone sees the changes. Not in run
  // mode (C8): a move or pin changes the live ranking, never a run's order.
  const canOverride = can("create_priority_override");
  const canChange = canOverride && !snapshotId;
  const withChanges = order === "changes";
  // qa-plan-14: on a phone the selected feature opens in a bottom sheet, as on Impact.
  const phone = usePhone();
  const [sheet, setSheet] = useState(false);
  const pick = (key: string) => {
    setSelected(key);
    if (phone) setSheet(true);
  };

  const q = useQuery(`priorities|${method}|${order}`, () =>
    unwrap(api.GET("/v1/priorities", { params: { query: { method, overrides: withChanges } } })),
  );
  const active = useQuery(`priority-overrides|live|${changesKey}`, () =>
    unwrap(api.GET("/v1/priorities/overrides", { params: { query: { limit: 200 } } })),
  );
  const r = q.data;
  const byKey = new Map(cmp?.rows.map((c) => [c.key, c]) ?? []);
  // Run mode: the run's order, each row its live RankedFeature at the run's rank.
  const stored = new Map(cmp?.snapshot.ranking.map((f) => [f.key, f]) ?? []);
  const runRows = cmp?.rows.map((c) => ({ ...(stored.get(c.key) ?? placeholder(c, method)), rank: c.run_rank }));
  const rows = cmp ? runRows : r?.features;
  const features = rows ?? [];
  // The selected feature, else the top of the ranking.
  const current = features.find((f) => f.key === selected) ?? features[0];
  const inspectorId = "priority-inspector";
  const anyOverride = withChanges && features.some((f) => f.override);
  const nameOf: NameOf = (key) => featureName(features, key);
  // qa4-plan-15: who made a change by name, from the people list; the email on hover.
  const people = useQuery("priorities|people", () => unwrap(api.GET("/v1/people", { params: { query: { limit: 500 } } })));
  const who: WhoOf = (by) => {
    const p = people.data?.find((x) => x.email === by);
    if (p) return { name: p.name, email: p.email };
    return by.includes("@") ? { name: displayName(by), email: by } : { name: by, email: null };
  };

  async function afterChange(notice: string | null) {
    setChanged(notice);
    setChangeError(null);
    setChangesKey((k) => k + 1);
    await q.reload();
  }

  async function removeChange(id: string) {
    try {
      await unwrap(
        api.DELETE("/v1/priorities/overrides/{override_id}", { params: { path: { override_id: id } }, body: {} }),
      );
      await afterChange(null);
    } catch (e) {
      setChangeError(errorMessage(e));
    }
  }

  /** "Move <prerequisite> too": the same change on what holds the feature, its reason prefilled. */
  function moveToo(prerequisite: string) {
    const f = current;
    const p = features.find((x) => x.key === prerequisite);
    if (!f?.override || !p) return;
    setSheet(false);
    const above = f.override.above ? (features.find((x) => x.key === f.override!.above) ?? null) : null;
    setDraft({ feature: p, kind: f.override.kind, above, position: f.override.position ?? null, reason: f.override.reason });
  }

  async function saveSnapshot() {
    setSaving(true);
    setSaveError(null);
    setSaved(null);
    try {
      const snap = await unwrap(
        api.POST("/v1/priorities/snapshots", { body: { method, note: note.trim() || null } }),
      );
      setSaved(snap);
      setNote("");
      setSnapshotsKey((k) => k + 1);
    } catch (e) {
      setSaveError(e instanceof Error && e.message ? e.message : errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  const runColumns: Column<RankedFeature>[] = cmp
    ? [
        {
          key: "live",
          header: "Live #",
          width: "64px",
          phone: "meta",
          phoneLabel: "Live",
          cell: (f) => (
            <span data-testid="live-rank" className="tnum" title="Rank in Oracle's live ranking of the same features">
              {byKey.get(f.key)?.live_rank ?? "—"}
            </span>
          ),
        },
        {
          key: "delta",
          header: "Δ",
          width: "56px",
          phone: "meta",
          phoneLabel: "Δ",
          cell: (f) => {
            const d = byKey.get(f.key)?.delta;
            return (
              <span
                data-testid="delta"
                className={`tnum ${d == null || d === 0 ? "text-text2" : "text-text"}`}
                title={d == null ? "Not in the live ranking" : d === 0 ? "Same rank as the live ranking" : `${Math.abs(d)} ${d > 0 ? "above" : "below"} the live ranking`}
              >
                {deltaText(d)}
              </span>
            );
          },
        },
      ]
    : [];
  const columns: Column<RankedFeature>[] = [
    {
      key: "rank",
      header: "#",
      width: "44px",
      phone: "meta",
      cell: (f) => (
        <b className="tnum font-semibold max-[600px]:text-text">
          <span className="hidden max-[600px]:inline">#</span>
          {f.rank}
        </b>
      ),
    },
    ...runColumns,
    ...(anyOverride
      ? [
          {
            key: "formula_rank",
            header: "Oracle #",
            width: "64px",
            phoneLabel: "Oracle #",
            cell: (f: RankedFeature) => (
              <span data-testid="formula-rank" className="tnum text-text2">
                {f.formula_rank ?? f.rank}
              </span>
            ),
          } satisfies Column<RankedFeature>,
        ]
      : []),
    {
      key: "feature",
      header: "Feature",
      phone: "title",
      // A long name wraps onto a second line, never cut (qa-plan-5).
      wrap: true,
      cell: (f) => {
        const on = current?.key === f.key;
        return (
          <button
            type="button"
            aria-expanded={on}
            aria-controls={inspectorId}
            onClick={(e: MouseEvent) => {
              e.stopPropagation();
              pick(f.key);
            }}
            className="block max-w-full text-left font-medium break-words hover:underline"
            data-testid="feature-name"
          >
            {f.title}
          </button>
        );
      },
    },
    {
      key: "goal",
      header: "Goal",
      // Wide enough that a goal's code and a word of its name share a line: a name wraps
      // between words, never inside one ("Scalin g"); no wider, so the Feature column keeps its
      // room beside the docked inspector and an approver's move column (qa-plan-5).
      width: "128px",
      // Every goal whole (prod-4, qa-plan-42): one per line, a long name on as many lines as it
      // needs, wrapped between words and never cut (qa5-plan-at-risk).
      wrap: true,
      cell: (f) =>
        f.explanation.goals.length === 0 ? (
          <span className="text-text2">—</span>
        ) : (
          <span className="flex min-w-0 flex-col items-start gap-1 py-0.5 max-[600px]:flex-row max-[600px]:flex-wrap" data-testid="row-goals">
            {f.explanation.goals.map((g) => (
              <CodeChip key={g.goal} kind="goal" entityKey={g.goal} title={g.title} wrap whole />
            ))}
          </span>
        ),
    },
    {
      key: "confidence",
      header: "Confidence",
      // The bar and its figure to the tenth ("57.8%").
      width: "112px",
      // A phone's card shows it too, as its figure beside the rank and score (qa-plan-52).
      phone: "meta",
      phoneLabel: "Confidence",
      // Kept at 1440 px and up with the inspector docked; only a table under 820 px drops it.
      narrow: "laptop",
      cell: (f) => {
        const v = f.explanation.confidence.value;
        if (v == null) return <span className="text-text2">—</span>;
        const text = confidencePercent(v);
        return (
          <>
            <div className="max-[600px]:hidden">
              <Meter value={pct(v)!} max={100} showMax={false} text={text} label={`Confidence ${text}`} />
            </div>
            <span className="tnum hidden max-[600px]:inline" data-testid="phone-confidence">
              {text}
            </span>
          </>
        );
      },
    },
    {
      key: "score",
      header: "Score",
      // Two decimals for every score, right-aligned in tabular figures (qa-plan-18).
      width: "84px",
      align: "right",
      phoneLabel: "Score",
      cell: (f) => (
        <span data-testid="score" className="tnum block text-right whitespace-nowrap max-[600px]:inline">
          {scoreText(f.score, method)}
        </span>
      ),
    },
    {
      key: "deps",
      header: "Depends on",
      width: "104px",
      hideOnPhone: true,
      // qa4-plan-1: with the Oracle # column it gives way under 1000 px (the inspector shows
      // it), so the Feature column keeps room for whole words.
      narrow: anyOverride ? "mid" : "laptop",
      wrap: true,
      cell: (f) => {
        const text = f.depends_on.map((k) => featureName(features, k)).join(", ");
        return (
          <span data-testid="row-deps" className="block text-[13px] leading-[18px] text-text2" title={text || undefined}>
            {text || "—"}
          </span>
        );
      },
    },
    {
      key: "flags",
      header: "Flags",
      // Its chips wrap, so the Feature column keeps its room (qa-plan-5).
      width: "144px",
      wrap: true,
      cell: (f) => {
        // A person's change leads; the flags fold into the count after it. Run mode: the
        // check's problems first (blocking red, advisory amber), every flag in the count.
        // Otherwise a row out of score order says why first (qa-plan-20).
        const changed = withChanges && (!!f.override || !!f.held_below);
        const reasons = changed || cmp ? [] : rankReasons(f, features, who);
        const told = new Set(reasons.map((r) => r.flag).filter(Boolean));
        const flags = sortFlags(f.flags).filter((x) => !told.has(x));
        const shown = changed || cmp || reasons.length > 0 ? 0 : 1;
        const rest = flags.slice(shown);
        return (
          // A blue chip is the card surface with an accent edge, never the selected row's blue
          // (qa-plan-48), and the same on every row: one look per flag (qa4-plan-9).
          <span
            data-testid="row-flags"
            className="flex flex-wrap items-center gap-1.5 py-0.5 [&_[data-kind=acc]]:bg-surface! [&_[data-kind=acc]]:shadow-[inset_0_0_0_1px_var(--accent)]"
          >
            {byKey.get(f.key)?.problems.map((p) => (
              <ProblemChip key={p.code} p={p} />
            ))}
            {changed && <RowChips f={f} name={nameOf} who={who} />}
            {/* One short chip per label, the full sentence in its tooltip (qa-plan-49). */}
            {mergeReasons(reasons).map((r) => (
              <Chip
                key={r.label}
                // One colour per label (qa4-plan-9): Ranked higher is blue whatever the reason.
                kind={r.label === "Ranked higher" ? "acc" : "warn"}
                title={`${r.label}${r.detail ?? ""}. ${r.title}`}
                data-testid="rank-reason"
              >
                {r.label}
                {r.detail && <span className="sr-only">{r.detail}</span>}
              </Chip>
            ))}
            {flags.slice(0, shown).map((flag) => (
              <FlagChip key={flag} flag={flag} compact />
            ))}
            {rest.length > 0 && (
              <Chip kind="na" title={rest.map((x) => flagOf(x).label).join(", ")}>
                +{rest.length}
                <span className="sr-only">{rest.map((x) => flagOf(x).label).join(", ")}</span>
              </Chip>
            )}
          </span>
        );
      },
    },
    // ▲ ▼ ⋯ in a column of their own: they never cover the flags (qa-plan-7).
    ...(canChange && withChanges
      ? [
          {
            key: "actions",
            header: <span className="sr-only">Move or pin</span>,
            width: "112px",
            align: "right",
            phone: "action",
            cell: (f: RankedFeature) => (
              <RowActions
                f={f}
                index={features.findIndex((x) => x.key === f.key)}
                features={features}
                onDraft={setDraft}
                onRemove={(id) => void removeChange(id)}
              />
            ),
          } satisfies Column<RankedFeature>,
        ]
      : []),
  ];

  const goals = byGoal(features);
  const counts = r?.counts;
  const inspector = current && (
    <FeatureInspector
      key={current.key}
      f={current}
      features={features}
      id={inspectorId}
      run={cmp ? byKey.get(current.key) : undefined}
      change={
        withChanges && (
          <YourChange
            f={current}
            o={active.data?.find((o) => o.id === current.override?.id)}
            canChange={canChange}
            onRemove={(id) => void removeChange(id)}
            onMoveToo={moveToo}
            name={nameOf}
            who={who}
          />
        )
      }
    />
  );

  // The note goes with the snapshot it is saved on (qa-plan-39), in the Snapshots panel.
  const saveControls = !snapshotId && canSnapshot && (
    <div className="flex flex-col gap-2">
      <div className="flex max-w-full flex-wrap items-end gap-2" data-testid="snapshot-save">
        <label className="flex min-w-0 flex-col gap-1 max-[600px]:w-full">
          <span className="text-[13px] font-semibold text-text2">Snapshot note (optional)</span>
          <input
            id="snapshot-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className={`${INPUT} !w-56 max-[600px]:!w-full`}
          />
        </label>
        <Button variant="primary" icon="check" onClick={saveSnapshot} disabled={saving || !r} title="Keep a dated copy of this ranking">
          {saving ? "Saving…" : "Save snapshot"}
        </Button>
      </div>
      {/* Short: the new row in the list below says what was saved (qa4-plan-14). */}
      {saved && <Notice tone="pass">Snapshot saved.</Notice>}
      {saveError && <Notice tone="error">{saveError}</Notice>}
    </div>
  );

  return (
    <Page>
      <PageHeader
        title="Priorities"
        status={
          counts && (
            <>
              {capsReady && !canSnapshot && !canOverride && <ViewOnly />}
              {/* The run's order lists its own features, not the whole live ranking. */}
              <Chip kind="acc">{cmp ? `${features.length} in the run's order` : `${counts.features} ranked`}</Chip>
              {counts.no_goal > 0 && <Chip kind="crit">{counts.no_goal} no goal</Chip>}
              {counts.unscored > 0 && <Chip kind="warn">{counts.unscored} unscored</Chip>}
              {counts.in_cycles > 0 && <Chip kind="warn">{counts.in_cycles} in a cycle</Chip>}
            </>
          )
        }
      />

      <div className="flex flex-col gap-3">
        {changed && <Notice tone="info">{changed}</Notice>}
        {changeError && <Notice tone="error">{changeError}</Notice>}
        {q.error && <Notice tone="error">{q.error}</Notice>}
        {snapshotId && cq.error && <Notice tone="error">{cq.error}</Notice>}
        <TrackRecord />
        {cmp && (
          <SnapshotBand
            c={cmp}
            onDecided={() => {
              setCompareKey((k) => k + 1);
              setSnapshotsKey((k) => k + 1);
            }}
          />
        )}

        <Split inspector={!phone && inspector}>
          <Panel>
            <div className="flex min-h-14 flex-wrap items-center gap-2.5 border-b border-line px-4 py-2.5 max-[600px]:px-3">
              {/* On a phone the method switch and the formula's (i) share one line that never
                  wraps (qa-plan-21); above it the wrapper dissolves and the (i) goes right. */}
              <div className="flex w-full min-w-0 flex-nowrap items-center gap-2 min-[601px]:contents">
              <MethodSwitch
                value={method}
                locked={!!snapshotId}
                onChange={(m) => {
                  setMethod(m);
                  setSaved(null);
                }}
              />
              {r && (
                <span className="flex flex-none items-center gap-2 min-[601px]:order-3" data-testid="formula-tip">
                  <Label className="max-[600px]:sr-only">Formula</Label>
                  <InfoTip label="Formula">
                    <span data-testid="formula">{formulaText(r.method, r.formula)}</span>
                    <span className="mt-1 block">Ranked {formatDateTime(r.generated_at)}, in dependency order.</span>
                  </InfoTip>
                </span>
              )}
              </div>
              {/* A view switch: read-only roles keep it too (qa-plan-22); only the write controls go. */}
              <div className="max-w-full">
                <RadioSwitch
                  label="Order"
                  items={[
                    { value: "changes", label: canOverride ? "With your changes" : "With people's changes" },
                    { value: "oracle", label: "Oracle's order" },
                  ]}
                  value={order}
                  onChange={setOrder}
                />
              </div>
              <span className="flex-1 max-[600px]:hidden min-[601px]:order-2" />
            </div>
            {r && r.cycles.length > 0 && (
              <div
                role="alert"
                data-testid="cycles-banner"
                className="flex flex-wrap items-center gap-2 border-b border-line bg-warn-bg px-4 py-2 text-sm font-semibold text-warn"
              >
                <Icon name="alert" size={16} />
                <span>{r.cycles.length > 1 ? "Cycles" : "Cycle"}</span>
                {r.cycles.map((c, i) => (
                  <span key={i} className="font-medium">
                    {i > 0 && "; "}
                    {c.map((k) => featureText(features, k)).join(" → ")}
                  </span>
                ))}
                <InfoTip label="Dependency cycle" align="start">
                  These features depend on each other, so they are ordered by score until the cycle is broken.
                </InfoTip>
              </div>
            )}
            <DataTable
              label="Ranking"
              testId="priority-table"
              columns={columns}
              rows={rows}
              rowKey={(f) => f.key}
              selected={current?.key ?? null}
              onSelect={(k) => pick(k)}
              loading={snapshotId ? cq.loading && !cmp : q.loading}
              empty="No features ranked"
              rowProps={(f) => ({ "data-testid": `priority-row-${f.key}` })}
            />
          </Panel>

          {goals.length > 0 && (
            <Panel title="By goal" count={<PlainCount n={goals.length} />}>
              <DataTable<GoalRow>
                label="By goal"
                columns={[
                  {
                    key: "title",
                    header: "Goal",
                    phone: "title",
                    cell: (g) => <CodeChip kind="goal" entityKey={g.id} title={g.title} />,
                  },
                  {
                    key: "count",
                    header: "Ranked features",
                    width: "180px",
                    // On a phone the count stays, as words beside the top rank (qa4-plan-17).
                    phone: "meta",
                    cell: (g) => (
                      <>
                        <div className="max-[600px]:hidden">
                          <Meter value={g.count} max={features.length} showMax={false} label={`${g.count} ranked features`} />
                        </div>
                        <span className="tnum hidden max-[600px]:inline" data-testid="goal-ranked">
                          {g.count} ranked
                        </span>
                      </>
                    ),
                  },
                  { key: "top", header: "Top rank", width: "96px", align: "right", phoneLabel: "Top", cell: (g) => <span className="tnum">#{g.top}</span> },
                ]}
                rows={goals}
                rowKey={(g) => g.id}
              />
            </Panel>
          )}

          <Snapshots reloadKey={snapshotsKey} features={features} save={saveControls} />

          <ChangesPanel reloadKey={changesKey} features={features} canChange={canChange} who={who} />
        </Split>
        {phone && current && (
          <Sheet open={sheet} title={current.title} onClose={() => setSheet(false)} testId="priority-sheet">
            {inspector}
          </Sheet>
        )}
        {draft && (
          <OverrideSheet
            key={`${draft.feature.key}|${draft.kind}|${draft.above?.key ?? draft.position ?? ""}`}
            draft={draft}
            features={features}
            onClose={() => setDraft(null)}
            onStored={(o) => {
              setDraft(null);
              const quiet = !["contradiction", "no_contradiction"].includes(o.reason_check.status);
              const held = o.held_below ? `Held below ${nameOf(o.held_below)}: it depends on it.` : null;
              void afterChange([quiet ? NUMBERS_ONLY : null, held].filter(Boolean).join(" ") || null);
            }}
          />
        )}
      </div>
    </Page>
  );
}

/**
 * The scorer's order reasons ("placed earlier because F-2 depend(s) on it") as a label and
 * feature chips (rule 1: no prose), the meaning behind an (i); a reason of another shape is
 * shown as given.
 */
const ORDER_REASONS: { re: RegExp; label: string; tip: string }[] = [
  {
    re: /^placed earlier because (.+) depend\(s\) on it$/,
    label: "Moved for",
    tip: "Ranked above its score because these features depend on it.",
  },
  {
    re: /^placed after its prerequisite\(s\) (.+)$/,
    label: "After",
    tip: "Ranked below its score because it depends on these features.",
  },
];

function OrderReason({ reason, features }: { reason: string; features: RankedFeature[] }) {
  for (const r of ORDER_REASONS) {
    const m = reason.match(r.re);
    if (!m) continue;
    const keys = m[1]!.split(/,\s*/).filter(Boolean);
    return (
      <li className="flex flex-wrap items-center gap-1.5" data-reason={reason}>
        <span className="font-semibold">{r.label}</span>
        {keys.map((k) => (
          <Chip key={k} kind="line">
            {featureText(features, k)}
          </Chip>
        ))}
        <InfoTip label={r.label}>{r.tip}</InfoTip>
      </li>
    );
  }
  return <li>{reason}</li>;
}
