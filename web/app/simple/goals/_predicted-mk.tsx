'use client';

// MOCK-HOOK file: every line here is a mock-up variant for mk-predicted (planned vs predicted dates), never merged.
// URL switches: ?pc1=a|b|c (form and place), ?pc2=a|b|c (what "predicted" says), ?pc3=a|b|c (the hard case),
// &mkdata=big (twenty features, four milestones), &mkcost=<text> (the cost badge on a frame).

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { InfoTip } from '@/components/ds';
import { predictedFor, type PmGoal, type PmMilestone } from '@/lib/api/mock/predicted-mk';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const t = (iso: string) => Date.parse(`${iso}T12:00:00Z`);
export const md = (iso: string | null) => (iso ? `${MON[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}` : '');
const days = (a: string, b: string) => Math.round((t(b) - t(a)) / 86_400_000);

export function mkParam(k: string): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get(k);
}
export const mkBig = () => mkParam('mkdata') === 'big' || !!mkParam('pc3');

/** Late, on time or early, in words, with its tone: never colour alone (a word and a shape go with it). */
export function verdict(planned: string, predicted: string | null) {
  if (!predicted) return { word: 'No date yet', short: 'No date', tone: 'na' as const, d: 0 };
  const d = days(planned, predicted);
  if (d > 0) return { word: `${d} ${d === 1 ? 'day' : 'days'} late`, short: `+${d}d`, tone: (d > 7 ? 'crit' : 'warn') as 'crit' | 'warn', d };
  if (d < 0) return { word: `${-d} ${d === -1 ? 'day' : 'days'} early`, short: `${d}d`, tone: 'pass' as const, d };
  return { word: 'On time', short: 'On time', tone: 'pass' as const, d };
}
/** PC2 b: late as a range, read from the same spread the band draws ("5–19 days late"). */
export function verdictRange(planned: string, predicted: string | null, r: number) {
  const v = verdict(planned, predicted);
  if (!predicted || mkParam('pc2') !== 'b') return v;
  const lo = v.d - r;
  const hi = v.d + r;
  if (lo > 0) return { ...v, word: `${lo}–${hi} days late` };
  if (hi > 0) return { ...v, tone: 'warn' as const, word: `Up to ${hi} days late` };
  return { ...v, word: v.d === 0 ? 'On time' : `${-hi}–${-lo} days early` };
}
/** PC1 (any): the Roadmap milestone chip's own mark follows the predicted date, so a chip never shows a check beside "9 days late". */
export function mkMsStatus(code: string): 'on_track' | 'at_risk' | null {
  if (!mkParam('pc1') && !mkParam('pc2') && !mkParam('pc3')) return null;
  for (const g of ['Sign-ups per rep per day', 'Paid conversions per rep per day', 'Revenue per day']) {
    const m = predictedFor(g, mkBig())?.milestones.find((x) => x.code === code);
    if (m) return verdict(m.planned, m.predicted).d > 0 ? 'at_risk' : 'on_track';
  }
  return null;
}
const TONE = {
  crit: 'bg-crit-bg text-crit',
  warn: 'bg-warn-bg text-warn',
  pass: 'bg-pass-bg text-pass',
  na: 'bg-na-bg text-na',
};
const INK = { crit: 'var(--crit)', warn: 'var(--warn)', pass: 'var(--pass)', na: 'var(--na)' };
const MARK = { crit: '▲', warn: '▲', pass: '✓', na: '–' };

export function Chip({ v, testId }: { v: ReturnType<typeof verdict>; testId?: string }) {
  return (
    <span data-testid={testId} className={`inline-flex items-center gap-1 rounded-full px-1.5 text-xs font-semibold whitespace-nowrap ${TONE[v.tone]}`}>
      <span aria-hidden>{MARK[v.tone]}</span>
      {v.word}
    </span>
  );
}

