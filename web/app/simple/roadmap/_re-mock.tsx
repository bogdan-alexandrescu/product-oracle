'use client';

// MOCK-HOOK: mk-roadmap-edit mock-ups only (this branch is never merged). The whole file is a
// mock-up: ?re1=a|b|c|d (adding in place), ?re2=a|b|c|d (changing in place), ?re3=a|b|c|d (how
// the roadmap marks edits), with &st=rest|open|mid|result|ms|hard and &viewer=1. Data is the
// invented company in lib/api/mock/re-mock.ts.

import { Fragment, useEffect, useState, type CSSProperties, type ReactNode } from 'react';

import { useSearchParams } from '@/lib/nav';
import {
  RE_FROM,
  RE_ITEMS,
  RE_MILESTONES,
  RE_PEOPLE,
  RE_TO,
  RE_TODAY,
  RE_TRACKS,
  RE_GOALS,
  reBigItems,
  type ReItem,
  type ReMilestone,
} from '@/lib/api/mock/re-mock';

const DAY = 86400000;
const t0 = Date.parse(RE_FROM);
const span = Date.parse(RE_TO) - t0;
const pct = (d: string) => ((Date.parse(d) - t0) / span) * 100;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmt = (d: string) => {
  const x = new Date(d + 'T00:00:00Z');
  return `${MON[x.getUTCMonth()]} ${x.getUTCDate()}`;
};
const range = (s: string, e: string) => `${fmt(s)} – ${fmt(e)}`;
const initials = (n: string) =>
  n
    .split(' ')
    .map((w) => w[0])
    .join('');

type Dec = 're1' | 're2' | 're3';
type Ctx = { dec: Dec; v: string; st: string; viewer: boolean };

function useNarrow() {
  const [n, setN] = useState(() => typeof window !== 'undefined' && window.innerWidth < 640);
  useEffect(() => {
    const on = () => setN(window.innerWidth < 640);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return n;
}

const card: CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--line)',
  borderRadius: 14,
};
const pop: CSSProperties = {
  ...card,
  position: 'absolute',
  zIndex: 30,
  boxShadow: 'var(--tip-shadow)',
  padding: 10,
};
const btn: CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 10,
  padding: '4px 12px',
  background: 'var(--surface)',
  color: 'var(--text)',
  whiteSpace: 'nowrap',
};
const btnOn: CSSProperties = { ...btn, background: 'var(--accent)', color: 'var(--on-accent)', borderColor: 'var(--accent)' };

function Tip({ text }: { text: string }) {
  return (
    <span
      title={text}
      aria-label={text}
      className="text-xs"
      style={{
        display: 'inline-grid',
        placeItems: 'center',
        width: 18,
        height: 18,
        borderRadius: 9,
        border: '1px solid var(--line-strong)',
        color: 'var(--text2)',
        fontStyle: 'italic',
        marginLeft: 6,
      }}
    >
      i
    </span>
  );
}

function Avatar({ name, size = 22 }: { name: string | null; size?: number }) {
  return (
    <span
      title={name ?? 'No owner yet'}
      className="text-xs"
      style={{
        minWidth: size,
        height: size,
        padding: name ? '0 5px' : 0,
        borderRadius: size,
        flex: 'none',
        lineHeight: 1,
        letterSpacing: 0.2,
        display: 'inline-grid',
        placeItems: 'center',
        background: name ? 'var(--accent)' : 'transparent',
        color: name ? 'var(--on-accent)' : 'var(--text-faint)',
        border: name ? 'none' : '1.5px dashed var(--line-strong)',
        fontWeight: 600,
      }}
    >
      {name ? initials(name) : '+'}
    </span>
  );
}

function Toast({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="text-base"
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 24,
        transform: 'translateX(-50%)',
        background: 'var(--tip)',
        color: 'var(--tip-text)',
        borderRadius: 12,
        padding: '10px 16px',
        display: 'flex',
        gap: 16,
        alignItems: 'center',
        boxShadow: 'var(--tip-shadow)',
        zIndex: 50,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
      <button type="button" style={{ fontWeight: 700, textDecoration: 'underline' }}>
        Undo
      </button>
    </div>
  );
}

function Grip({ side }: { side: 'l' | 'r' }) {
  return (
    <span
      aria-hidden
      style={{
        position: 'absolute',
        top: 4,
        bottom: 4,
        [side === 'l' ? 'left' : 'right']: -4,
        width: 8,
        borderRadius: 4,
        background: 'var(--accent)',
        cursor: 'ew-resize',
      }}
    />
  );
}

// ——— what each decision and state adds to the roadmap ———

/** The bar's own look: dated solid, estimated hatched, draft dashed (as built), plus RE3's marks. */
function barStyle(it: ReItem, c: Ctx, lensDim: boolean): CSSProperties {
  const s: CSSProperties = {
    position: 'absolute',
    top: 5,
    bottom: 5,
    borderRadius: 8,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '0 8px',
    overflow: 'visible',
    whiteSpace: 'nowrap',
    color: 'var(--accent-ink)',
    border: '1.5px solid var(--accent)',
    background: 'var(--accent-soft)',
    opacity: lensDim ? 0.22 : 1,
  };
  if (it.kind === 'est')
    s.background =
      'repeating-linear-gradient(135deg, var(--accent-soft) 0 6px, var(--surface) 6px 9px)';
  if (it.kind === 'draft') {
    s.border = '1.5px dashed var(--line-strong)';
    s.background = 'var(--surface)';
    s.color = 'var(--text2)';
  }
  if (c.dec === 're3' && c.v === 'd') {
    if (it.was) Object.assign(s, { background: 'var(--accent)', color: 'var(--on-accent)' });
    if (it.decision) Object.assign(s, { background: 'var(--warn-bg)', border: '1.5px solid var(--warn)', color: 'var(--text)' });
  }
  return s;
}

function isEditing(c: Ctx) {
  if (c.viewer) return false;
  if (c.dec === 're2' && c.v === 'b') return c.st !== 'rest';
  return true;
}

function Bar({
  it,
  c,
  selected,
  lensDim,
  children,
}: {
  it: ReItem;
  c: Ctx;
  selected?: boolean;
  lensDim?: boolean;
  children?: ReactNode;
}) {
  const left = pct(it.start);
  const width = pct(it.end) - left;
  const ed = isEditing(c);
  const showGrips = ed && (selected || (c.dec === 're2' && c.v === 'b' && c.st !== 'rest'));
  const s = barStyle(it, c, !!lensDim);
  const re3 = c.dec === 're3' ? c.v : '';
  return (
    <>
      {re3 === 'a' && it.was && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            top: 3,
            bottom: 3,
            left: `${pct(it.was[0])}%`,
            width: `${pct(it.was[1]) - pct(it.was[0])}%`,
            background: 'color-mix(in srgb, var(--today) 16%, transparent)',
            borderRadius: 8,
            opacity: lensDim ? 0.2 : 1,
          }}
        />
      )}
      <div
        data-testid="re-bar"
        data-item={it.id}
        title={`${it.code} ${it.name} · ${range(it.start, it.end)}`}
        className="text-sm"
        style={{
          ...s,
          left: `${left}%`,
          width: `${width}%`,
          outline: selected ? '2px solid var(--accent)' : undefined,
          outlineOffset: 2,
          cursor: ed ? 'grab' : 'pointer',
        }}
      >
        {showGrips && <Grip side="l" />}
        {((c.dec === 're2' && c.v === 'a') || c.dec === 're3') && <Avatar name={it.owner} size={18} />}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
          <b style={{ fontWeight: 600 }}>{it.code}</b> {it.name}
        </span>
        {re3 === 'a' && it.was && <Dot color="var(--today)" />}
        {(re3 === 'a' || re3 === 'b') && it.decision && <Flag />}
        {it.isNew && (
          <span className="text-xs" style={{ position: 'absolute', left: '100%', marginLeft: 8, background: 'var(--pass-bg)', color: 'var(--text)', borderRadius: 6, padding: '0 6px' }}>
            New
          </span>
        )}
        {showGrips && <Grip side="r" />}
        {children}
      </div>
    </>
  );
}

