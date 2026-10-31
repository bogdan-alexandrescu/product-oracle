"use client";
// MOCK-HOOK: this whole file is the mk-engcheck mock-up (never merged). It renders the
// Engineering check's features in the layout `?ec1=a|b|c|d` picks, and their questions as
// `?ec2=a|b|c` picks; `&sel=<feature key>` selects a feature at load.

import { useState, type ReactNode } from "react";

import { Button, Chip, SegmentedControl } from "@/components/ds";
import { INPUT } from "@/components/ui";
import type { Schemas } from "@/lib/api/client";

import type { BriefsCheck } from "../../../_lib";

type Review = Schemas["CheckpointReview"];
type Action = Review["items"][number]["actions"][number];
type Feature = BriefsCheck["features"][number];
type ActIn = Omit<Schemas["ActionIn"], "answers">;
type Verdict = "feasible" | "feasible_with_changes" | "not_feasible";

const SIZES = ["xs", "s", "m", "l", "xl"] as const;
const VERDICTS: { value: Verdict; label: string; needs?: string }[] = [
  { value: "feasible", label: "Feasible" },
  { value: "feasible_with_changes", label: "Feasible with changes", needs: "What changes" },
  { value: "not_feasible", label: "Not feasible as scoped", needs: "Why not as scoped" },
];
const WORDS: Record<Verdict, string> = { feasible: "Feasible", feasible_with_changes: "Feasible with changes", not_feasible: "Not feasible as scoped" };
const KIND = { feasible: "pass", feasible_with_changes: "warn", not_feasible: "crit" } as const;

/** MOCK-HOOK: a URL switch, read once on the client. */
export function useMockParam(name: string): string | null {
  // The review mounts only on the client, after its data loads, so the URL is there. // MOCK-HOOK
  const [v] = useState<string | null>(() => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get(name))); // MOCK-HOOK
  return v; // MOCK-HOOK
}

const edit = (acts: Action[], field: string) => acts.find((a) => a.kind === "edit" && a.field === field);
const verdictOf = (acts: Action[]) => edit(acts, "verdict")?.value as { verdict: Verdict; note?: string | null } | undefined;
const sizeOf = (acts: Action[], f: Feature) => (edit(acts, "size")?.value as string | undefined) ?? f.size;
const answeredOf = (acts: Action[], f: Feature) => f.questions.filter((q) => edit(acts, `answer:${q.id}`)).length;
const paras = (text: string) => text.split("\n").filter(Boolean);

export type MockProps = {
  ec1: string;
  ec2: string;
  features: Feature[];
  actsOf: (key: string) => Action[];
  writes: boolean;
  busy: boolean;
  onAct: (body: ActIn) => Promise<void>;
  initial: string | null;
};