type Open = (featureName: string) => void;
function codeOf(p: PmGoal, name: string | null) {
  return p.features.find((f) => f.name === name)?.code ?? '';
}
function Driver({ p, name, onOpen, label = 'Set by' }: { p: PmGoal; name: string | null; onOpen: Open; label?: string }) {
  if (!name) return <span className="text-text2">No feature has an end date yet</span>;
  return (
    <span className="min-w-0">
      <span className="text-text2">{label} </span>
      <button type="button" data-testid="pm-driver" onClick={() => onOpen(name)} className="inline text-left font-semibold text-accent-ink hover:underline focus-visible:underline">
        <span className="tnum">{codeOf(p, name)}</span> {name}
      </button>
    </span>
  );
}

/** One line: the planned date (an open diamond) and the predicted date (a filled dot), the gap between them. */
function DateLine({ planned, predicted, lo, hi, h = 14, ticks }: { planned: string; predicted: string | null; lo: number; hi: number; h?: number; ticks?: { at: string; strong?: boolean }[] }) {
  const x = (iso: string) => `${((t(iso) - lo) / (hi - lo)) * 100}%`;
  const v = verdict(planned, predicted);
  const a = predicted && t(predicted) < t(planned) ? predicted : planned;
  const b = predicted && t(predicted) > t(planned) ? predicted : planned;
  return (
    <span className="relative block w-full" style={{ height: h }} role="img" aria-label={`Due ${md(planned)}, predicted ${predicted ? md(predicted) : 'not yet'}`}>
      <span className="absolute inset-x-0 top-1/2 h-px bg-line" />
      {predicted && <span className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full" style={{ left: x(a), width: `calc(${x(b)} - ${x(a)})`, background: INK[v.tone], opacity: 0.35 }} />}
      {ticks?.map((k, i) => (
        <span key={i} className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ left: x(k.at), width: k.strong ? 3 : 1, height: k.strong ? h : h * 0.6, background: k.strong ? INK[v.tone] : 'var(--text-faint)' }} />
      ))}
      <span className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 border-2 border-text2 bg-surface" style={{ left: x(planned) }} title={`Due ${md(planned)}`} />
      {predicted && <span className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ left: x(predicted), background: INK[v.tone] }} title={`Predicted ${md(predicted)}`} />}
    </span>
  );
}
function span(p: PmGoal, ms: PmMilestone[] = p.milestones, extra: string[] = []) {
  const all = [p.planned, ...(p.predicted ? [p.predicted] : []), ...ms.flatMap((m) => [m.planned, ...(m.predicted ? [m.predicted] : [])]), ...extra].map(t);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const pad = (hi - lo) * 0.06 + 86_400_000;
  return [lo - pad, hi + pad] as const;
}
function Legend() {
  return (
    <span className="flex items-center gap-3 text-xs text-text2">
      <span className="flex items-center gap-1"><span className="size-2 rotate-45 border-2 border-text2" />Due</span>
      <span className="flex items-center gap-1"><span className="size-2 rounded-full bg-text2" />Predicted</span>
    </span>
  );
}