function Dot({ color }: { color: string }) {
  return <span aria-label="Changed since approved" style={{ width: 8, height: 8, borderRadius: 4, background: color, flex: 'none' }} />;
}
function Flag() {
  return (
    <span
      aria-label="Needs a decision"
      className="text-xs"
      style={{
        flex: 'none',
        width: 18,
        height: 18,
        borderRadius: 9,
        background: 'var(--warn)',
        color: '#2a1d00',
        display: 'inline-grid',
        placeItems: 'center',
        fontWeight: 800,
      }}
    >
      !
    </span>
  );
}

function DateTip({ text, left, top = -30, side }: { text: string; left: string; top?: number; side?: boolean }) {
  return (
    <span
      className="text-sm"
      style={{
        position: 'absolute',
        left,
        top,
        transform: side ? undefined : 'translateX(-50%)',
        background: 'var(--tip)',
        color: 'var(--tip-text)',
        borderRadius: 8,
        padding: '2px 8px',
        whiteSpace: 'nowrap',
        zIndex: 40,
      }}
    >
      {side && <span aria-hidden style={{ position: 'absolute', left: -6, top: '50%', marginTop: -6, borderTop: '6px solid transparent', borderBottom: '6px solid transparent', borderRight: '6px solid var(--tip)' }} />}
      {text}
    </span>
  );
}

function PeopleList({ pick }: { pick?: string }) {
  return (
    <div className="text-base" style={{ display: 'grid', gap: 2, minWidth: 200 }}>
      {RE_PEOPLE.map((p) => (
        <div
          key={p}
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            padding: '4px 8px',
            borderRadius: 8,
            background: p === pick ? 'var(--accent-soft)' : undefined,
          }}
        >
          <Avatar name={p} size={22} /> {p}
        </div>
      ))}
    </div>
  );
}

function TitleInput({ value, w = 220 }: { value: string; w?: number }) {
  return (
    <span
      className="text-sm"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        minWidth: w,
        height: 26,
        padding: '0 8px',
        borderRadius: 6,
        background: 'var(--surface)',
        border: '1.5px solid var(--accent)',
        color: 'var(--text)',
      }}
    >
      {value}
      <span style={{ width: 1.5, height: 16, background: 'var(--text)', marginLeft: 1 }} />
    </span>
  );
}

// ——— the desktop board (Timeline grouped by track, Gantt grouped by goal) ———

const ROW = 38;

