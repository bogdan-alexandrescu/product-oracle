"use client";

/**
 * Current state beside Desired state (api/oracle/currentstate): the word pill every feature
 * carries (NEW, IN PROGRESS, EXISTS, EXISTS · PROOF OLD), its explainer, Priorities' Show filter,
 * Detailed's Desired state / Current state tabs, the proof table with Check again, and the
 * Ready to move band whose moves the owner confirms.
 */
import Link from "next/link";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Button, PageHeader } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatInZone, useCompanyZone } from "@/lib/dates";
import { errorMessage, useQuery } from "@/lib/use-query";

export type FeatureState = Schemas["FeatureStateOut"];
export type FeatureStates = Schemas["FeatureStatesOut"];
export type Mark = FeatureState["mark"];

export function useFeatureStates() {
  return useQuery<FeatureStates>("feature-states", () => unwrap(api.GET("/v1/feature-states")));
}

export const MARK_WORD: Record<Mark, string> = { new: "New", in_progress: "In progress", exists: "Exists", exists_old: "Exists · proof old" };

const MEANS: Record<Mark, string> = {
  new: "Asked for or planned. Nothing built yet.",
  in_progress: "Being built: some pull requests merged, tasks still open.",
  exists: "Runs today, with proof: code, merged pull requests, done tasks and a measured value.",
  exists_old: "Runs today, but its proof is more than 30 days old. Check it again in Current state.",
};

const TONE: Record<Mark, string> = {
  new: "bg-accent-soft text-accent-ink",
  in_progress: "bg-warn-bg text-warn",
  exists: "bg-pass-bg text-pass",
  exists_old: "bg-warn-bg text-warn",
};

/** The word pill. compact: a narrow spot (a roadmap bar), where the old-proof word is cut short. */
export function FeaturePill({ mark, compact = false }: { mark: Mark; compact?: boolean }) {
  return (
    <span data-testid="cs-mark" data-mark={mark} title={MARK_WORD[mark]} className={`inline-flex flex-none items-center whitespace-nowrap rounded-full px-2 py-px text-[12px] font-semibold uppercase tracking-wide ${TONE[mark]}`}>
      {compact && mark === "exists_old" ? "Exists ·!" : MARK_WORD[mark]}
    </span>
  );
}

const proof = (f: FeatureState, kind: Schemas["FeatureProofOut"]["kind"]) => f.proofs.find((p) => p.kind === kind);

/** The pill as a button: clicking it says what the mark means and its proof. */
export function PillButton({ f, compact = false }: { f: FeatureState; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", off);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", off);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <span ref={box} className="relative inline-flex">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className={`inline-flex items-center rounded-md ${open ? "ring-2 ring-accent ring-offset-2" : ""}`}
        aria-expanded={open}
        aria-label={`What ${MARK_WORD[f.mark]} means`}
      >
        <FeaturePill mark={f.mark} compact={compact} />
      </button>
      {open && <MarkCard f={f} />}
    </span>
  );
}

function MarkCard({ f }: { f: FeatureState }) {
  const prs = proof(f, "pull_requests");
  const tasks = proof(f, "tasks");
  const measured = proof(f, "measured");
  const exists = f.mark === "exists" || f.mark === "exists_old";
  return (
    <div role="dialog" aria-label={`${f.title}: ${MARK_WORD[f.mark]}`} onClick={(e) => e.stopPropagation()} className="absolute left-0 top-full z-30 mt-2 w-[360px] max-w-[calc(100vw-24px)] rounded-xl border border-line bg-surface p-4 text-left text-[14px] font-normal normal-case tracking-normal text-text shadow-xl" data-testid="cs-mark-card">
      <div className="mb-2 flex items-center gap-2">
        <FeaturePill mark={f.mark} />
        <span className="font-semibold">{f.title}</span>
      </div>
      <p className="mb-3 text-text2">{MEANS[f.mark]}</p>
      {f.no_proof_yet ? (
        <p>Marked as shipped: no proof yet. Oracle reads it tonight.</p>
      ) : f.mark === "new" ? (
        <p>No merged pull requests or done tasks yet.</p>
      ) : (
        <ul className="space-y-1">
          <li>{prs?.count ?? 0} merged pull requests</li>
          <li>
            {tasks?.count ?? 0} of {tasks?.total ?? 0} tracker tasks done
          </li>
          <li>{measured?.value ?? "No measured value yet"}</li>
        </ul>
      )}
      {!exists && <p className="mt-3 text-[13px] text-text2">It moves to Current state once it ships and its proof is in.</p>}
    </div>
  );
}