/** A small card-anchored panel, a bottom sheet on a phone; Esc or a click outside closes it. */
function Pop({ onClose, children, title }: { onClose: () => void; children: ReactNode; title: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const d = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('[data-pm-keep]') && onClose();
    window.addEventListener('keydown', k);
    window.addEventListener('mousedown', d);
    return () => (window.removeEventListener('keydown', k), window.removeEventListener('mousedown', d));
  }, [onClose]);
  // Fixed to the page, under its control and inside the window, so a scrolling grid never clips it.
  const [at, setAt] = useState<CSSProperties>({ position: 'fixed', visibility: 'hidden' });
  useLayoutEffect(() => {
    const a = ref.current?.parentElement?.getBoundingClientRect();
    if (!a || window.innerWidth <= 600) return setAt({});
    const w = 380;
    const left = Math.max(8, Math.min(a.left, window.innerWidth - w - 16));
    setAt({ position: 'fixed', top: a.bottom + 4, left, maxHeight: window.innerHeight - a.bottom - 12, overflowY: 'auto' });
  }, []);
  return (
    <div ref={ref} role="dialog" aria-label={title} data-testid="pm-pop" style={at} className="z-30 flex w-[380px] flex-col gap-2 rounded-xl border border-line bg-surface p-3 text-sm shadow-lg max-[600px]:fixed max-[600px]:inset-x-2 max-[600px]:top-auto max-[600px]:bottom-[72px] max-[600px]:max-h-[62vh] max-[600px]:w-auto max-[600px]:overflow-y-auto">
      <div className="flex items-center justify-between gap-2">
        <b className="text-base">{title}</b>
        <button type="button" aria-label="Close" onClick={onClose} className="rounded-md px-1.5 text-text2 hover:bg-surface2">✕</button>
      </div>
      {children}
    </div>
  );
}

/** The confidence and reason, behind an (i) (PC2 a and the default). */
function Why({ p, label }: { p: PmGoal; label: string }) {
  const undated = p.total - p.dated;
  return (
    <InfoTip label={`${label}'s predicted date`} testId="pm-why" side="top" align="end">
      <span className="flex flex-col gap-1">
        {mkParam('pc2') === 'b' ? (
          <b>Latest end date, widened by past slips (avg +{p.slipRate} days){undated ? ` and ${undated} undated ${undated === 1 ? 'feature' : 'features'}` : ''}</b>
        ) : (
          <b>Read from the latest feature end date</b>
        )}
        {p.driver && <span>{codeOf(p, p.driver)} {p.driver} ends {md(p.predicted)}</span>}
        <span>{p.dated} of {p.total} features have an end date</span>
      </span>
    </InfoTip>
  );
}