/** The features, laid out as `ec1` picks. */
export function MockEngBody(p: MockProps) {
  const [sel, setSel] = useState<string>(p.initial ?? p.features[0]?.key ?? "");
  const [phoneDetail, setPhoneDetail] = useState(!!p.initial); // b on a phone: the list, or one feature
  const at = Math.max(0, p.features.findIndex((f) => f.key === sel));
  const f = p.features[at];
  const go = (i: number) => {
    const next = p.features[Math.min(p.features.length - 1, Math.max(0, i))];
    if (next) setSel(next.key);
  };
  const strip = p.ec2 === "c" ? <AllQuestions {...p} onOpen={(k) => (setSel(k), setPhoneDetail(true))} /> : null;

  if (p.ec1 === "a") {
    return (
      <>
        {strip}
        <div className="grid grid-cols-[minmax(0,1fr)_400px] items-start gap-4 max-[1100px]:grid-cols-1">
          <section aria-label="Features" className="min-w-0 rounded-panel border border-line bg-surface">
            <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,2.2fr)_minmax(0,1.1fr)_48px_minmax(0,0.9fr)] gap-3 border-b border-line px-4 py-2 text-[13px] font-semibold tracking-[0.02em] text-text2 max-[900px]:hidden">
              <span>Feature</span>
              <span>Approach</span>
              <span>Verdict</span>
              <span>Size</span>
              <span>Questions</span>
            </div>
            <ul>
              {p.features.map((x) => {
                const acts = p.actsOf(x.key);
                const v = verdictOf(acts);
                return (
                  <li key={x.key} data-testid="brief-row" data-feature={x.key} aria-current={x.key === sel ? "true" : undefined}>
                    <button
                      type="button"
                      onClick={() => setSel(x.key)}
                      className={`grid w-full grid-cols-[minmax(0,1.3fr)_minmax(0,2.2fr)_minmax(0,1.1fr)_48px_minmax(0,0.9fr)] items-start gap-3 border-b border-line px-4 py-3 text-left hover:bg-surface2 max-[900px]:grid-cols-1 max-[900px]:gap-1 ${x.key === sel ? "bg-accent-soft hover:bg-accent-soft" : ""}`}
                    >
                      <span className="min-w-0">
                        <span className="block font-semibold">{x.title}</span>
                        <span className="block font-mono text-[12px] text-text2">{x.key}</span>
                      </span>
                      <span className="line-clamp-2 min-w-0 text-sm text-text2">{x.approach.split("\n")[0]}</span>
                      <span>{v ? <Chip kind={KIND[v.verdict]} wrap>{WORDS[v.verdict]}</Chip> : <span className="text-sm text-text2">Not decided</span>}</span>
                      <span className="tnum font-semibold">{sizeOf(acts, x).toUpperCase()}</span>
                      <QCount f={x} acts={acts} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
          {f && (
            <aside
              aria-label={`Brief: ${f.title}`}
              data-testid="brief-inspector"
              className="sticky top-4 flex max-h-[calc(100vh-140px)] min-w-0 flex-col overflow-hidden rounded-inspector border border-line bg-surface shadow-panel max-[1100px]:static max-[1100px]:max-h-none"
            >
              <div className="flex-none border-b border-line px-5 pt-3.5 pb-3">
                <div className="text-[13px] font-semibold text-text2">
                  Feature {at + 1} of {p.features.length}
                </div>
                <h2 className="font-display text-[20px] leading-6 font-bold">{f.title}</h2>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto" data-testid="panel-scroll">
                <Decide key={f.key} {...p} f={f} />
                {p.ec2 === "b" && <Questions key={`q-${f.key}`} {...p} f={f} />}
                <Section label="Approach">
                  <Approach f={f} />
                </Section>
                {p.ec2 === "a" && <Questions key={`q-${f.key}`} {...p} f={f} />}
              </div>
            </aside>
          )}
        </div>
      </>
    );
  }

  if (p.ec1 === "c") {
    return (
      <>
        {strip}
        <ul className="flex flex-col gap-3">
          {p.features.map((x, i) => (
            <FeatureCard key={x.key} {...p} f={x} n={i + 1} />
          ))}
        </ul>
      </>
    );
  }

  if (p.ec1 === "d") {
    return (
      <>
        {strip}
        <nav aria-label="Features" className="mx-auto mb-3 flex max-w-[860px] flex-wrap items-center gap-1.5">
          {p.features.map((x, i) => {
            const v = verdictOf(p.actsOf(x.key));
            return (
              <button
                key={x.key}
                type="button"
                title={x.title}
                aria-label={`${i + 1}. ${x.title}${v ? `, ${WORDS[v.verdict]}` : ""}`}
                aria-current={x.key === sel ? "step" : undefined}
                onClick={() => setSel(x.key)}
                className={`tnum grid h-8 w-8 place-items-center rounded-full border text-sm font-semibold ${
                  x.key === sel ? "border-accent ring-2 ring-accent" : "border-line"
                } ${v ? (v.verdict === "feasible" ? "bg-pass-bg" : v.verdict === "not_feasible" ? "bg-crit-bg" : "bg-warn-bg") : "bg-surface"}`}
              >
                {i + 1}
              </button>
            );
          })}
          <span className="ml-2 text-sm text-text2">
            {p.features.filter((x) => verdictOf(p.actsOf(x.key))).length} of {p.features.length} decided
          </span>
        </nav>
        {f && (
          <article className="mx-auto max-w-[860px] rounded-panel border border-line bg-surface" data-testid="brief-inspector" aria-label={`Brief: ${f.title}`}>
            <header className="flex items-start gap-3 border-b border-line px-6 py-4">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold text-text2">
                  Feature {at + 1} of {p.features.length}
                </div>
                <h2 className="font-display text-[22px] leading-7 font-bold">{f.title}</h2>
                <div className="font-mono text-[12px] text-text2">{f.key}</div>
              </div>
            </header>
            <Section label="Approach">
              <Approach f={f} />
            </Section>
            {p.ec2 === "a" && <Questions key={`q-${f.key}`} {...p} f={f} />}
            <Decide key={f.key} {...p} f={f} wide />
            {p.ec2 === "b" && <Questions key={`q-${f.key}`} {...p} f={f} />}
            <div className="flex items-center gap-2 px-6 py-3">
              <Button variant="secondary" disabled={at === 0} onClick={() => go(at - 1)}>
                Previous
              </Button>
              <span className="flex-1" />
              <Button variant="primary" disabled={at === p.features.length - 1} onClick={() => go(at + 1)}>
                Next feature
              </Button>
            </div>
          </article>
        )}
      </>
    );
  }

  // b: a list of features on the left, the selected one in full on the right.
  return (
    <>
      {strip}
      <div className="grid grid-cols-[300px_minmax(0,1fr)] items-start gap-4 max-[900px]:grid-cols-1">
        <section
          aria-label="Features"
          className={`sticky top-4 max-h-[calc(100vh-140px)] min-w-0 overflow-y-auto rounded-panel border border-line bg-surface max-[900px]:static max-[900px]:max-h-none ${phoneDetail ? "max-[900px]:hidden" : ""}`}
        >
          <div className="border-b border-line px-4 py-2 text-[13px] font-semibold text-text2">{p.features.length} features</div>
          <ul>
            {p.features.map((x) => {
              const acts = p.actsOf(x.key);
              const v = verdictOf(acts);
              return (
                <li key={x.key} data-testid="brief-row" data-feature={x.key}>
                  <button
                    type="button"
                    aria-current={x.key === sel ? "true" : undefined}
                    onClick={() => (setSel(x.key), setPhoneDetail(true))}
                    className={`block w-full border-b border-line px-4 py-2.5 text-left hover:bg-surface2 ${x.key === sel ? "bg-accent-soft shadow-[inset_3px_0_0_var(--color-accent)] hover:bg-accent-soft" : ""}`}
                  >
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 font-semibold">{x.title}</span>
                      <span className="tnum text-sm font-semibold text-text2">{sizeOf(acts, x).toUpperCase()}</span>
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-1.5">
                      {v ? <Chip kind={KIND[v.verdict]} wrap>{WORDS[v.verdict]}</Chip> : <span className="text-sm text-text2">Not decided</span>}
                      <QCount f={x} acts={acts} short />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
        {f && (
          <article
            className={`min-w-0 rounded-panel border border-line bg-surface ${phoneDetail ? "" : "max-[900px]:hidden"}`}
            data-testid="brief-inspector"
            aria-label={`Brief: ${f.title}`}
          >
            <header className="flex items-start gap-3 border-b border-line px-6 py-4 max-[600px]:px-4">
              <div className="min-w-0 flex-1">
                <button type="button" className="mb-1 text-sm font-semibold text-accent min-[901px]:hidden" onClick={() => setPhoneDetail(false)}>
                  ‹ All features
                </button>
                <div className="text-[13px] font-semibold text-text2">
                  Feature {at + 1} of {p.features.length}
                  <span className="ml-2 font-mono font-normal">{f.key}</span>
                </div>
                <h2 className="font-display text-[22px] leading-7 font-bold">{f.title}</h2>
              </div>
              <div className="flex flex-none gap-1.5">
                <Button variant="secondary" disabled={at === 0} onClick={() => go(at - 1)} aria-label="Previous feature">
                  ‹
                </Button>
                <Button variant="secondary" disabled={at === p.features.length - 1} onClick={() => go(at + 1)} aria-label="Next feature">
                  ›
                </Button>
              </div>
            </header>
            <Decide key={f.key} {...p} f={f} wide />
            {p.ec2 === "b" && <Questions key={`q-${f.key}`} {...p} f={f} />}
            <Section label="Approach">
              <Approach f={f} />
            </Section>
            {p.ec2 === "a" && <Questions key={`q-${f.key}`} {...p} f={f} />}
          </article>
        )}
      </div>
    </>
  );
}

function Section({ label, children, tools }: { label: ReactNode; children: ReactNode; tools?: ReactNode }) {
  return (
    <section className="border-b border-line px-6 py-3.5 last:border-b-0 max-[600px]:px-4">
      <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold tracking-[0.02em] text-text2">
        {label}
        {tools && <span className="ml-auto">{tools}</span>}
      </div>
      {children}
    </section>
  );
}

function Approach({ f, clamp }: { f: Feature; clamp?: boolean }) {
  const [all, setAll] = useState(false);
  const ps = paras(f.approach);
  const shown = clamp && !all ? ps.slice(0, 3) : ps;
  return (
    <div className="max-w-[72ch] space-y-1.5 text-[15px] leading-6">
      {shown.map((t, i) => (
        <p key={i}>{t}</p>
      ))}
      {f.depends_on.length > 0 && <p className="text-sm text-text2">Depends on {f.depends_on.join(", ")}</p>}
      {clamp && ps.length > 3 && (
        <button type="button" className="text-sm font-semibold text-accent" onClick={() => setAll(!all)}>
          {all ? "Show less" : `Show all ${ps.length} points`}
        </button>
      )}
    </div>
  );
}

function QCount({ f, acts, short }: { f: Feature; acts: Action[]; short?: boolean }) {
  if (!f.questions.length) return short ? null : <span className="text-sm text-text2">None</span>;
  const done = answeredOf(acts, f);
  const open = f.questions.filter((q) => q.blocking && !edit(acts, `answer:${q.id}`)).length;
  return (
    <span className="text-sm" data-testid="brief-questions">
      {open ? <Chip kind="crit">{open} blocking</Chip> : null}{" "}
      <span className="whitespace-nowrap text-text2">
        {done} of {f.questions.length} answered
      </span>
    </span>
  );
}

/** Verdict and size: the choice the lead makes. */
function Decide({ f, actsOf, writes, busy, onAct, wide, inline }: MockProps & { f: Feature; wide?: boolean; inline?: boolean }) {
  const acts = actsOf(f.key);
  const current = verdictOf(acts);
  const [picking, setPicking] = useState<Verdict | null>(null);
  const [text, setText] = useState("");
  const need = VERDICTS.find((v) => v.value === picking)?.needs;
  const pick = (v: Verdict) => {
    if (v === "feasible") {
      setPicking(null);
      void onAct({ item_key: f.key, kind: "edit", field: "verdict", value: { verdict: v, note: null } });
    } else {
      setPicking(v);
      setText(current?.verdict === v ? (current.note ?? "") : "");
    }
  };
  const body = (
    <>
      <div className={`flex flex-wrap items-start gap-x-6 gap-y-3 ${wide ? "" : "flex-col"}`}>
        <div>
          <div className="mb-1.5 text-[13px] font-semibold text-text2">Verdict</div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Verdict">
            {VERDICTS.map((v) => (
              <Button key={v.value} variant={(picking ?? current?.verdict) === v.value ? "solid" : "secondary"} aria-pressed={(picking ?? current?.verdict) === v.value} disabled={busy || !writes} onClick={() => pick(v.value)}>
                {v.label}
              </Button>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-1.5 text-[13px] font-semibold text-text2">Size</div>
          <SegmentedControl
            label="Size"
            size="sm"
            items={SIZES.map((s) => ({ value: s, label: s.toUpperCase() }))}
            value={sizeOf(acts, f) as (typeof SIZES)[number]}
            onChange={(s) => void onAct({ item_key: f.key, kind: "edit", field: "size", value: s })}
          />
          <div className="mt-1 text-[12px] text-text2">Architect proposed {f.size.toUpperCase()}</div>
        </div>
      </div>
      {current?.note && !picking && (
        <p className="mt-2 text-sm" data-testid="verdict-note">
          <span className="font-semibold">{current.verdict === "not_feasible" ? "Why: " : "Changes: "}</span>
          {current.note}{" "}
          <button type="button" className="font-semibold text-accent" onClick={() => pick(current.verdict)}>
            Change
          </button>
        </p>
      )}
      {picking && need && (
        <div className="mt-2.5 max-w-[640px] space-y-1.5">
          <label className="block">
            <span className="mb-1 block text-sm font-semibold text-text2">{need}</span>
            <textarea className={`${INPUT} min-h-16`} aria-label={need} value={text} onChange={(e) => setText(e.target.value)} />
          </label>
          <div className="flex gap-1.5">
            <Button
              variant="primary"
              disabled={busy || !text.trim()}
              onClick={() => void onAct({ item_key: f.key, kind: "edit", field: "verdict", value: { verdict: picking, note: text.trim() } }).then(() => setPicking(null))}
            >
              Save verdict
            </Button>
            <Button variant="ghost" onClick={() => setPicking(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </>
  );
  if (inline) return <div data-testid="decide">{body}</div>;
  return (
    <section data-testid="decide" className="border-b border-line bg-surface2 px-6 py-3.5 max-[600px]:px-4">
      {body}
    </section>
  );
}

/** One question: open (a box to answer) or answered (the answer, no box, Change). */
function Question({ f, q, acts, writes, busy, onAct, compact }: { f: Feature; q: Feature["questions"][number]; acts: Action[]; writes: boolean; busy: boolean; onAct: MockProps["onAct"]; compact?: boolean }) {
  const answer = edit(acts, `answer:${q.id}`);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const open = !answer || editing;
  return (
    <li data-testid="brief-question" data-answered={answer ? "true" : "false"} className={compact ? "" : "rounded-md border border-line px-3 py-2.5"}>
      <p className="flex items-start gap-1.5">
        {answer && !editing ? (
          <span className="mt-0.5 text-pass" aria-label="Answered">
            ✓
          </span>
        ) : q.blocking ? (
          <Chip kind="crit">Blocking</Chip>
        ) : (
          <Chip kind="na">Question</Chip>
        )}
        <span className={answer && !editing ? "text-text2" : "font-semibold"}>{q.question}</span>
      </p>
      {answer && !editing && (
        <p className="mt-1 ml-5 text-[15px]" data-testid="answer">
          {String(answer.value)}{" "}
          <span className="text-sm text-text2">· {answer.updated_by?.name ?? answer.created_by?.name ?? "someone"}</span>{" "}
          {writes && (
            <button
              type="button"
              className="text-sm font-semibold text-accent"
              onClick={() => {
                setText(String(answer.value));
                setEditing(true);
              }}
            >
              Change
            </button>
          )}
        </p>
      )}
      {writes && open && (
        <div className="mt-1.5 flex gap-1.5">
          <input className={`${INPUT} h-9`} aria-label={`Answer: ${q.question}`} placeholder="Your answer" value={text} onChange={(e) => setText(e.target.value)} />
          <Button
            disabled={busy || !text.trim()}
            onClick={() => void onAct({ item_key: f.key, kind: "edit", field: `answer:${q.id}`, value: text.trim() }).then(() => (setEditing(false), setText("")))}
          >
            Answer
          </Button>
        </div>
      )}
    </li>
  );
}

function Questions({ f, actsOf, writes, busy, onAct }: MockProps & { f: Feature }) {
  const acts = actsOf(f.key);
  const done = answeredOf(acts, f);
  return (
    <Section label={f.questions.length ? `Architect's questions · ${done} of ${f.questions.length} answered` : "Architect's questions"}>
      {f.questions.length === 0 ? (
        <p className="text-text2">None for this feature.</p>
      ) : (
        <ul className="max-w-[760px] space-y-2">
          {f.questions.map((q) => (
            <Question key={q.id} f={f} q={q} acts={acts} writes={writes} busy={busy} onAct={onAct} />
          ))}
        </ul>
      )}
    </Section>
  );
}

/** ec2=c: every question of every feature in one list above the features; answered ones fold away. */
function AllQuestions({ features, actsOf, writes, busy, onAct, onOpen }: MockProps & { onOpen: (key: string) => void }) {
  const [showDone, setShowDone] = useState(false);
  const all = features.flatMap((f) => f.questions.map((q) => ({ f, q, acts: actsOf(f.key) })));
  const open = all.filter((x) => !edit(x.acts, `answer:${x.q.id}`));
  const done = all.filter((x) => edit(x.acts, `answer:${x.q.id}`));
  if (!all.length) return null;
  return (
    <section aria-label="Questions to answer" className="mb-4 rounded-panel border border-line bg-surface" data-testid="all-questions">
      <div className="flex items-center gap-2 border-b border-line px-5 py-2.5">
        <h2 className="font-semibold">Questions to answer</h2>
        <span className="text-sm text-text2">
          {open.length} open · {open.filter((x) => x.q.blocking).length} blocking
        </span>
        <span className="flex-1" />
        {done.length > 0 && (
          <button type="button" className="text-sm font-semibold text-accent" onClick={() => setShowDone(!showDone)}>
            {showDone ? "Hide answered" : `Show ${done.length} answered`}
          </button>
        )}
      </div>
      <ul className="grid grid-cols-2 gap-x-6 gap-y-3 px-5 py-3 max-[1100px]:grid-cols-1">
        {(showDone ? [...open, ...done] : open).map(({ f, q, acts }) => (
          <li key={`${f.key}-${q.id}`} className="min-w-0">
            <button type="button" className="mb-0.5 text-[13px] font-semibold text-accent hover:underline" onClick={() => onOpen(f.key)}>
              {f.title}
            </button>
            <ul>
              <Question f={f} q={q} acts={acts} writes={writes} busy={busy} onAct={onAct} compact />
            </ul>
          </li>
        ))}
        {open.length === 0 && !showDone && <li className="text-text2">Every question is answered.</li>}
      </ul>
    </section>
  );
}

/** ec1=c: one card per feature, decided in place. */
function FeatureCard(p: MockProps & { f: Feature; n: number }) {
  const { f, n } = p;
  const acts = p.actsOf(f.key);
  const v = verdictOf(acts);
  return (
    <li data-testid="brief-row" data-feature={f.key} className="rounded-panel border border-line bg-surface">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line px-6 py-3 max-[600px]:px-4">
        <span className="tnum text-sm font-semibold text-text2">{n}</span>
        <h2 className="font-display text-[19px] font-bold">{f.title}</h2>
        <span className="font-mono text-[12px] text-text2">{f.key}</span>
        <span className="flex-1" />
        {v ? <Chip kind={KIND[v.verdict]}>{WORDS[v.verdict]}</Chip> : <span className="text-sm text-text2">Not decided</span>}
      </header>
      <div className="px-6 py-3 max-[600px]:px-4">
        <Approach f={f} clamp />
      </div>
      {p.ec2 !== "c" && f.questions.length > 0 && (
        <div className="px-6 pb-3 max-[600px]:px-4">
          <ul className="max-w-[760px] space-y-2">
            {f.questions.map((q) => (
              <Question key={q.id} f={f} q={q} acts={acts} writes={p.writes} busy={p.busy} onAct={p.onAct} />
            ))}
          </ul>
        </div>
      )}
      <div className="border-t border-line bg-surface2 px-6 py-3 max-[600px]:px-4">
        <Decide {...p} f={f} wide inline />
      </div>
    </li>
  );
}