function Ruler({ c, milestones }: { c: Ctx; milestones: ReMilestone[] }) {
  const months: string[] = [];
  for (let m = 9; m < 9 + 9; m++) {
    const y = 2026 + Math.floor(m / 12);
    months.push(`${y}-${String((m % 12) + 1).padStart(2, '0')}-01`);
  }
  const msAdd =
    c.dec === 're1' &&
    c.st === 'ms' && !c.viewer;
  return (
    <>
      <div style={{ position: 'relative', height: 30, borderBottom: '1px solid var(--line)' }}>
        {months.map((m) => (
          <span key={m} className="text-sm" style={{ position: 'absolute', left: `${pct(m)}%`, top: 6, paddingLeft: 6, color: 'var(--text2)', borderLeft: '1px solid var(--line)' }}>
            {fmt(m).split(' ')[0]}
            {m.endsWith('01-01') || m === RE_FROM ? ` ${m.slice(0, 4)}` : ''}
          </span>
        ))}
        <span className="text-xs" style={{ position: 'absolute', left: `${pct(RE_TODAY)}%`, top: 4, transform: 'translateX(-50%)', background: 'var(--today)', color: '#fff', borderRadius: 6, padding: '1px 6px' }}>
          Today
        </span>
      </div>
      <div
        data-testid="re-milestones"
        style={{
          position: 'relative',
          height: 40,
          borderBottom: '1px solid var(--line)',
          background: msAdd ? 'var(--accent-soft)' : undefined,
        }}
      >
        {milestones.map((m) => (
          <span key={m.id} className="text-sm" style={{ position: 'absolute', left: `${pct(m.date)}%`, top: 8, display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap', color: 'var(--text)' }}>
            <span style={{ width: 10, height: 10, background: 'var(--accent)', transform: 'rotate(45deg)', marginLeft: -5 }} />
            {m.name}
            <span className="text-xs" style={{ color: 'var(--text2)' }}>{fmt(m.date)}</span>
            {m.isNew && (
              <span className="text-xs" style={{ background: 'var(--pass-bg)', borderRadius: 6, padding: '0 6px' }}>
                New
              </span>
            )}
          </span>
        ))}
        {msAdd && <MilestoneAdd c={c} />}
      </div>
    </>
  );
}

/** The milestone add control each RE1 proposal opens (the "ms" frame). */
function MilestoneAdd({ c }: { c: Ctx }) {
  const at = '2027-03-08';
  if (c.v === 'd') return null;
  return (
    <span data-scroll-here style={{ position: 'absolute', left: `${pct(at)}%`, top: 14, zIndex: 20 }}>
      <span style={{ display: 'block', width: 12, height: 12, background: 'var(--accent)', transform: 'rotate(45deg)', marginLeft: -6, outline: '2px solid var(--surface)' }} />
      <span style={{ ...pop, left: -20, top: 22, display: 'flex', gap: 8, alignItems: 'center', padding: 8 }}>
        <TitleInput value="Pilot with 500 homes" w={190} />
        <span className="text-sm" style={btn}>
          {fmt(at)}
        </span>
        {c.v === 'c' && <span className="text-sm" style={btnOn}>Add</span>}
      </span>
    </span>
  );
}

function rowsOf(items: ReItem[], by: 'track' | 'goal') {
  const keys = by === 'track' ? RE_TRACKS : RE_GOALS;
  return keys.map((k) => ({ key: k, items: items.filter((i) => i[by] === k) }));
}

function Board({ c, items, by }: { c: Ctx; items: ReItem[]; by: 'track' | 'goal' }) {
  const groups = rowsOf(items, by);
  const re3 = c.dec === 're3' ? c.v : '';
  const lens = re3 === 'b' && (c.st === 'open' || c.st === 'result') ? 'changes' : '';
  const sel = selectedId(c);
  const editTint = c.dec === 're2' && c.v === 'b' && c.st !== 'rest' && !c.viewer;
  return (
    <div style={{ ...card, overflow: 'clip', background: editTint ? 'var(--accent-soft)' : 'var(--surface)', border: editTint ? '2px solid var(--accent)' : card.border }}>
      <div style={{ display: 'grid', gridTemplateColumns: `${re3 === 'c' ? '28px ' : ''}260px 1fr` }}>
        {re3 === 'c' && <div style={{ borderBottom: '1px solid var(--line)' }} />}
        <div className="text-sm" style={{ borderBottom: '1px solid var(--line)', borderRight: '1px solid var(--line)', padding: '6px 12px', color: 'var(--text2)', ...stick(c) }} />
        <div style={{ position: 'relative', ...stick(c) }}>
          <TodayLine />
          <Ruler c={c} milestones={milestonesFor(c)} />
        </div>
        {groups.map((g) => (
          <Group key={g.key} g={g} c={c} sel={sel} lens={lens} />
        ))}
      </div>
    </div>
  );
}

/** The 60-item frames keep the month axis in view while the page scrolls. */
function stick(c: Ctx): CSSProperties {
  return c.st === 'hard' ? { position: 'sticky', top: 0, zIndex: 22, background: 'var(--surface)' } : {};
}

function TodayLine() {
  return <div aria-hidden style={{ position: 'absolute', left: `${pct(RE_TODAY)}%`, top: 0, bottom: -4000, width: 1.5, background: 'var(--today)', opacity: 0.6, zIndex: 1 }} />;
}

function milestonesFor(c: Ctx): ReMilestone[] {
  if (c.dec === 're1' && c.st === 'result' && c.v === 'd')
    return [...RE_MILESTONES];
  return RE_MILESTONES;
}

function selectedId(c: Ctx) {
  if (c.dec !== 're2' || c.viewer) return '';
  if (c.st === 'open' || c.st === 'mid') return 'a2';
  return '';
}

function Group({ g, c, sel, lens }: { g: { key: string; items: ReItem[] }; c: Ctx; sel: string; lens: string }) {
  const re3 = c.dec === 're3' ? c.v : '';
  const first = g.key === RE_TRACKS[0] || g.key === RE_GOALS[2];
  const addRow = c.dec === 're1' && !c.viewer && c.v === 'a';
  const items = [...g.items];
  // RE1's new item, once added (the result frame), or RE2's moved item.
  if (c.dec === 're1' && c.st === 'result' && first)
    items.push({ id: 'n1', code: 'F-31', name: 'Paper bill reminders', track: g.key, goal: g.key, start: '2026-12-07', end: c.v === 'c' ? '2027-02-05' : '2027-01-29', kind: 'est', owner: null, horizon: 'next', isNew: true });
  const moved = c.dec === 're2' && c.st === 'result' && c.v !== 'd';
  const shown = items
    .filter((i) => !(moved && i.id === 'a2'))
    .map((i) => (c.dec === 're2' && c.st === 'result' && c.v === 'd' && i.id === 'a2' ? { ...i, owner: 'Ines Okafor' } : i))
    .concat(moved && g.key === 'Mobile app track' ? [c.v === 'c' ? { ...RE_ITEMS[1], track: g.key } : { ...RE_ITEMS[1], track: g.key, start: '2026-12-07', end: '2027-01-29' }] : []);
  return (
    <>
      {re3 === 'c' && <div style={{ borderBottom: '1px solid var(--line)', background: 'var(--surface2)' }} />}
      <div
        data-scroll-here={c.dec === 're1' && c.v === 'a' && c.st === 'hard' && g.key === RE_GOALS[2] ? 'start' : undefined}
        className="text-base"
        style={{ gridColumn: 'span 2', background: 'var(--surface2)', borderBottom: '1px solid var(--line)', padding: '6px 12px', fontWeight: 600, display: 'flex', gap: 10, alignItems: 'center', scrollMarginTop: 80 }}
      >
        {g.key}
        <span className="text-sm" style={{ color: 'var(--text2)', fontWeight: 400 }}>
          {shown.length + (c.dec === 're1' && c.v === 'c' && first && c.st === 'mid' ? 1 : 0)} items
        </span>
      </div>
      {shown.map((it, i) => (
        <Fragment key={it.id}>
          {c.dec === 're1' && c.v === 'c' && c.st === 'hard' && g.key === RE_GOALS[2] && i === 12 && <HoverPlus />}
          <Row
            it={it}
            c={c}
            sel={sel === it.id}
            lens={lens}
            target={((c.dec === 're2' && c.st === 'mid' && (c.v === 'a' || c.v === 'b')) || (c.dec === 're2' && c.st === 'hard' && c.v === 'a')) && !c.viewer && it.id === 'b1'}
            pressed={c.dec === 're1' && c.v === 'b' && c.st === 'hard' && g.key === RE_GOALS[2] && i === shown.length - 1}
          />
        </Fragment>
      ))}
      {addRow && <AddRow c={c} open={first && (c.st === 'open' || c.st === 'mid')} hard={c.st === 'hard' && g.key === RE_GOALS[2]} />}
      {c.dec === 're1' && c.v === 'b' && first && (c.st === 'open' || c.st === 'mid') && <DrawRow c={c} />}
      {c.dec === 're1' && c.v === 'c' && first && (c.st === 'open') && <PlusGap />}
      {c.dec === 're1' && c.v === 'c' && first && c.st === 'mid' && <GuessFix />}
    </>
  );
}

function Label({ it, c }: { it: ReItem; c: Ctx }) {
  const rename = c.dec === 're2' && c.st === 'open' && it.id === 'a2' && (c.v === 'a' || c.v === 'b');
  const inputLook = c.dec === 're2' && c.v === 'b' && c.st !== 'rest' && !c.viewer;
  return (
    <div className="text-base" style={{ padding: '0 12px', display: 'flex', alignItems: 'center', gap: 6, borderRight: '1px solid var(--line)', borderBottom: '1px solid var(--line)', height: ROW, minWidth: 0 }}>
      {rename ? (
        <TitleInput value={it.name} w={200} />
      ) : (
        <span title={`${it.code} ${it.name}`} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', borderBottom: inputLook ? '1.5px solid var(--line-strong)' : undefined }}>
          {it.name}
        </span>
      )}
    </div>
  );
}

function Row({ it, c, sel, lens, target, pressed }: { it: ReItem; c: Ctx; sel: boolean; lens: string; target?: boolean; pressed?: boolean }) {
  const re3 = c.dec === 're3' ? c.v : '';
  const dim = lens === 'changes' && !it.was;
  const rowTint = re3 === 'd' && !c.viewer ? 'color-mix(in srgb, var(--accent-soft) 35%, transparent)' : undefined;
  const midDrag = c.dec === 're2' && ((c.st === 'mid' && (c.v === 'a' || c.v === 'b')) || (c.st === 'hard' && c.v === 'a')) && it.id === 'a2';
  return (
    <>
      {re3 === 'c' && (
        <div className="text-sm" style={{ borderBottom: '1px solid var(--line)', display: 'grid', placeItems: 'center', gap: 0, color: 'var(--text2)' }}>
          <span style={{ display: 'flex', gap: 2 }}>
            {it.was && <span title="Changed since approved" style={{ color: 'var(--today)' }}>●</span>}
            {it.decision && <span title="Needs a decision" style={{ color: 'var(--warn)' }}>◆</span>}
            {!it.was && !it.decision && it.kind === 'draft' && <span title="Draft">◌</span>}
          </span>
        </div>
      )}
      <Label it={it} c={c} />
      <div style={{ position: 'relative', height: ROW, borderBottom: '1px solid var(--line)', background: target ? 'var(--accent-soft)' : rowTint, zIndex: sel ? 5 : undefined }}>
        {midDrag ? (
          <>
            <div aria-hidden style={{ position: 'absolute', top: 5, bottom: 5, left: `${pct(it.start)}%`, width: `${pct(it.end) - pct(it.start)}%`, border: '1.5px dashed var(--line-strong)', borderRadius: 8 }} />
          </>
        ) : (
          <>
          {target && (
            <div data-scroll-here={c.st === 'hard' ? '' : undefined} style={{ position: 'absolute', inset: 0, zIndex: 25, pointerEvents: 'none', transform: 'translateY(-14px)', filter: 'drop-shadow(0 6px 10px rgba(0,0,0,.25))' }}>
              <Bar it={{ ...RE_ITEMS[1], start: '2026-12-07', end: '2027-01-29' }} c={c} selected>
                <DateTip text="Dec 7 – Jan 29 · Mobile app track" left="50%" top={-30} />
              </Bar>
            </div>
          )}
          <Bar it={it} c={c} selected={sel || pressed} lensDim={dim}>
            {sel && <SelectExtras c={c} />}
            {pressed && (
              <span data-scroll-here="" style={{ position: 'absolute', right: 10, top: 8 }}>
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d="M8 1v14M1 8h14" stroke="var(--text)" strokeWidth="1.6" /></svg>
              </span>
            )}
            {pressed && <DateTip text={`Moving ${it.code} ${it.name}`} left="calc(100% + 12px)" top={2} side />}
            {c.dec === 're3' && c.st === 'mid' && it.id === 'a2' && (re3 === 'a' || re3 === 'c' || re3 === 'b' || re3 === 'd') && (
              <DateTip text={`Moved · was ${range(it.was![0], it.was![1])}, now ${range(it.start, it.end)}`} left="calc(100% + 12px)" top={2} side />
            )}
          </Bar>
          {c.dec === 're2' && c.st === 'hard' && c.v === 'c' && it.id === 'x2' && <ReadCard it={it} />}
          {c.dec === 're2' && c.st === 'hard' && c.v === 'd' && it.id === 'x2' && <span data-scroll-here="" />}
          </>
        )}
      </div>
    </>
  );
}

/** RE2 C for a viewer: a click on a bar opens only this read view, no toolbar. */
function ReadCard({ it }: { it: ReItem }) {
  return (
    <div data-scroll-here="" className="text-base" style={{ ...pop, left: `${pct(it.start)}%`, top: ROW - 2, width: 380, display: 'grid', gap: 6, padding: 12 }}>
      <b style={{ fontWeight: 600, whiteSpace: 'normal' }}>
        {it.code} {it.name}
      </b>
      <span className="text-sm" style={{ color: 'var(--text2)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {/* MOCK-HOOK: each part its own item, so the dots sit evenly between them */}
        <span>{range(it.start, it.end)}</span>
        <span aria-hidden>·</span>
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <Avatar name={it.owner} size={18} /> {it.owner ?? 'No owner yet'}
        </span>
        <span aria-hidden>·</span>
        <span>{it.track}</span>
      </span>
    </div>
  );
}

/** RE2's selected bar: what each proposal opens on it. */
function SelectExtras({ c }: { c: Ctx }) {
  if (c.v === 'a' && c.st === 'open')
    return (
      <div style={{ ...pop, left: 4, top: 30 }}>
        <PeopleList pick="Tobias Fenn" />
      </div>
    );
  if (c.v === 'c')
    return (
      <div style={{ ...pop, left: 0, top: -54, display: 'flex', gap: 8, alignItems: 'center', padding: 8 }}>
        <TitleInput value="Spike alerts by text" w={170} />
        <span className="text-sm" style={btn}>Nov 16 – Jan 8 ▾</span>
        <span className="text-sm" style={{ ...btn, display: 'flex', gap: 6, alignItems: 'center' }}>
          <Avatar name="Tobias Fenn" size={18} /> ▾
        </span>
        <span className="text-sm" style={c.st === 'mid' ? btnOn : btn}>Billing track ▾</span>
        {c.st === 'mid' && <div style={{ ...pop, left: 380, top: 44 }}>
          <div className="text-base" style={{ display: 'grid', gap: 2, minWidth: 210 }}>
            {RE_TRACKS.map((t) => (
              <span key={t} style={{ padding: '4px 8px', borderRadius: 8, background: t === 'Mobile app track' ? 'var(--accent-soft)' : undefined }}>
                {t}
              </span>
            ))}
          </div>
        </div>}
      </div>
    );
  return null;
}

/** RE1 A: the empty row at the end of each track or goal; click a spot in it to add there. */
function AddRow({ c, open, hard }: { c: Ctx; open: boolean; hard: boolean }) {
  const s = '2026-12-07';
  const e = c.st === 'mid' ? '2027-01-29' : '2027-01-15';
  const isOpen = open || hard;
  return (
    <>
      <div className="text-base" style={{ padding: '0 12px', height: ROW, display: 'flex', alignItems: 'center', gap: 6, color: 'var(--accent)', borderRight: '1px solid var(--line)', borderBottom: '1px solid var(--line)' }}>
        ＋ Add
      </div>
      <div style={{ position: 'relative', height: ROW, borderBottom: '1px solid var(--line)', background: 'repeating-linear-gradient(90deg, transparent 0 calc(100% / 39 - 1px), var(--line) calc(100% / 39 - 1px) calc(100% / 39))', opacity: isOpen ? 1 : 0.9 }}>
        {isOpen && (
          <div style={{ position: 'absolute', top: 5, bottom: 5, left: `${pct(s)}%`, width: `${pct(e) - pct(s)}%`, border: '1.5px solid var(--accent)', borderRadius: 8, background: 'var(--accent-soft)', display: 'flex', alignItems: 'center', padding: '0 4px', zIndex: 10 }}>
            <TitleInput value={hard ? 'Move-in checklist' : 'Paper bill reminders'} w={180} />
            {c.st === 'mid' && <Grip side="r" />}
            {c.st === 'mid' && <DateTip text={range(s, e)} left="100%" top={-30} />}
            {c.st !== 'mid' && <span className="text-sm" style={{ position: 'absolute', left: 4, top: 30, color: 'var(--text2)', whiteSpace: 'nowrap' }}>{range(s, e)}</span>}
          </div>
        )}
      </div>
    </>
  );
}

/** RE1 B: draw on an empty spot of a track's last row. */
function DrawRow({ c }: { c: Ctx }) {
  const s = '2026-12-07';
  const e = c.st === 'mid' ? '2027-01-04' : '2027-01-29';
  return (
    <>
      <div style={{ height: ROW, borderRight: '1px solid var(--line)', borderBottom: '1px solid var(--line)' }} />
      <div style={{ position: 'relative', height: ROW, borderBottom: '1px solid var(--line)', cursor: 'crosshair' }}>
        <div style={{ position: 'absolute', top: 5, bottom: 5, left: `${pct(s)}%`, width: `${pct(e) - pct(s)}%`, border: '1.5px dashed var(--accent)', borderRadius: 8, background: 'color-mix(in srgb, var(--accent-soft) 70%, transparent)', display: 'flex', alignItems: 'center', padding: '0 4px', zIndex: 10 }}>
          {c.st === 'open' && <TitleInput value="Paper bill reminders" w={180} />}
          <DateTip text={range(s, e)} left="100%" top={-30} />
          {c.st === 'mid' && <span style={{ position: 'absolute', right: -8, top: 6, fontSize: 0 }}><svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 1v14M1 8h14" stroke="var(--text)" strokeWidth="1.6" /></svg></span>}
        </div>
      </div>
    </>
  );
}

/** RE1 C: the line and + between two rows, with its small form. */
function PlusGap() {
  return (
    <>
      <div style={{ gridColumn: 'span 2', position: 'relative', height: 0 }}>
        <div style={{ position: 'absolute', left: 0, right: 0, top: -1, height: 2, background: 'var(--accent)', zIndex: 15 }} />
        <span className="text-base" style={{ position: 'absolute', left: 236, top: -13, width: 26, height: 26, borderRadius: 13, background: 'var(--accent)', color: 'var(--on-accent)', display: 'grid', placeItems: 'center', zIndex: 16 }}>
          +
        </span>
        <div style={{ ...pop, left: 270, top: 14, display: 'grid', gap: 8, width: 360 }}>
          <TitleInput value="Paper bill reminders" w={330} />
          <div className="text-sm" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <span style={btn}>Billing track ▾</span>
            <span style={btn}>Jan 11 – Feb 5 ▾</span>
            <span style={{ ...btn, display: 'flex', gap: 6 }}><Avatar name={null} size={18} /> ▾</span>
            <span style={btnOn}>Add</span>
          </div>
        </div>
      </div>
    </>
  );
}

/** RE1 C on the 60-item Gantt: the thin line and + show only under the pointer. */
function HoverPlus() {
  return (
    <div data-scroll-here="" style={{ gridColumn: 'span 2', position: 'relative', height: 0 }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: -1, height: 2, background: 'var(--accent)', zIndex: 15 }} />
      <span className="text-base" style={{ position: 'absolute', left: 236, top: -13, width: 26, height: 26, borderRadius: 13, background: 'var(--accent)', color: 'var(--on-accent)', display: 'grid', placeItems: 'center', zIndex: 16 }}>
        +
      </span>
      <svg width="18" height="22" viewBox="0 0 18 22" aria-hidden style={{ position: 'absolute', left: 252, top: 2, zIndex: 17 }}>
        <path d="M1 1l0 17 4.5-4 3 7 3-1.3-3-6.8 6 0z" fill="var(--text)" stroke="var(--surface)" strokeWidth="1.2" />
      </svg>
    </div>
  );
}

/** RE1 C after Enter: the new bar landed on guessed dates and is dragged to the right ones. */
function GuessFix() {
  return (
    <>
      <div className="text-base" style={{ padding: '0 12px', height: ROW, display: 'flex', alignItems: 'center', borderRight: '1px solid var(--line)', borderBottom: '1px solid var(--line)' }}>
        Paper bill reminders
      </div>
      <div style={{ position: 'relative', height: ROW, borderBottom: '1px solid var(--line)' }}>
        <div aria-hidden style={{ position: 'absolute', top: 5, bottom: 5, left: `${pct('2027-01-11')}%`, width: `${pct('2027-02-05') - pct('2027-01-11')}%`, border: '1.5px dashed var(--line-strong)', borderRadius: 8 }} />
        <div style={{ position: 'absolute', inset: 0, filter: 'drop-shadow(0 6px 10px rgba(0,0,0,.25))' }}>
          <Bar it={{ ...RE_ITEMS[3], id: 'n1', code: 'F-31', name: 'Paper bill reminders', kind: 'est', start: '2026-12-07', end: '2027-02-05' }} c={{ dec: 're2', v: 'a', st: 'mid', viewer: false }} selected>
            <DateTip text="Dec 7 – Feb 5" left="50%" top={-30} />
          </Bar>
        </div>
      </div>
    </>
  );
}

// ——— the top of the page ———

function Header({ c, view, counts }: { c: Ctx; view: string; counts: { changed: number; decide: number; drafts: number } }) {
  const re3 = c.dec === 're3' ? c.v : '';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
      <h1 className="text-3xl" style={{ fontWeight: 700, margin: 0 }}>
        Roadmap
      </h1>
      <span className="text-base" style={{ color: 'var(--text2)' }}>Home energy roadmap</span>
      <div className="text-base" style={{ display: 'flex', border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
        {[
          ['tl', 'Timeline'],
          ['gantt', 'Gantt'],
          ['nnl', 'Now / Next / Later'],
        ].map(([k, l]) => (
          <span key={k} style={{ padding: '4px 12px', background: view === k ? 'var(--accent)' : 'var(--surface)', color: view === k ? 'var(--on-accent)' : 'var(--text)', borderLeft: k === 'tl' ? undefined : '1px solid var(--line)' }}>
            {l}
          </span>
        ))}
      </div>
      {c.dec === 're1' && c.v === 'b' && !c.viewer && <Tip text="Drag across an empty spot of a row to add a feature there. On a phone, press and hold." />}
      <div style={{ flex: 1 }} />
      {c.viewer && (
        <span className="text-sm" style={{ ...btn, color: 'var(--text2)', display: 'flex', alignItems: 'center' }}>
          🔒 View only
          <Tip text="You can read this roadmap. Its owner, Mara Quill, can change it." />
        </span>
      )}
      {c.dec === 're2' && c.v === 'b' && !c.viewer && (
        <span className="text-base" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          Edit
          <span role="switch" aria-checked={c.st !== 'rest'} style={{ width: 40, height: 22, borderRadius: 11, background: c.st !== 'rest' ? 'var(--accent)' : 'var(--line-strong)', position: 'relative' }}>
            <span style={{ position: 'absolute', top: 2, left: c.st !== 'rest' ? 20 : 2, width: 18, height: 18, borderRadius: 9, background: '#fff' }} />
          </span>
        </span>
      )}
      <span style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
      {re3 === 'a' && (
        <span style={{ position: 'relative' }}>
          <span className="text-base" style={c.st === 'open' ? btnOn : btn}>
            Changed since approved · {counts.changed}
          </span>
          {c.st === 'open' && <ChangeList />}
        </span>
      )}
      {re3 === 'b' && (
        <div className="text-base" style={{ display: 'flex', border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
          {[
            ['all', 'All'],
            ['changes', `Changes · ${counts.changed}`],
            ['drafts', `Drafts · ${counts.drafts}`],
            ['decide', `Decisions · ${counts.decide}`],
          ].map(([k, l], i) => {
            const on = (c.st === 'open' || c.st === 'result') ? k === 'changes' : k === 'all';
            return (
              <span key={k} style={{ padding: '4px 12px', background: on ? 'var(--accent)' : 'var(--surface)', color: on ? 'var(--on-accent)' : 'var(--text)', borderLeft: i ? '1px solid var(--line)' : undefined }}>
                {l}
              </span>
            );
          })}
        </div>
      )}
      {re3 !== 'b' && (
        <span className="text-base" style={{ ...btn, borderColor: 'var(--warn)' }}>
          Needs a decision · {counts.decide}
        </span>
      )}
      </span>
      {(re3 === 'c' || re3 === 'd') && (
        <span style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <Tip text="What the marks mean" />
          {c.st === 'open' && <Legend v={re3} />}
        </span>
      )}
    </div>
  );
}

function ChangeList() {
  const rows = RE_ITEMS.filter((i) => i.was);
  return (
    <div style={{ ...pop, right: 0, top: 40, width: 420 }}>
      {rows.map((r) => (
        <div key={r.id} className="text-base" style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 4px', borderBottom: '1px solid var(--line)' }}>
          <Dot color="var(--today)" />
          <span style={{ flex: 1 }}>
            <b style={{ fontWeight: 600 }}>{r.code}</b> {r.name}
            <div className="text-sm" style={{ color: 'var(--text2)' }}>
              {range(r.was![0], r.was![1])} → {range(r.start, r.end)}
            </div>
          </span>
          <span className="text-sm" style={btn}>Put back</span>
        </div>
      ))}
    </div>
  );
}

function Legend({ v }: { v: string }) {
  const rows: [ReactNode, string][] =
    v === 'c'
      ? [
          [<span key="1" style={{ color: 'var(--today)' }}>●</span>, 'Changed since the approved version'],
          [<span key="2" style={{ color: 'var(--warn)' }}>◆</span>, 'Needs a decision'],
          [<span key="3">◌</span>, 'Draft, not yet dated'],
        ]
      : [
          [<Sw key="1" bg="var(--accent)" />, 'Changed since the approved version'],
          [<Sw key="2" bg="var(--warn-bg)" bd="var(--warn)" />, 'Needs a decision'],
          [<Sw key="3" bg="var(--surface)" bd="var(--line-strong)" dash />, 'Draft, not yet dated'],
          [<Sw key="4" bg="var(--accent-soft)" />, 'Rows you can change'],
        ];
  return (
    <div style={{ ...pop, right: 0, top: 30, width: 330 }}>
      {rows.map(([m, t]) => (
        <div key={t} className="text-base" style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '4px 2px' }}>
          {m} {t}
        </div>
      ))}
    </div>
  );
}
function Sw({ bg, bd, dash }: { bg: string; bd?: string; dash?: boolean }) {
  return <span style={{ width: 28, height: 14, borderRadius: 4, background: bg, border: `1.5px ${dash ? 'dashed' : 'solid'} ${bd ?? bg}` }} />;
}

/** RE1 D: the one add bar at the top, with where and when picked in it (no drag). */
function AddBar({ c, phone }: { c: Ctx; phone: boolean }) {
  if (c.dec !== 're1' || c.v !== 'd' || c.viewer) return null;
  const typed = c.st === 'rest' ? '' : 'Paper bill reminders';
  return (
    <div style={{ ...card, borderStyle: 'dashed', padding: 10, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 14, position: 'relative' }}>
      <div className="text-base" style={{ display: 'flex', border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
        <span style={{ padding: '4px 12px', background: c.st === 'ms' ? 'var(--surface)' : 'var(--accent)', color: c.st === 'ms' ? 'var(--text)' : 'var(--on-accent)' }}>Feature</span>
        <span style={{ padding: '4px 12px', borderLeft: '1px solid var(--line)', background: c.st === 'ms' ? 'var(--accent)' : 'var(--surface)', color: c.st === 'ms' ? 'var(--on-accent)' : 'var(--text)' }}>Milestone</span>
      </div>
      <span style={{ flex: 1, minWidth: phone ? '100%' : undefined }}>
        {typed || c.st === 'ms' ? <TitleInput value={c.st === 'ms' ? 'Pilot with 500 homes' : typed} w={260} /> : <span className="text-base" style={{ color: 'var(--text-faint)', border: '1px solid var(--line)', borderRadius: 8, padding: '4px 10px', display: 'block' }}>Title</span>}
      </span>
      {c.st !== 'ms' && <span className="text-base" style={c.st === 'mid' ? btnOn : btn}>{c.st === 'rest' ? 'Track' : 'Billing track'} ▾</span>}
      <span className="text-base" style={c.st === 'open' ? btnOn : btn}>{c.st === 'rest' ? 'Dates' : c.st === 'ms' ? 'Mar 8' : 'Dec 7 – Jan 29'} ▾</span>
      <span className="text-base" style={btnOn}>Add</span>
      {c.st === 'open' && !phone && <MiniCal />}
      {c.st === 'mid' && (
        <div style={{ ...pop, right: 230, top: 50 }}>
          <div className="text-base" style={{ display: 'grid', gap: 2, minWidth: 210 }}>
            {RE_TRACKS.map((t) => (
              <span key={t} style={{ padding: '4px 8px', borderRadius: 8, background: t === 'Billing track' ? 'var(--accent-soft)' : undefined }}>{t}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MiniCal() {
  const cell = (d: number, on: boolean, edge: boolean) => (
    <span key={d} className="text-sm" style={{ width: 30, height: 26, display: 'grid', placeItems: 'center', borderRadius: 6, background: edge ? 'var(--accent)' : on ? 'var(--accent-soft)' : undefined, color: edge ? 'var(--on-accent)' : 'var(--text)' }}>
      {d}
    </span>
  );
  const month = (name: string, days: number, offset: number, lo: number, hi: number) => (
    <div>
      <div className="text-sm" style={{ fontWeight: 600, marginBottom: 4 }}>{name}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 30px)', gap: 2 }}>
        {Array.from({ length: offset }, (_, i) => <span key={`o${i}`} />)}
        {Array.from({ length: days }, (_, i) => cell(i + 1, i + 1 >= lo && i + 1 <= hi, i + 1 === lo || i + 1 === hi))}
      </div>
    </div>
  );
  return (
    <div style={{ ...pop, right: 70, top: 50, display: 'flex', gap: 16 }}>
      {month('Dec 2026', 31, 2, 7, 31)}
      {month('Jan 2027', 31, 5, 1, 29)}
    </div>
  );
}

// ——— Now / Next / Later, and the phone ———

function Nnl({ c, items, phone }: { c: Ctx; items: ReItem[]; phone: boolean }) {
  const hs: ['now' | 'next' | 'later', string][] = [
    ['now', 'Now'],
    ['next', 'Next'],
    ['later', 'Later'],
  ];
  const goals = phone ? (c.dec === 're3' ? [RE_GOALS[1], RE_GOALS[0]] : [RE_GOALS[0]]) : RE_GOALS;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {goals.map((g) => (
        <div key={g} style={{ ...card, padding: 12 }}>
          <div className="text-lg" style={{ fontWeight: 600, marginBottom: 8 }}>{g}</div>
          <div style={{ display: 'grid', gridTemplateColumns: phone ? '1fr' : 'repeat(3, 1fr)', gap: 10 }}>
            {hs.map(([h, name]) => {
              const its = items.filter((i) => i.goal === g && i.horizon === h);
              if (c.dec === 're1' && c.st === 'result' && h === 'next' && g === RE_GOALS[0])
                its.push({ ...RE_ITEMS[3], id: 'n1', code: 'F-31', name: 'Paper bill reminders', kind: 'est', isNew: true });
              return (
                <div key={h} style={{ display: 'grid', gap: 6, alignContent: 'start' }}>
                  <div className="text-sm" style={{ color: 'var(--text2)', fontWeight: 600 }}>{name}</div>
                  {its.map((it) => (
                    <NnlCard key={it.id} it={it} c={c} />
                  ))}
                  {c.dec === 're1' && !c.viewer && <NnlAdd c={c} open={c.v !== 'd' && h === 'next' && (c.st === 'open' || c.st === 'mid')} />}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function NnlCard({ it, c }: { it: ReItem; c: Ctx }) {
  const re3 = c.dec === 're3' ? c.v : '';
  const s = barStyle(it, c, re3 === 'b' && c.st === 'open' && !it.was);
  const sel = c.dec === 're2' && c.st === 'open' && it.id === 'a2';
  return (
    <div data-scroll-here={c.dec === 're3' && it.id === 'a2' ? '' : undefined} className="text-base" style={{ ...s, position: 'relative', top: undefined, bottom: undefined, padding: '8px 10px', display: 'flex', gap: 8, whiteSpace: 'normal', outline: sel ? '2px solid var(--accent)' : undefined }}>
      {re3 === 'c' && (it.was || it.decision) && (
        <span style={{ color: it.decision ? 'var(--warn)' : 'var(--today)' }}>{it.decision ? '◆' : '●'}</span>
      )}
      <span style={{ flex: 1 }}>
        <b style={{ fontWeight: 600 }}>{it.code}</b> {it.name}
        <div className="text-sm" style={{ color: 'inherit', opacity: 0.8 }}>
          {range(it.start, it.end)}
          {re3 === 'a' && it.was && ` · was ${range(it.was[0], it.was[1])}`}
        </div>
      </span>
      {re3 === 'a' && it.was && <Dot color="var(--today)" />}
      {(re3 === 'a' || re3 === 'b') && it.decision && <Flag />}
      {it.isNew && <span className="text-xs" style={{ background: 'var(--pass-bg)', borderRadius: 6, padding: '0 6px', alignSelf: 'start' }}>New</span>}
      <Avatar name={it.owner} size={22} />
    </div>
  );
}

function NnlAdd({ c, open }: { c: Ctx; open: boolean }) {
  if (open)
    return (
      <>
      {c.v === 'c' && <div style={{ height: 2, background: 'var(--accent)', position: 'relative' }}><span style={{ position: 'absolute', left: -6, top: -11, width: 24, height: 24, borderRadius: 12, background: 'var(--accent)', color: 'var(--on-accent)', display: 'grid', placeItems: 'center' }}>+</span></div>}
      <div style={{ border: '1.5px solid var(--accent)', borderRadius: 8, padding: 8, display: 'grid', gap: 6, background: 'var(--accent-soft)', position: 'relative' }}>
        {c.v === 'b' && c.st === 'open' ? (
          // The hold is still filling the ring: the title field opens only once it is full.
          <div style={{ height: 52, position: 'relative' }}>
            <span aria-hidden style={{ position: 'absolute', left: '50%', top: 6, marginLeft: -20, width: 40, height: 40, borderRadius: 20, background: 'conic-gradient(var(--accent) 0 75%, color-mix(in srgb, var(--accent) 25%, transparent) 75% 100%)', WebkitMask: 'radial-gradient(circle, transparent 14px, #000 15px)', mask: 'radial-gradient(circle, transparent 14px, #000 15px)' }} />
          </div>
        ) : (
          <>
        {c.v === 'b' && (
          <span aria-hidden style={{ position: 'absolute', right: 14, top: 8, width: 40, height: 40, borderRadius: 20, background: 'conic-gradient(var(--accent) 0 75%, color-mix(in srgb, var(--accent) 25%, transparent) 75% 100%)', WebkitMask: 'radial-gradient(circle, transparent 14px, #000 15px)', mask: 'radial-gradient(circle, transparent 14px, #000 15px)' }} />
        )}
        <TitleInput value="Paper bill reminders" w={160} />
        <span className="text-sm" style={{ color: 'var(--text2)' }}>Next · Cut bill shocks</span>
          </>
        )}
      </div>
      </>
    );
  if (c.v === 'c' || c.v === 'd' || c.v === 'b') return null;
  return (
    <div className="text-base" style={{ border: '1.5px dashed var(--line)', borderRadius: 8, padding: '6px 10px', color: 'var(--accent)' }}>
      ＋ Add
    </div>
  );
}

/** RE2 on a phone: tapping a card opens a sheet whose fields save as they change. */
function PhoneSheet({ c }: { c: Ctx }) {
  if (c.dec !== 're2' || c.viewer) return null;
  const it = RE_ITEMS[1];
  if (c.v === 'd') {
    // RE2 D on a phone: the panel's own labelled fields, as a tall sheet.
    const box: CSSProperties = { border: '1px solid var(--line)', borderRadius: 8, padding: '6px 10px', display: 'flex', gap: 8, alignItems: 'center' };
    const f = (label: string, body: ReactNode) => (
      <div style={{ display: 'grid', gap: 2 }}>
        <span className="text-sm" style={{ color: 'var(--text2)' }}>{label}</span>
        <span className="text-base" style={box}>{body}</span>
      </div>
    );
    return (
      <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, top: 120, background: 'var(--surface)', borderTop: '1px solid var(--line)', borderRadius: '18px 18px 0 0', boxShadow: 'var(--tip-shadow)', padding: 16, display: 'grid', gap: 12, alignContent: 'start', zIndex: 60 }}>
        <span style={{ width: 40, height: 4, borderRadius: 2, background: 'var(--line-strong)', justifySelf: 'center' }} />
        <span className="text-xl" style={{ fontWeight: 700 }}>
          {it.code} {it.name}
        </span>
        {f('Name', it.name)}
        {f('Dates', range(it.start, it.end))}
        {f('Owner', <><Avatar name={it.owner} size={20} /> {it.owner}</>)}
        {f('Track', `${it.track} ▾`)}
        {f('Goal', `${it.goal} ▾`)}
      </div>
    );
  }
  if (c.v === 'c')
    return (
      <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, background: 'var(--surface)', borderTop: '1px solid var(--line)', boxShadow: 'var(--tip-shadow)', padding: 12, display: 'grid', gap: 8, zIndex: 60 }}>
        <span className="text-base" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <b style={{ fontWeight: 600 }}>{it.code}</b>
          <TitleInput value={it.name} w={250} />
        </span>
        <div className="text-base" style={{ display: 'flex', gap: 6 }}>
          <span style={btnOn}>Nov 16 – Jan 8 ▾</span>
          <span style={{ ...btn, display: 'flex', gap: 6, alignItems: 'center' }}>
            <Avatar name={it.owner} size={18} /> ▾
          </span>
          <span style={btn}>Billing ▾</span>
        </div>
      </div>
    );
  return (
    <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, background: 'var(--surface)', borderTop: '1px solid var(--line)', borderRadius: '18px 18px 0 0', boxShadow: 'var(--tip-shadow)', padding: 16, display: 'grid', gap: 10, zIndex: 60 }}>
      <span style={{ width: 40, height: 4, borderRadius: 2, background: 'var(--line-strong)', justifySelf: 'center' }} />
      <span className="text-base" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <b style={{ fontWeight: 600 }}>{it.code}</b>
        <TitleInput value={it.name} w={270} />
      </span>
      <div className="text-base" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={btn}>−1 wk</span>
        <span style={{ flex: 1, textAlign: 'center' }}>{range(it.start, it.end)}</span>
        <span style={btn}>+1 wk</span>
      </div>
      <div style={{ position: 'relative', minWidth: 0 }}>
        <div className="text-base" style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingRight: 40 }}>
          {RE_PEOPLE.slice(0, 4).map((p) => (
            <span key={p} style={{ ...(p === it.owner ? btnOn : btn), display: 'flex', gap: 6, alignItems: 'center', flex: 'none' }}>
              <Avatar name={p} size={18} /> {p.split(' ')[0]}
            </span>
          ))}
        </div>
        {/* The row scrolls: a fade and an arrow say there is more to the right. */}
        <span aria-label="More people" style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 56, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', background: 'linear-gradient(to right, transparent, var(--surface) 60%)', color: 'var(--text2)', fontSize: 20, pointerEvents: 'none' }}>
          ›
        </span>
      </div>
      <div className="text-base" style={{ display: 'flex', gap: 6 }}>
        {RE_TRACKS.map((t) => (
          <span key={t} style={t === it.track ? btnOn : btn}>{t.replace(' track', '')}</span>
        ))}
      </div>
    </div>
  );
}

/** RE2 D: the feature panel as today, but every field is live: no Change link, no Save. */
function SidePanel({ c }: { c: Ctx }) {
  const it = RE_ITEMS[1];
  const owner = c.st === 'result' ? 'Ines Okafor' : c.st === 'mid' ? 'Ine' : (it.owner ?? '');
  const field = (label: string, body: ReactNode, saved?: boolean) => (
    <div style={{ display: 'grid', gap: 4 }}>
      <span className="text-sm" style={{ color: 'var(--text2)', display: 'flex', gap: 8 }}>
        {label}
        {saved && <span style={{ color: 'var(--pass)' }}>✓ Saved</span>}
      </span>
      {body}
    </div>
  );
  const box: CSSProperties = { border: '1px solid var(--line)', borderRadius: 8, padding: '4px 10px', background: 'var(--surface)' };
  return (
    <aside style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 420, background: 'var(--surface)', borderLeft: '1px solid var(--line)', boxShadow: 'var(--tip-shadow)', padding: 24, display: 'grid', gap: 16, alignContent: 'start', zIndex: 45 }}>
      <div className="text-2xl" style={{ fontWeight: 700 }}>
        {it.code} {it.name}
      </div>
      {field('Name', <span className="text-base" style={box}>{it.name}</span>)}
      {field('Dates', <span className="text-base" style={{ display: 'flex', gap: 8 }}><span style={box}>Nov 16</span>–<span style={box}>Jan 8</span></span>)}
      {field(
        'Owner',
        <span style={{ position: 'relative' }}>
          {c.st === 'mid' ? <TitleInput value={owner} w={360} /> : <span className="text-base" style={{ ...box, display: 'flex', gap: 8, alignItems: 'center' }}><Avatar name={owner} size={20} /> {owner}</span>}
          {c.st === 'mid' && (
            <div style={{ ...pop, left: 0, top: 34 }}>
              <PeopleList pick="Ines Okafor" />
            </div>
          )}
        </span>,
        c.st === 'result',
      )}
      {field('Track', <span className="text-base" style={box}>{it.track} ▾</span>)}
      {field('Goal', <span className="text-base" style={box}>{it.goal} ▾</span>)}
    </aside>
  );
}

/** RE2 D for a viewer: the same panel, read only. */
function ReadPanel() {
  const it = reBigItems().find((i) => i.id === 'x2')!;
  const field = (label: string, body: ReactNode) => (
    <div style={{ display: 'grid', gap: 2 }}>
      <span className="text-sm" style={{ color: 'var(--text2)' }}>{label}</span>
      <span className="text-base" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{body}</span>
    </div>
  );
  return (
    <aside style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 420, background: 'var(--surface)', borderLeft: '1px solid var(--line)', boxShadow: 'var(--tip-shadow)', padding: 24, display: 'grid', gap: 16, alignContent: 'start', zIndex: 45 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="text-sm" style={{ ...btn, color: 'var(--text2)' }}>🔒 View only</span>
        <span style={{ flex: 1 }} />
        <span className="text-base" aria-label="Close" style={{ ...btn, padding: '2px 10px' }}>✕</span>
      </div>
      <div className="text-2xl" style={{ fontWeight: 700 }}>
        {it.code} {it.name}
      </div>
      <span className="text-sm" style={{ color: 'var(--text2)' }}>{"You can read this feature. The roadmap's owner, Mara Quill, can change it."}</span>
      {field('Dates', range(it.start, it.end))}
      {field('Owner', <><Avatar name={it.owner} size={20} /> {it.owner ?? 'No owner yet'}</>)}
      {field('Track', it.track)}
      {field('Goal', it.goal)}
    </aside>
  );
}

// ——— the page ———

export function ReMock() {
  const p = useSearchParams();
  const dec: Dec = p.get('re1') ? 're1' : p.get('re2') ? 're2' : 're3';
  const v = p.get(dec) ?? 'a';
  const st = p.get('st') ?? 'rest';
  const viewer = p.get('viewer') === '1' || (st === 'hard' && ((dec === 're2' && (v === 'c' || v === 'd')) || dec === 're3'));
  const phone = useNarrow();
  const c: Ctx = { dec, v, st, viewer };
  const big = st === 'hard';
  const items = big ? reBigItems() : RE_ITEMS;
  const view = phone ? 'nnl' : p.get('view') ?? (big && dec === 're1' ? 'gantt' : 'tl');
  const counts = {
    changed: items.filter((i) => i.was).length,
    decide: items.filter((i) => i.decision).length - (dec === 're3' && st === 'result' ? 1 : 0),
    drafts: items.filter((i) => i.kind === 'draft').length,
  };
  let toast: ReactNode = null;
  if (st === 'result' && dec === 're1')
    toast = <span>Added <b>F-31 Paper bill reminders</b> to Billing track · Dec 7 – {v === 'c' ? 'Feb 5' : 'Jan 29'}</span>;
  if (st === 'result' && dec === 're2')
    toast = v === 'd' ? <span>Owner of <b>F-14 Spike alerts by text</b> set to Ines Okafor</span> : v === 'c' ? <span>Moved <b>F-14 Spike alerts by text</b> to Mobile app track</span> : <span>Moved <b>F-14 Spike alerts by text</b> to Mobile app track · Dec 7 – Jan 29</span>;
  if (st === 'result' && dec === 're3') toast = <span>Owner of <b>F-17 Split bills between flatmates</b> set to Sofi Arden</span>;
  const shownItems =
    dec === 're3' && st === 'result'
      ? items.map((i) => (i.id === 'a3' ? { ...i, owner: 'Sofi Arden', decision: undefined } : i))
      : items;
  return (
    <div data-testid="re-mock" className="text-base" style={{ padding: phone ? '12px 12px 260px' : '20px 24px 80px', color: 'var(--text)' }}>
      <Header c={c} view={view} counts={counts} />
      <AddBar c={c} phone={phone} />
      {view === 'nnl' ? (
        <Nnl c={c} items={shownItems} phone={phone} />
      ) : (
        <Board c={c} items={shownItems} by={view === 'gantt' ? 'goal' : 'track'} />
      )}
      {phone && (st === 'open' || st === 'mid' || st === 'rest') && dec === 're2' && st !== 'rest' && <PhoneSheet c={c} />}
      {!phone && dec === 're2' && v === 'd' && (st === 'open' || st === 'mid' || st === 'result') && <SidePanel c={c} />}
      {!phone && dec === 're2' && v === 'd' && st === 'hard' && <ReadPanel />}
      {toast && <Toast>{toast}</Toast>}
    </div>
  );
}