function MilestoneLines({ p, onOpen, lo, hi, ticks }: { p: PmGoal; onOpen: Open; lo: number; hi: number; ticks?: boolean }) {
  return (
    <ul className="flex flex-col gap-2" data-testid="pm-milestones">
      {p.milestones.map((m) => (
        <li key={m.code} className="flex flex-col gap-0.5" data-testid="pm-milestone">
          <span className="flex items-baseline gap-1.5">
            <b className="text-accent-ink">{m.code}</b>
            <span className="min-w-0 flex-1" title={m.name}>{m.name}</span>
            <Chip v={verdictRange(m.planned, m.predicted, range(p))} />
          </span>
          {mkParam('pc2') === 'b' && m.predicted ? <Band p={{ ...p, planned: m.planned, predicted: m.predicted }} lo={lo} hi={hi} /> : <DateLine planned={m.planned} predicted={m.predicted} lo={lo} hi={hi} ticks={ticks ? p.features.filter((f) => f.ms === m.code && f.end).map((f) => ({ at: f.end!, strong: f.name === m.driver })) : undefined} />}
          <span className="flex flex-col gap-0.5 text-xs">
            <span className="tnum text-text2">Due {md(m.planned)}{m.predicted ? ` · predicted ${mkParam('pc2') === 'b' ? `${md(shift(m.predicted, -range(p)))} – ${md(shift(m.predicted, range(p)))}` : md(m.predicted)}` : ''}</span>
            <Driver p={p} name={m.driver} onOpen={onOpen} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** PC3 c: features ranked by how far they push the goal past its date. */
function Ranked({ p, onOpen }: { p: PmGoal; onOpen: Open }) {
  const [all, setAll] = useState(false);
  const rows = p.features
    .map((f) => ({ f, late: f.end ? days(p.milestones.find((m) => m.code === f.ms)?.planned ?? p.planned, f.end) : null }))
    .sort((a, b) => (b.late ?? -999) - (a.late ?? -999));
  const max = Math.max(1, ...rows.map((r) => r.late ?? 0));
  const shown = all ? rows : rows.slice(0, 6);
  return (
    <div className="flex flex-col gap-1" data-testid="pm-ranked">
      <span className="text-xs font-semibold text-text2">Features by days past their milestone's date</span>
      <ul className={`flex flex-col gap-1 ${all ? 'max-h-[280px] overflow-y-auto' : ''}`}>
        {shown.map(({ f, late }) => (
          <li key={f.code} className="grid grid-cols-[minmax(0,1fr)_88px_64px] items-center gap-2 text-xs">
            <button type="button" data-testid="pm-driver" onClick={() => onOpen(f.name)} className="truncate text-left hover:underline" title={`${f.code} ${f.name}`}>
              <b className="tnum">{f.code}</b> {f.name}
            </button>
            <span className="h-2 rounded-full bg-surface2">
              {late != null && late > 0 && <span className="block h-full rounded-full" style={{ width: `${(late / max) * 100}%`, background: INK[late > 7 ? 'crit' : 'warn'] }} />}
            </span>
            <span className={`tnum text-right ${late == null ? 'text-na' : late > 0 ? 'font-semibold text-crit' : 'text-pass'}`}>
              {late == null ? 'No date' : late > 0 ? `+${late} days` : 'On time'}
            </span>
          </li>
        ))}
      </ul>
      {rows.length > 6 && (
        <button type="button" data-testid="pm-all" onClick={() => setAll(!all)} className="self-start text-xs font-semibold text-accent-ink hover:underline">
          {all ? 'Show fewer' : `Show all ${rows.length}`}
        </button>
      )}
    </div>
  );
}

/** PC1 b: the predicted date week by week against the flat planned date. */
function Drift({ p, w, h, labels }: { p: PmGoal; w: number; h: number; labels?: boolean }) {
  const pts = p.history.filter((x) => x.predicted);
  if (!pts.length) return <span className="mt-3 block w-full border-t border-dashed border-line" />;
  const ys = [p.planned, ...pts.map((x) => x.predicted!)].map(t);
  const lo = Math.min(...ys) - 86_400_000 * 2;
  const hi = Math.max(...ys) + 86_400_000 * 2;
  const pad = labels ? 46 : 2;
  const X = (i: number) => pad + (i / (p.history.length - 1)) * (w - pad - 4);
  const Y = (iso: string) => h - 4 - ((t(iso) - lo) / (hi - lo)) * (h - 8);
  const v = verdict(p.planned, p.predicted);
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h + (labels ? 14 : 0)}`} role="img" aria-label={`Predicted date by week, now ${md(p.predicted)}, due ${md(p.planned)}`} data-testid="pm-drift">
      <line x1={pad} x2={w - 4} y1={Y(p.planned)} y2={Y(p.planned)} stroke="var(--text2)" strokeDasharray="4 3" strokeWidth="1.5" />
      <polyline fill="none" stroke={INK[v.tone]} strokeWidth="2" points={p.history.map((x, i) => (x.predicted ? `${X(i)},${Y(x.predicted)}` : '')).join(' ')} />
      {p.history.map((x, i) => x.predicted && <circle key={i} cx={X(i)} cy={Y(x.predicted)} r={i === p.history.length - 1 ? 3.5 : 2} fill={INK[v.tone]} />)}
      {labels && (
        <>
          <text x={0} y={Y(p.planned) + 4} fontSize="11" fill="var(--text2)">{md(p.planned)}</text>
          <text x={0} y={Y(p.predicted!) + 4} fontSize="11" fill={INK[v.tone]} fontWeight="600">{md(p.predicted)}</text>
          {p.history.map((x, i) => i % 2 === 1 && <text key={i} x={X(i)} y={h + 12} fontSize="11" fill="var(--text2)" textAnchor={i === p.history.length - 1 ? 'end' : 'middle'}>{md(x.week)}</text>)}
        </>
      )}
    </svg>
  );
}

/** The goal card's line on the Goal map (PC1 a, PC2 a|b|c, PC3 a|b|c). */
export function GoalPredicted({ goal, onOpen, canEdit = true }: { goal: string; onOpen: Open; canEdit?: boolean }) {
  const pc1 = mkParam('pc1');
  const pc2 = mkParam('pc2');
  const pc3 = mkParam('pc3');
  const [open, setOpen] = useState(mkParam('open') === '1');
  const p = predictedFor(goal, mkBig());
  if (!p || pc1 === 'b' || pc1 === 'c' || (!pc1 && !pc2 && !pc3)) return null;
  const v = verdictRange(p.planned, p.predicted, range(p));
  const [lo, hi] = pc2 === 'b' ? span(p, p.milestones, [shift(p.predicted, -range(p)), shift(p.predicted, range(p))].filter(Boolean) as string[]) : span(p);
  const go: Open = (n) => (setOpen(false), onOpen(n));
  // PC2 c: a status tick only, everything else in its tooltip.
  if (pc2 === 'c')
    return (
      <span className="relative flex items-center gap-1.5 text-xs" data-testid="pm-goal" data-pm-keep>
        <button type="button" onClick={() => setOpen(!open)} className={`inline-flex size-5 items-center justify-center rounded-full font-bold ${TONE[v.tone]}`} title={`${v.word}: due ${md(p.planned)}, predicted ${p.predicted ? md(p.predicted) : 'not yet'}`} aria-label={`Predicted date: ${v.word}`}>
          {MARK[v.tone]}
        </button>
        <span className="text-text2 whitespace-nowrap">Due {md(p.planned)} · <b className={v.tone === 'pass' ? 'text-pass' : v.tone === 'na' ? 'text-na' : 'text-crit'}>{v.word}</b></span>
        {open && (
          <Pop title={v.word} onClose={() => setOpen(false)}>
            <span className="tnum">Due {md(p.planned)} · predicted {p.predicted ? md(p.predicted) : 'not yet'}</span>
            <Driver p={p} name={p.driver} onOpen={go} />
          </Pop>
        )}
      </span>
    );
  return (
    <span className="relative flex flex-col gap-1" data-testid="pm-goal" data-pm-keep>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} data-testid="pm-goal-open" className="flex flex-col gap-1 rounded-md text-left hover:bg-surface2 focus-visible:bg-surface2">
        {pc2 === 'b' && p.predicted ? (
          <Band p={p} lo={lo} hi={hi} />
        ) : (
          <DateLine planned={p.planned} predicted={p.predicted} lo={lo} hi={hi} ticks={pc3 === 'b' ? p.features.filter((f) => f.end).map((f) => ({ at: f.end!, strong: f.name === p.driver })) : undefined} />
        )}
        <span className="tnum flex flex-wrap items-center justify-between gap-x-1 gap-y-0.5 text-xs text-text2">
          <span className="flex flex-wrap gap-x-1"><span className="whitespace-nowrap">Due {md(p.planned)}{p.predicted ? ' ·' : ''}</span>{p.predicted && <span className="whitespace-nowrap">predicted {pc2 === 'b' ? `${md(shift(p.predicted, -range(p)))} – ${md(shift(p.predicted, range(p)))}` : md(p.predicted)}</span>}</span>
          <Chip v={v} testId="pm-chip" />
        </span>
      </button>
      {open && (
        <Pop title={`${goal}: dates`} onClose={() => setOpen(false)}>
          <span className="flex items-center justify-between gap-2">
            <Legend />
            <Why p={p} label={goal} />
          </span>
          <span className="flex flex-col gap-0.5 border-b border-line pb-2">
            <span className="flex items-baseline gap-1.5"><b>Goal</b><span className="flex-1" /><Chip v={v} /></span>
            {pc2 === 'b' && p.predicted ? <Band p={p} lo={lo} hi={hi} /> : <DateLine planned={p.planned} predicted={p.predicted} lo={lo} hi={hi} />}
            <MkAsk />
            <span className="text-xs"><Driver p={p} name={p.driver} onOpen={go} /></span>
          </span>
          {pc3 === 'c' ? <Ranked p={p} onOpen={go} /> : <MilestoneLines p={p} onOpen={go} lo={lo} hi={hi} ticks={pc3 === 'b'} />}
          {p.dated < p.total && (
            <span className="text-xs text-na" data-testid="pm-undated">{p.total - p.dated} of {p.total} {p.total - p.dated === 1 ? 'feature has' : 'features have'} no end date</span>
          )}
        </Pop>
      )}
    </span>
  );
}
const range = (p: PmGoal) => Math.max(2, Math.round(p.slipRate * (1 + (p.total - p.dated) / p.total)));
function shift(iso: string | null, d: number) {
  if (!iso) return '';
  return new Date(t(iso) + d * 86_400_000).toISOString().slice(0, 10);
}
/** PC2 b: the predicted date as a range, wider when fewer features have dates or past ones slipped more. */
function Band({ p, lo, hi }: { p: PmGoal; lo: number; hi: number }) {
  const x = (iso: string) => ((t(iso) - lo) / (hi - lo)) * 100;
  const v = verdict(p.planned, p.predicted);
  const a = shift(p.predicted, -range(p));
  const b = shift(p.predicted, range(p));
  return (
    <span className="relative block h-[14px] w-full" role="img" aria-label={`Due ${md(p.planned)}, predicted ${md(a)} to ${md(b)}`} data-testid="pm-band">
      <span className="absolute inset-x-0 top-1/2 h-px bg-line" />
      <span className="absolute top-0.5 bottom-0.5 rounded-sm" style={{ left: `${x(a)}%`, width: `${x(b) - x(a)}%`, background: INK[v.tone], opacity: 0.3, backgroundImage: 'repeating-linear-gradient(45deg, transparent 0 3px, var(--surface) 3px 4px)' }} />
      <span className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ left: `${x(p.predicted!)}%`, background: INK[v.tone] }} />
      <span className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 border-2 border-text2 bg-surface" style={{ left: `${x(p.planned)}%` }} />
    </span>
  );
}

/** PC1 c: a slip bar on a milestone chip of the Goal map's strip. */
export function MilestoneSlip({ goal, code, onOpen }: { goal: string; code: string; onOpen: Open }) {
  const [open, setOpen] = useState(mkParam('open') === code);
  if (mkParam('pc1') !== 'c') return null;
  const p = predictedFor(goal, mkBig());
  const m = p?.milestones.find((x) => x.code === code);
  if (!p || !m) return null;
  const v = verdict(m.planned, m.predicted);
  const w = Math.min(48, Math.abs(v.d) * 3);
  return (
    <span className="relative inline-flex basis-full pl-6" data-pm-keep>
      <button type="button" data-testid="pm-slip" onClick={() => setOpen(!open)} aria-label={`${m.code}: ${v.word}`} className={`inline-flex items-center gap-1 rounded-md px-1 text-xs font-semibold ${TONE[v.tone]}`}>
        {v.d > 0 && <span className="inline-block h-1.5 rounded-full" style={{ width: w, background: INK[v.tone] }} />}
        <span aria-hidden>{MARK[v.tone]}</span>
        <span className="tnum whitespace-nowrap">{v.word}</span>
      </button>
      {open && (
        <Pop title={`${m.code} ${m.name}`} onClose={() => setOpen(false)}>
          <Legend />
          <DateLine planned={m.planned} predicted={m.predicted} lo={span(p, [m])[0]} hi={span(p, [m])[1]} h={18} />
          <span className="tnum flex justify-between text-xs text-text2"><span>Due {md(m.planned)}</span><span>{m.predicted ? `Predicted ${md(m.predicted)}` : 'No date yet'}</span></span>
          <Chip v={v} />
          <span className="text-xs"><Driver p={p} name={m.driver} onOpen={(n) => (setOpen(false), onOpen(n))} /></span>
        </Pop>
      )}
    </span>
  );
}

/** PC1 b: the Roadmap goal card's drift line, week by week. */
export function RoadmapDrift({ goal, onOpen }: { goal: string; onOpen: Open }) {
  const [open, setOpen] = useState(mkParam('open') === '1');
  if (mkParam('pc1') !== 'b') return null;
  const p = predictedFor(goal, mkBig());
  if (!p) return null;
  const v = verdict(p.planned, p.predicted);
  return (
    <span className="relative mt-1 flex flex-col" data-testid="pm-goal" data-pm-keep>
      <button type="button" data-testid="pm-goal-open" onClick={() => setOpen(!open)} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md text-left hover:bg-surface2">
        <span className="h-7"><Drift p={p} w={160} h={28} /></span>
        <Chip v={v} testId="pm-chip" />
      </button>
      {open && (
        <Pop title={`${goal}: predicted date by week`} onClose={() => setOpen(false)}>
          <span className="flex items-center gap-3 text-xs text-text2">
            <span className="flex items-center gap-1"><span className="h-0 w-4 border-t-2 border-dashed border-text2" />Due</span>
            <span className="flex items-center gap-1"><span className="h-0.5 w-4" style={{ background: INK[v.tone] }} />Predicted</span>
            <span className="flex-1" />
            <Chip v={v} />
          </span>
          <Drift p={p} w={350} h={110} labels />
          <span className="text-xs"><Driver p={p} name={p.driver} onOpen={(n) => (setOpen(false), onOpen(n))} /></span>
        </Pop>
      )}
    </span>
  );
}

/** A commenter's line in the dates panel (&as=commenter): the dates come from features, whose change is a suggestion. */
function MkAsk() {
  if (mkParam('as') !== 'commenter') return null;
  return <span className="text-xs text-text2" data-testid="pm-ask">You can suggest dates; Avery Stone decides</span>;
}

/** PC1 b: the Roadmap's own milestone card shows the milestone's due and predicted dates. */
export function MsPredicted({ code }: { code: string }) {
  if (mkParam('pc1') !== 'b') return null;
  for (const g of ['Sign-ups per rep per day', 'Paid conversions per rep per day', 'Revenue per day']) {
    const p = predictedFor(g, mkBig());
    const m = p?.milestones.find((x) => x.code === code);
    if (!p || !m) continue;
    const v = verdict(m.planned, m.predicted);
    const [lo, hi] = span(p, [m]);
    return (
      <span className="flex flex-col gap-1 rounded-lg border border-line p-2 text-sm" data-testid="pm-ms-card">
        <span className="flex items-center justify-between gap-2"><Legend /><Chip v={v} /></span>
        <DateLine planned={m.planned} predicted={m.predicted} lo={lo} hi={hi} h={18} />
        <span className="tnum flex justify-between text-xs text-text2"><span>Due {md(m.planned)}</span><span>{m.predicted ? `Predicted ${md(m.predicted)}` : 'No date yet'}</span></span>
        {m.driver && <span className="text-xs"><span className="text-text2">Set by </span><b>{codeOf(p, m.driver)}</b> {m.driver}</span>}
      </span>
    );
  }
  return null;
}

/** A frame's cost, shown in the corner when the URL asks for it. */
export function MkCost() {
  const c = mkParam('mkcost');
  if (!c) return null;
  return (
    <div data-testid="mk-cost" className="pointer-events-none fixed bottom-3 left-1/2 -translate-x-1/2 z-50 max-[600px]:top-14 max-[600px]:bottom-auto max-w-[210px] rounded-lg border-2 border-accent bg-surface px-3 py-2 text-sm shadow-lg">
      <b className="text-accent-ink">Cost</b> · {c}
    </div>
  );
}