/** Priorities' Show filter: All and each kind, with how many there are. */
export function ShowFilter({ counts, pick, onPick }: { counts: Record<"new" | "in_progress" | "exists", number>; pick: "new" | "in_progress" | "exists" | null; onPick: (k: "new" | "in_progress" | "exists" | null) => void }) {
  const total = counts.new + counts.in_progress + counts.exists;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[length:var(--simple-small)]" data-testid="cs-legend" role="group" aria-label="Show features that are">
      <span className="mr-1 text-text2">Show</span>
      <button type="button" aria-pressed={!pick} onClick={() => onPick(null)} className={`rounded-full border px-3 py-1 ${!pick ? "border-accent bg-accent-soft font-semibold text-accent-ink" : "border-line bg-surface"}`}>
        All {total}
      </button>
      {(["new", "in_progress", "exists"] as const).map((s) => (
        <button key={s} type="button" aria-pressed={pick === s} aria-label={`${MARK_WORD[s]} ${counts[s]}`} onClick={() => onPick(pick === s ? null : s)} className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 ${pick === s ? "border-accent bg-accent-soft font-semibold text-accent-ink" : "border-line bg-surface"}`}>
          <FeaturePill mark={s} />
          <span className="tabular-nums text-text2">{counts[s]}</span>
        </button>
      ))}
    </div>
  );
}

/** Detailed's two tabs: Desired state (the baseline page, same URL) and Current state. */
export function StateTabs({ view, desired, running }: { view: "desired" | "current"; desired: number | null; running: number | null }) {
  const tabs = [
    { k: "desired", label: "Desired state", n: desired, tip: "What the product should become", href: "/baseline" },
    { k: "current", label: "Current state", n: running, tip: "What runs today", href: "/baseline?view=current" },
  ];
  return (
    <div role="tablist" aria-label="Desired state or Current state" className="mb-4 flex gap-1 border-b border-line" data-testid="cs-tabs">
      {tabs.map((t) => (
        <Link key={t.k} href={t.href} role="tab" aria-selected={view === t.k} title={t.tip} className={`-mb-px border-b-2 px-3 py-2 text-[14px] ${view === t.k ? "border-accent font-semibold text-text" : "border-transparent text-text2"}`}>
          {t.label} {t.n !== null && <span className="tabular-nums text-text2">{t.n}</span>}
        </Link>
      ))}
    </div>
  );
}

function useDay() {
  const zone = useCompanyZone();
  return (iso: string, year = false) => formatInZone(iso, zone, year ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" });
}

function Glyph({ old }: { old?: boolean }) {
  const tone = old ? "var(--warn)" : "var(--pass)";
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden className="flex-none">
      <circle cx={7} cy={7} r={5.5} fill={tone} stroke={tone} strokeWidth={1.8} />
      {old ? (
        <text x={7} y={7.5} textAnchor="middle" dominantBaseline="central" fontSize={9.8} fontWeight={800} fill="var(--surface)">
          !
        </text>
      ) : (
        <path d="M4.25 7 l2.1 2.3 l3.9 -5" stroke="var(--surface)" strokeWidth={1.6} fill="none" strokeLinecap="round" />
      )}
    </svg>
  );
}

function ProofWords({ f, wide = true }: { f: FeatureState; wide?: boolean }) {
  if (f.no_proof_yet) return <span className="text-[13px] text-text2">No proof yet</span>;
  const tasks = proof(f, "tasks");
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px] text-text2">
      <span title="Code map">{proof(f, "code_map")?.count ?? 0} files</span>
      <span title="Merged pull requests">{proof(f, "pull_requests")?.count ?? 0} pull requests</span>
      <span title="Tracker tasks marked done">
        {tasks?.count ?? 0}/{tasks?.total ?? 0} tasks
      </span>
      {wide && proof(f, "measured")?.value && (
        <span title="Measured value" className="text-text">
          {proof(f, "measured")?.value}
        </span>
      )}
    </span>
  );
}

function Line({ ok, children }: { ok: boolean | null; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2" data-ok={ok === null ? "" : String(ok)}>
      <span className={`mt-0.5 inline-flex h-4 w-4 flex-none items-center justify-center rounded-full text-[11px] font-bold ${ok === true ? "bg-pass text-surface" : ok === false ? "bg-warn text-surface" : "border border-line-strong"}`}>{ok === true ? "✓" : ok === false ? "!" : ""}</span>
      <span>{children}</span>
    </li>
  );
}

const ANSWERS: { k: Schemas["FeatureAnswerIn"]["answer"]; label: string; variant: "primary" | "secondary" | "ghost" }[] = [
  { k: "still_runs", label: "Yes, still runs", variant: "primary" },
  { k: "changed", label: "Something changed", variant: "secondary" },
  { k: "no_longer_runs", label: "No longer runs", variant: "ghost" },
];

/** Current state: one table of what runs today, old proof first, with Check again in place. */
export function ProofTable({ data, phone, onChanged }: { data: FeatureStates; phone: boolean; onChanged: (f: FeatureState) => void }) {
  const day = useDay();
  const zone = useCompanyZone();
  const [open, setOpen] = useState<string | null>(null);
  const [checked, setChecked] = useState<FeatureState | null>(null);
  const [checking, setChecking] = useState(false);
  const [done, setDone] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const running = data.features.filter((f) => f.mark === "exists" || f.mark === "exists_old");
  // Old proof first, then what moved today, then the rest by when it shipped.
  const rank = (f: FeatureState) => (f.mark === "exists_old" ? 0 : f.moved_at && f.proof_days === 0 ? 1 : 2);
  const rows = [...running].sort((a, b) => rank(a) - rank(b) || (a.shipped_at ?? "").localeCompare(b.shipped_at ?? ""));
  const check = async (f: FeatureState) => {
    setOpen(f.feature_id);
    setChecked(null);
    setChecking(true);
    setError(null);
    try {
      setChecked(await unwrap(api.POST("/v1/feature-states/{feature_id}/check", { params: { path: { feature_id: f.feature_id } } })));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setChecking(false);
    }
  };
  const answer = async (f: FeatureState, k: Schemas["FeatureAnswerIn"]["answer"]) => {
    setError(null);
    try {
      const out = await unwrap(api.POST("/v1/feature-states/{feature_id}/answer", { params: { path: { feature_id: f.feature_id } }, body: { answer: k } }));
      setDone((d) => ({ ...d, [f.feature_id]: k }));
      setOpen(null);
      onChanged(out);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const grid = "grid grid-cols-[minmax(170px,1.2fr)_96px_minmax(200px,2fr)_minmax(150px,1fr)] gap-3";
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface" data-testid="cs1-table">
      {!phone && (
        <div className={`${grid} border-b border-line bg-surface2 px-4 py-2 text-[12px] font-semibold uppercase tracking-wide text-text2`}>
          <span>Feature</span>
          <span>Shipped</span>
          <span>Proof</span>
          <span>Proof checked</span>
        </div>
      )}
      {rows.length === 0 && <p className="px-4 py-3 text-[14px] text-text2">Nothing runs today yet: a feature lands here once its proof is in and you say yes.</p>}
      {rows.map((f) => {
        const old = f.mark === "exists_old";
        const isOpen = open === f.feature_id;
        const said = done[f.feature_id];
        const proofs = checked && isOpen ? checked.proofs : f.proofs;
        const files = proofs.find((p) => p.kind === "code_map");
        const prs = proofs.find((p) => p.kind === "pull_requests");
        const tasks = proofs.find((p) => p.kind === "tasks");
        const measured = proofs.find((p) => p.kind === "measured");
        const ok = (p: Schemas["FeatureProofOut"] | undefined) => (checked && isOpen && !checking ? (p?.still_true ?? p?.ok ?? false) : null);
        return (
          <div key={f.feature_id} className={`border-b border-line last:border-b-0 ${old || isOpen ? "bg-warn-bg/40" : f.moved_at && f.proof_days === 0 ? "bg-pass-bg/60" : ""}`} data-testid="cs1-row">
            <div className={phone ? "space-y-1 px-3 py-2.5" : `${grid} items-center px-4 py-2.5`}>
              <span className="flex items-center gap-2 font-medium">
                <Glyph old={old} />
                {f.title}
              </span>
              <span className="text-[13px] text-text2">{f.shipped_at ? day(f.shipped_at, true) : "—"}</span>
              <ProofWords f={f} wide={!phone} />
              <span className="flex flex-wrap items-center gap-2">
                {f.moved_at && f.proof_days === 0 && !said ? (
                  <span className="text-[13px] font-semibold text-pass" data-testid="cs-moved-note">{movedNote(f, (iso) => day(iso))}</span>
                ) : isOpen && checking ? (
                  <span className="text-[13px] text-accent-ink">Checking now…</span>
                ) : said === "still_runs" && f.checked_at ? (
                  <span className="text-[13px] font-semibold text-pass">Checked {day(f.checked_at)} · you confirmed</span>
                ) : isOpen ? (
                  <span className="text-[13px] text-accent-ink">Checking now…</span>
                ) : old ? (
                  <span className="whitespace-nowrap rounded-full bg-warn-bg px-2 py-0.5 text-[13px] font-semibold text-warn">Proof is {f.proof_days} days old</span>
                ) : f.no_proof_yet ? (
                  <span className="whitespace-nowrap text-[13px] text-text2">No proof yet</span>
                ) : (
                  <span className="whitespace-nowrap text-[13px] text-text2">{f.checked_at ? `Checked ${day(f.checked_at)}` : "Not checked yet"}</span>
                )}
                {old && !isOpen && data.can_answer && (
                  <Button variant="secondary" onClick={() => void check(f)}>
                    Check again
                  </Button>
                )}
              </span>
            </div>
            {isOpen && (
              <div className="mx-4 mb-3 rounded-lg border border-line bg-surface p-3 text-[14px]" data-testid="cs1-check">
                <p className="mb-2 font-semibold">Is {f.title} still true today?</p>
                <ul className="mb-3 space-y-1.5">
                  <Line ok={ok(files)}>Code map: {files?.count ?? 0} files still in place</Line>
                  <Line ok={ok(prs)}>{prs?.count ?? 0} merged pull requests, none reverted</Line>
                  <Line ok={ok(tasks)}>
                    {tasks?.count ?? 0} of {tasks?.total ?? 0} tracker tasks done
                  </Line>
                  <Line ok={ok(measured)}>
                    Measured value: {measured?.value ?? "none yet"}
                    {measured?.period ? ` (${measured.period})` : ""}
                    {measured?.note && checked && !checking ? `. ${formatInZone(new Date().toISOString(), zone, { month: "long" })} not read yet` : ""}
                  </Line>
                </ul>
                {error && <p className="mb-2 text-[13px] text-fail">{error}</p>}
                <div className="flex flex-wrap gap-2">
                  {ANSWERS.map((a) => (
                    <Button key={a.k} variant={a.variant} disabled={checking} onClick={() => void answer(f, a.k)}>
                      {a.label}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}


/** The top of Current state: how many run, how many have old proof, how many are being built. */
export function CurrentSummary({ data }: { data: FeatureStates }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 text-[14px]" data-testid="cs-summary">
      <span>
        <b>{data.running}</b> running
      </span>
      {data.old_proof > 0 ? (
        <span className="text-warn">
          <b>{data.old_proof}</b> with old proof
        </span>
      ) : (
        <span className="text-text2">
          <b>0</b> with old proof
        </span>
      )}
      <span className="text-text2">{data.in_progress} in progress in Desired state</span>
      <span className="text-text2">· Oracle reads code maps, merged pull requests and done tasks each night; you confirm.</span>
    </div>
  );
}

/** Desired state's Ready to move band: features whose proof is in, each waiting for the owner's yes. */
export function ReadyBand({ data, onChanged }: { data: FeatureStates; onChanged: (f: FeatureState) => void }) {
  const [open, setOpen] = useState<FeatureState | null>(null);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = data.features.filter((f) => f.ready);
  if (ready.length === 0) return null;
  const decide = async (f: FeatureState, decision: "move" | "not_yet") => {
    setMoving(decision === "move");
    setError(null);
    try {
      const out = await unwrap(api.POST("/v1/feature-states/{feature_id}/move", { params: { path: { feature_id: f.feature_id } }, body: { decision } }));
      setOpen(null);
      onChanged(out);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setMoving(false);
    }
  };
  return (
    <>
      <div data-testid="cs3-ready" className="mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-pass-bg px-4 py-2.5 text-[14px]">
        <b>{ready.length} ready to move</b>: shipped, with proof. Each one needs your yes.
        <span className="ml-2 inline-flex flex-wrap gap-1.5">
          {ready.map((f) => (
            <button key={f.feature_id} type="button" onClick={() => setOpen(f)} className={`rounded-full border border-line bg-surface px-2.5 py-0.5 text-[13px] ${open?.feature_id === f.feature_id ? "ring-2 ring-accent" : ""}`}>
              {f.title}
            </button>
          ))}
        </span>
      </div>
      {open && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-3" data-testid="cs3-dialog" onClick={() => !moving && setOpen(null)}>
          <div role="dialog" aria-modal="true" aria-label={`Move ${open.title} to Current state`} onClick={(e) => e.stopPropagation()} className="w-[520px] max-w-full rounded-2xl border border-line bg-surface p-5 shadow-2xl">
            <h2 className="mb-1 text-[18px] font-semibold">Move {open.title} to Current state?</h2>
            <p className="mb-3 text-[14px] text-text2">Oracle found proof that it runs today:</p>
            <ul className="mb-4 space-y-1.5 text-[14px]">
              <Line ok>Code map: {proof(open, "code_map")?.count ?? 0} files</Line>
              <Line ok>{proof(open, "pull_requests")?.count ?? 0} pull requests merged</Line>
              <Line ok>
                {proof(open, "tasks")?.count ?? 0} of {proof(open, "tasks")?.total ?? 0} tracker tasks done
              </Line>
              <Line ok>{proof(open, "measured")?.value}</Line>
            </ul>
            {error && <p className="mb-2 text-[13px] text-fail">{error}</p>}
            {data.can_move ? (
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="ghost" disabled={moving} onClick={() => void decide(open, "not_yet")}>
                  Not yet
                </Button>
                <Button variant="primary" disabled={moving} onClick={() => void decide(open, "move")}>
                  {moving ? "Moving…" : "Move to Current state"}
                </Button>
              </div>
            ) : (
              <p className="text-[13px] text-text2">An approver or owner says yes to each move.</p>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** The note a moved feature carries in Current state: when and how it moved. */
export function movedNote(f: FeatureState, day: (iso: string) => string): string | null {
  if (!f.moved_at) return null;
  return `Moved ${day(f.moved_at)} · ${f.move_how === "marked_shipped" ? "marked as shipped" : "you confirmed"}`;
}

export { useDay };

/** Detailed › Current state: what runs today, each feature with its proof and how fresh it is. */
export function CurrentStateView({ q, onChanged }: { q: ReturnType<typeof useFeatureStates>; onChanged: () => void }) {
  const phone = usePhoneWidth();
  return (
    <>
      <PageHeader title="Current state" />
      <p className="-mt-2 mb-3 max-w-[760px] text-[14px] text-text2">What runs today: each built feature with its proof, and how fresh that proof is.</p>
      <StateTabs view="current" desired={q.data?.desired ?? null} running={q.data?.running ?? null} />
      {q.error && <p className="text-[14px] text-fail">{q.error}</p>}
      {q.data && (
        <>
          <CurrentSummary data={q.data} />
          <ProofTable data={q.data} phone={phone} onChanged={onChanged} />
        </>
      )}
    </>
  );
}

function usePhoneWidth(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const m = window.matchMedia("(max-width: 600px)");
    const on = () => setPhone(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return phone;
}

/** Each feature's state by its id, for the places that show a feature (a row, a bar, a line). */
export const FeatureMarks = createContext<Map<string, FeatureState> | null>(null);

export function useFeatureMarks(): Map<string, FeatureState> | null {
  const q = useFeatureStates();
  return useMemo(() => {
    if (!q.data) return null;
    const m = new Map(q.data.features.map((f) => [f.feature_id, f]));
    for (const f of q.data.features) for (const id of f.item_ids ?? []) m.set(`item:${id}`, f);
    return m;
  }, [q.data]);
}

/** A feature's pill wherever it is named, from FeatureMarks; nothing until the states are read. */
export function MarkFor({ featureId, compact = false }: { featureId: string | null | undefined; compact?: boolean }) {
  const marks = useContext(FeatureMarks);
  const f = featureId ? marks?.get(featureId) : undefined;
  return f ? <PillButton f={f} compact={compact} /> : null;
}

export type ShowKind = "new" | "in_progress" | "exists";
export const showsAs = (m: Mark): ShowKind => (m === "exists_old" ? "exists" : m);

/** Gives the page's features their pills (by feature id and by roadmap item id). */
export function WithFeatureMarks({ children }: { children: ReactNode }) {
  const marks = useFeatureMarks();
  return <FeatureMarks.Provider value={marks}>{children}</FeatureMarks.Provider>;
}

/** A roadmap item's pill: the feature it stands for. Inside the bar's own button (which opens the
 * item's panel), so the pill is a plain mark whose title says what it means. */
export function MarkForItem({ itemId, compact = false }: { itemId: string | null | undefined; compact?: boolean }) {
  const marks = useContext(FeatureMarks);
  const f = itemId ? marks?.get(`item:${itemId}`) : undefined;
  return f ? (
    <span title={`${MARK_WORD[f.mark]}: ${MEANS[f.mark]}`} className="inline-flex flex-none">
      <FeaturePill mark={f.mark} compact={compact} />
    </span>
  ) : null;
}
