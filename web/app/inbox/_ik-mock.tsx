'use client';
// MOCK-HOOK (whole file): mk-inbox-keys mock-ups only, behind ?ik1= / ?ik2= / ?ik3= on the Inbox. Never merged.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'; // MOCK-HOOK

import { Button, Chip, Icon, Panel, Sheet, toast } from '@/components/ds'; // MOCK-HOOK
import { TabBar } from '@/components/review/parts'; // MOCK-HOOK
import { IK_SNOOZED, ikItems, type IkItem } from '@/lib/api/mock/ik-inbox'; // MOCK-HOOK

type St = 'new' | 'open' | 'staged' | 'declined' | 'done' | 'snoozed'; // MOCK-HOOK
type Verb = 'main' | 'decline' | 'watch' | 'done'; // MOCK-HOOK
type Snz = { until: string; event?: string }; // MOCK-HOOK
type Model = { st: Record<string, St>; snz: Record<string, Snz>; back: Record<string, boolean> }; // MOCK-HOOK

/** The mock-up switches, read once from the URL. MOCK-HOOK */
export function ikParams(sp: URLSearchParams) { // MOCK-HOOK
  const on = sp.has('ik1') || sp.has('ik2') || sp.has('ik3');
  return {
    on,
    v1: sp.get('ik1') ?? 'a',
    v2: sp.get('ik2') ?? 'a',
    v3: sp.get('ik3') ?? 'a',
    has3: sp.has('ik3'),
    role: sp.get('role') ?? 'owner',
    long: sp.get('long') === '1',
    many: sp.get('many') === '1',
    tomorrow: sp.get('now') === 'nov25',
    cost: sp.get('cost'),
    swipe: sp.get('swipe'),
    focus: Number(sp.get('f') ?? '0'),
    seeded: sp.get('snoozed') === '1',
  };
} // MOCK-HOOK
type P = ReturnType<typeof ikParams>; // MOCK-HOOK

const TIMES: { key: string; label: string; when: string; until: string }[] = [ // MOCK-HOOK
  { key: '1', label: 'Later today', when: '5:00 PM', until: 'Nov 24, 5:00 PM' },
  { key: '2', label: 'Tomorrow', when: 'Wed Nov 25, 9:00 AM', until: 'Nov 25, 9:00 AM' },
  { key: '3', label: 'Next week', when: 'Mon Nov 30, 9:00 AM', until: 'Nov 30, 9:00 AM' },
]; // MOCK-HOOK
const DAYS = ['Wed Nov 25', 'Thu Nov 26', 'Fri Nov 27', 'Mon Nov 30', 'Tue Dec 1', 'Wed Dec 2', 'Thu Dec 3', 'Fri Dec 4', 'Mon Dec 7', 'Tue Dec 8']; // MOCK-HOOK

/** Each proposal's cost, drawn only on frames with &cost= (a mock-up note, not product). MOCK-HOOK */
const COST: Record<string, string> = { // MOCK-HOOK
  'ik1-a': 'Keys: j j j ↵ · 4 keys, hands stay on the keyboard · Today: scroll, find the row, 1 click',
  'ik1-b': 'Keys: j j j · 3 keys, the item reads at once · Today: scroll, 1 click, Back to return',
  'ik1-d': 'Keys: j x j x j x then a · 7 keys for 3 items · Today: 3 rows × 1 click, each waits for its banner',
  'ik2-a': 'Keys: a · 1 key, focus moves on · Today: find the button, 1 click, then find the next row',
  'ik2-b': 'Keys: a j d e then ⇧↵ · 5 keys for 3 items · Today: 3 clicks, no way to settle them together',
  'ik2-c': 'Keys: Space then a · 2 keys, the menu says what each does · Today: 1 click',
  'ik3-a': 'Keys: s 2 · 2 keys · Today: not possible: the item stays and is counted',
  'ik3-b': 'Keys: s · 1 key for tomorrow, ⇧s for a date · Today: not possible',
  'ik3-c': 'Keys: s ↓ ↓ ↵ · 4 keys · Today: not possible',
}; // MOCK-HOOK

function Kbd({ k, quiet }: { k: string; quiet?: boolean }) { // MOCK-HOOK
  return (
    <kbd
      className={`ml-1.5 inline-grid h-5 min-w-5 place-items-center rounded border px-1 font-mono text-xs leading-none ${quiet ? 'border-line text-text2' : 'border-line bg-surface2 text-text'}`}
    >
      {k}
    </kbd>
  );
} // MOCK-HOOK

const TAB_LABEL: Record<St, string> = { new: 'New', open: 'Seen', staged: 'Staged', declined: 'Declined', done: 'Done', snoozed: 'Snoozed' }; // MOCK-HOOK

export function IkInbox({ p }: { p: P }) { // MOCK-HOOK
  const items = useMemo(() => ikItems({ long: p.long, many: p.many }), [p.long, p.many]);
  const byId = useMemo(() => Object.fromEntries([...items, ...IK_SNOOZED.map((s) => s.item)].map((i) => [i.id, i])), [items]);
  const [m, setM] = useState<Model>(() => {
    const st: Record<string, St> = {};
    const snz: Record<string, Snz> = {};
    const back: Record<string, boolean> = {};
    for (const i of items) st[i.id] = i.seen ? 'open' : 'new';
    for (const s of IK_SNOOZED) {
      if (!p.seeded && !p.tomorrow) continue;
      if (p.tomorrow && s.until.startsWith('Nov 25')) {
        st[s.item.id] = 'new';
        back[s.item.id] = true;
      } else {
        st[s.item.id] = 'snoozed';
        snz[s.item.id] = { until: s.until, event: s.event };
      }
    }
    return { st, snz, back };
  });
  const [undo, setUndo] = useState<{ msg: string; prev: Model } | null>(null);
  const [tab, setTab] = useState<St>('new');
  const [focus, setFocus] = useState<string | null>(null);
  const [kbd, setKbd] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [menu, setMenu] = useState<null | 'keys' | 'snooze' | 'dates' | 'actions'>(null);
  const [menuAt, setMenuAt] = useState(0);
  const [marks, setMarks] = useState<Record<string, Verb>>({});
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [sheet, setSheet] = useState<string | null>(null);
  const [swiped, setSwiped] = useState<string | null>(p.swipe);
  const commenter = p.role === 'commenter';
  const ids = Object.keys(m.st);
  const shown = ids.filter((id) => m.st[id] === tab).sort((a, b) => Number(!!m.back[b]) - Number(!!m.back[a])).map((id) => byId[id]);
  const count = (s: St) => ids.filter((id) => m.st[id] === s).length;
  const waiting = count('new') + count('open');
  const focused = focus ?? (shown[p.focus]?.id ?? null);
  const fi = shown.findIndex((i) => i.id === focused);
  const cur = fi >= 0 ? shown[fi] : null;
  const may = (i: IkItem) => !(commenter && i.ownerOnly);

  const orig = useRef<string | null>(null);
  // Every count at once: the rail's Inbox badge follows the panel's (the mock-up reads it from the page). MOCK-HOOK
  useEffect(() => {
    const put = () => {
    for (const c of Array.from(document.querySelectorAll<HTMLElement>('.simple-count'))) {
      if (c.dataset.ik === '1' || (orig.current && c.textContent === orig.current && !c.closest('a[href*="decisions"], a[href*="roadmap"]'))) {
        c.dataset.ik = '1';
        if (c.textContent !== String(waiting)) c.textContent = String(waiting);
      }
    }
    for (const a of Array.from(document.querySelectorAll('a'))) {
      if (!/^Inbox\s*\d*$/.test((a.textContent ?? '').trim())) continue;
      const n = Array.from(a.querySelectorAll('*')).find((s) => s.children.length === 0 && /^\d+$/.test(s.textContent ?? ''));
      if (n && orig.current === null) orig.current = n.textContent;
      if (n && n.textContent !== String(waiting)) n.textContent = String(waiting);
    }
    };
    put();
    const t = window.setInterval(put, 200);
    return () => window.clearInterval(t);
  }, [waiting]);

  const nextFocus = (gone: string[]) => {
    const rest = shown.filter((i) => !gone.includes(i.id));
    const after = shown.slice(fi + 1).find((i) => !gone.includes(i.id));
    setFocus(after?.id ?? rest[rest.length - 1]?.id ?? null);
  };

  function apply(list: IkItem[], verb: Verb | { snooze: Snz }, say?: string) {
    const prev = m;
    const st = { ...m.st };
    const snz = { ...m.snz };
    let msg = say ?? '';
    for (const i of list) {
      if (typeof verb === 'object') {
        st[i.id] = 'snoozed';
        snz[i.id] = verb.snooze;
        msg = `Snoozed until ${verb.snooze.event ?? verb.snooze.until}`;
      } else if (verb === 'main') {
        st[i.id] = i.main === 'Accept' ? 'staged' : 'done';
        msg ||= i.did;
      } else if (verb === 'decline') {
        st[i.id] = 'declined';
        msg ||= 'Declined: the item is left as it was';
      } else if (verb === 'watch') {
        st[i.id] = 'open';
        msg ||= 'Kept in Seen: it stays counted';
      } else {
        st[i.id] = 'done';
        msg ||= 'Marked done';
      }
    }
    if (list.length > 1 && !say) msg = `${list.length} items settled`;
    setM({ ...m, st, snz });
    nextFocus(list.map((i) => i.id));
    setMenu(null);
    setOpenId(null);
    setSheet(null);
    setSwiped(null);
    if (p.v2 === 'c') {
      toast({ message: msg, action: { label: 'Undo', onClick: () => setM(prev) } });
      setUndo({ msg, prev });
    } else setUndo({ msg, prev });
  }

  function verbOn(i: IkItem, verb: Verb) {
    if (verb !== 'watch' && verb !== 'done' && !may(i)) {
      setUndo(null);
      setDenied(i.id);
      return;
    }
    if (verb === 'decline' && !i.decline) return;
    if (p.v2 === 'b' && p.v1 !== 'b') {
      setMarks((s) => ({ ...s, [i.id]: verb }));
      return;
    }
    if (verb === 'main' && p.v1 !== 'b' && (i.main === 'Review' || i.main === 'Answer')) {
      setOpenId(i.id);
      return;
    }
    apply([i], verb);
  }
  const [denied, setDenied] = useState<string | null>(null);

  function snooze(i: IkItem | null, s: Snz) {
    if (!i) return;
    const list = p.v1 === 'd' && ticked.size ? shown.filter((x) => ticked.has(x.id)) : [i];
    apply(list, { snooze: s });
    setTicked(new Set());
  }

  // The keys. MOCK-HOOK
  const ref = useRef<(e: KeyboardEvent) => void>(() => undefined);
  ref.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, select')) return;
    const k = e.key;
    setKbd(true);
    setDenied(null);
    if (menu === 'snooze' || menu === 'dates') {
      if (k === 'Escape') return setMenu(null);
      if (p.v3 === 'c') {
        const opts = snoozeEvents(cur);
        if (k === 'ArrowDown' || k === 'j') return setMenuAt((n) => Math.min(n + 1, opts.length - 1));
        if (k === 'ArrowUp' || k === 'k') return setMenuAt((n) => Math.max(n - 1, 0));
        if (k === 'Enter') return snooze(cur, opts[menuAt].snz);
        return;
      }
      if (menu === 'dates') {
        const d = Number(k);
        if (d >= 1 && d <= 9) snooze(cur, { until: `${DAYS[d - 1]}, 9:00 AM` });
        return;
      }
      const t2 = TIMES.find((x) => x.key === k);
      if (t2) return snooze(cur, { until: t2.until });
      if (k === '4') return setMenu('dates');
      return;
    }
    if (menu === 'actions' && cur) {
      if (k === 'Escape') return setMenu(null);
      if (k === 'a') return verbOn(cur, 'main');
      if (k === 'd') return verbOn(cur, 'decline');
      if (k === 'w') return verbOn(cur, 'watch');
      if (k === 'e') return verbOn(cur, 'done');
      if (k === 's') return setMenu('snooze');
      return;
    }
    if (!kbd && p.focus === 0 && p.v1 !== 'b' && (k === 'j' || k === 'k' || k === 'ArrowDown' || k === 'ArrowUp')) {
      e.preventDefault();
      return;
    }
    if (k === 'j' || k === 'ArrowDown') {
      e.preventDefault();
      const n = shown[Math.min(fi + 1, shown.length - 1)];
      if (n) setFocus(n.id);
      return;
    }
    if (k === 'k' || k === 'ArrowUp') {
      e.preventDefault();
      const n = shown[Math.max(fi - 1, 0)];
      if (n) setFocus(n.id);
      return;
    }
    if (k === '?') return setMenu(menu === 'keys' ? null : 'keys');
    if (k === 'Escape') {
      setMenu(null);
      setOpenId(null);
      return;
    }
    if (k === 'z' && undo) {
      setM(undo.prev);
      setUndo({ msg: 'Undone', prev: undo.prev });
      return;
    }
    if (!cur) return;
    if (k === 'x' && p.v1 === 'd') {
      setTicked((s) => {
        const n = new Set(s);
        if (!n.delete(cur.id)) n.add(cur.id);
        return n;
      });
      return;
    }
    if (k === 'Enter' && e.shiftKey && p.v2 === 'b') {
      const list = Object.keys(marks).map((id) => byId[id]);
      if (!list.length) return;
      const prev = m;
      const st = { ...m.st };
      for (const i of list) {
        const v = marks[i.id];
        st[i.id] = v === 'main' ? (i.main === 'Accept' ? 'staged' : 'done') : v === 'decline' ? 'declined' : v === 'watch' ? 'open' : 'done';
      }
      setM({ ...m, st });
      setMarks({});
      setFocus(shown.find((i) => !marks[i.id] && st[i.id] === tab)?.id ?? null);
      setUndo({ msg: `${list.length} items settled`, prev });
      return;
    }
    if (k === 'Enter') return setOpenId(openId === cur.id ? null : cur.id);
    if (p.v2 === 'c' && (k === ' ' || k === '.')) {
      e.preventDefault();
      return setMenu('actions');
    }
    if (p.v2 === 'c' && k !== 's' && k !== 'S') return;
    if (k === 'S' || (k === 's' && p.v3 === 'b' && e.shiftKey)) {
      setMenu('dates');
      return;
    }
    if (k === 's') {
      if (p.v3 === 'b') return snooze(cur, { until: 'Nov 25, 9:00 AM' });
      setMenuAt(0);
      return setMenu('snooze');
    }
    const verb: Verb | null = k === 'a' ? 'main' : k === 'd' ? 'decline' : k === 'w' ? 'watch' : k === 'e' ? 'done' : null;
    if (!verb) return;
    if (p.v1 === 'd' && ticked.size) {
      const list = shown.filter((i) => ticked.has(i.id) && (verb === 'watch' || verb === 'done' || may(i)));
      apply(list, verb, `${list.length} items ${verb === 'main' ? 'accepted' : verb === 'decline' ? 'declined' : 'settled'}`);
      setTicked(new Set());
      return;
    }
    if (p.v2 === 'b') {
      if (verb !== 'watch' && verb !== 'done' && !may(cur)) return setDenied(cur.id);
      setMarks((s) => ({ ...s, [cur.id]: verb }));
      const n = shown[fi + 1];
      if (n) setFocus(n.id);
      return;
    }
    verbOn(cur, verb);
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => ref.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // Keep the focused row in view. MOCK-HOOK
  useEffect(() => {
    if (!kbd || !focused) return;
    document.querySelector(`[data-ik-row="${focused}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [focused, kbd]);

  const tabs: St[] = ['new', 'open', 'staged', 'declined', 'done', ...(p.v3 === 'a' && p.has3 ? (['snoozed'] as St[]) : [])];
  const snoozedList = ids.filter((id) => m.st[id] === 'snoozed');
  const showHints = kbd || p.v1 !== 'a';

  const banner = (undo || denied) && p.v2 !== 'c' && (
    <div className="mx-4 mt-3 flex flex-wrap items-center gap-2 rounded-goal border border-line bg-surface2 px-3 py-2 text-base" role="status" data-testid="ik-notice">
      <Icon name={denied ? 'lock' : 'check'} />
      <span>{denied ? 'Owners decide this one' : undo?.msg}</span>
      {!denied && undo && undo.msg !== 'Undone' && (
        <button type="button" className="font-semibold text-accent-ink hover:underline" onClick={() => setM(undo.prev)}>
          Undo
          <Kbd k="z" quiet />
        </button>
      )}
    </div>
  );

  return (
    <div className="relative">
      <Panel
        title="Needs you"
        count={waiting}
        testId="inbox-needs"
        tools={
          <div className="relative ml-auto flex items-center gap-2">
            {p.v1 === 'a' && (
              <button
                type="button"
                aria-expanded={menu === 'keys'}
                onClick={() => setMenu(menu === 'keys' ? null : 'keys')}
                className="inline-flex items-center rounded-goal px-2 py-1 text-sm font-semibold text-text2 hover:bg-surface2 max-[600px]:hidden"
              >
                <Icon name="more" />
                <span className="ml-1">Keys</span>
                <Kbd k="?" quiet />
              </button>
            )}
            {menu === 'keys' && <KeySheet v2={p.v2} v3={p.v3} />}
          </div>
        }
      >
        <div className="px-4 pt-1 max-[600px]:overflow-x-auto max-[600px]:px-2 max-[600px]:[&_[role=tab]]:px-1.5 max-[600px]:[&_[role=tablist]]:flex-nowrap">
          <TabBar
            label="Inbox by state"
            size="sm"
            tabs={tabs.map((t) => ({ id: t, label: TAB_LABEL[t], count: count(t) || null }))}
            value={tab}
            onChange={(t: St) => {
              setTab(t);
              setFocus(null);
            }}
          />
        </div>
        {banner}
        {p.v1 === 'd' && ticked.size > 0 && (
          <div className="sticky top-0 z-10 mx-4 mt-3 flex flex-wrap items-center gap-2 rounded-goal border border-accent bg-accent-soft px-3 py-2 text-base" data-testid="ik-bulk">
            <b className="tnum">{ticked.size} ticked</b>
            <span className="ml-auto flex flex-wrap gap-2">
              <Button>Accept<Kbd k="a" /></Button>
              <Button>Decline<Kbd k="d" /></Button>
              <Button>Snooze<Kbd k="s" /></Button>
              <Button variant="ghost" onClick={() => setTicked(new Set())}>Clear<Kbd k="Esc" quiet /></Button>
            </span>
          </div>
        )}
        {p.v1 === 'b' ? (
          <Split shown={shown} focused={focused} setFocus={setFocus} may={may} p={p} openSheet={setSheet} marks={marks} onVerb={verbOn} />
        ) : (
          <ul className="mt-2" data-testid="ik-list">
            {shown.map((i) => (
              <Row
                key={i.id}
                i={i}
                p={p}
                focused={i.id === focused && (kbd || p.focus > 0 || !!focus)}
                hints={showHints}
                open={openId === i.id}
                back={!!m.back[i.id]}
                mark={marks[i.id]}
                ticked={ticked.has(i.id)}
                may={may(i)}
                denied={denied === i.id}
                swiped={swiped === i.id}
                snz={m.snz[i.id]}
                onSwipe={() => setSwiped(swiped === i.id ? null : i.id)}
                onFocus={() => setFocus(i.id)}
                onVerb={(v) => verbOn(i, v)}
                onLater={() => setSheet(i.id)}
                onSnooze={(s) => snooze(i, s)}
                onWake={() => setM({ ...m, st: { ...m.st, [i.id]: 'new' }, back: { ...m.back, [i.id]: true } })}
                menu={i.id === focused ? menu : null}
                menuAt={menuAt}
                onPick={(s) => snooze(i, s)}
                onMenuDates={() => setMenu('dates')}
              />
            ))}
            {shown.length === 0 && <li className="px-4 py-8 text-center text-base text-text2">Nothing {TAB_LABEL[tab].toLowerCase()}</li>}
          </ul>
        )}
        {p.v3 === 'b' && tab === 'new' && snoozedList.length > 0 && (
          <SnoozeFold list={snoozedList.map((id) => ({ i: byId[id], s: m.snz[id] }))} />
        )}
        {p.v3 === 'c' && tab === 'open' && snoozedList.length > 0 && (
          <section className="border-t border-line pb-2" aria-label="Coming back">
            <h3 className="px-4 pt-3 pb-1 text-sm font-semibold tracking-[0.02em] text-text2">Coming back · {snoozedList.length}</h3>
            {snoozedList.map((id) => (
              <div key={id} className="flex items-center gap-3 px-4 py-2 text-base text-text2">
                <Icon name="clock" />
                <ItemName i={byId[id]} />
                <span className="ml-auto text-sm">{m.snz[id].event ?? `Back ${m.snz[id].until}`}</span>
              </div>
            ))}
          </section>
        )}
        {p.v2 === 'b' && Object.keys(marks).length > 0 && (
          <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 rounded-b-panel border-t border-line bg-surface px-4 py-2.5 text-base" data-testid="ik-apply">
            <b className="tnum">{Object.keys(marks).length} marked</b>
            <span className="text-text2">
              {(['main', 'decline', 'done', 'watch'] as Verb[])
                .map((v) => [v, Object.values(marks).filter((x) => x === v).length] as const)
                .filter(([, n]) => n)
                .map(([v, n]) => `${n} ${MARK[v].toLowerCase()}`)
                .join(' · ')}
            </span>
            <span className="ml-auto flex gap-2">
              <Button variant="ghost" onClick={() => setMarks({})}>Clear</Button>
              <Button variant="primary">Apply<Kbd k="⇧↵" /></Button>
            </span>
          </div>
        )}
      </Panel>
      {sheet && byId[sheet] && p.v1 !== 'b' && (
        <Sheet open title="Snooze until" onClose={() => setSheet(null)} above>
          <SnoozeOptions p={p} i={byId[sheet]} onPick={(s) => snooze(byId[sheet], s)} touch />
        </Sheet>
      )}
      {sheet && byId[sheet] && p.v1 === 'b' && (
        <Sheet open title={byId[sheet].kind} onClose={() => setSheet(null)} full>
          <Pane i={byId[sheet]} may={may(byId[sheet])} hints={false} onVerb={(v) => verbOn(byId[sheet], v)} />
        </Sheet>
      )}
      {p.cost && COST[p.cost] && (
        <div className="fixed top-3 left-1/2 z-50 -translate-x-1/2 rounded-full bg-text px-4 py-1.5 text-sm font-semibold text-surface shadow-panel max-[600px]:w-[92%] max-[600px]:rounded-goal" data-mockup-note>
          {COST[p.cost]}
        </div>
      )}
    </div>
  );
} // MOCK-HOOK

const MARK: Record<Verb, string> = { main: 'Accept', decline: 'Decline', done: 'Done', watch: 'Keep' }; // MOCK-HOOK

function snoozeEvents(i: IkItem | null): { label: string; sub: string; snz: Snz }[] { // MOCK-HOOK
  const who = i?.ctx.match(/(?:From|Asked by|Nudged by) ([A-Z][a-z]+)/)?.[1];
  return [
    { label: 'Tomorrow', sub: 'Wed Nov 25, 9:00 AM', snz: { until: 'Nov 25, 9:00 AM' } },
    { label: 'Next week', sub: 'Mon Nov 30, 9:00 AM', snz: { until: 'Nov 30, 9:00 AM' } },
    { label: 'Until Product sync', sub: 'Meetings · Thu Nov 26, 10:00 AM', snz: { until: 'Nov 26, 10:00 AM', event: 'Product sync, Thu Nov 26' } },
    ...(who ? [{ label: `Until ${who} replies`, sub: 'or Mon Nov 30 at the latest', snz: { until: 'Nov 30', event: `${who} replies` } }] : []),
    ...(i?.kind === 'Cost approval' || i?.kind === 'Checkpoint' ? [{ label: 'Until the run moves', sub: 'its next step or Fri Nov 27', snz: { until: 'Nov 27', event: 'the run moves' } }] : []),
  ];
} // MOCK-HOOK

function ItemName({ i }: { i: IkItem }) { // MOCK-HOOK
  return (
    <span className="min-w-0 [overflow-wrap:anywhere]">
      {i.code && <code className="mr-1.5 rounded bg-accent-soft px-1 font-mono text-sm font-semibold text-accent-ink">{i.code}</code>}
      {i.code ? <span className="font-medium text-accent-ink">{i.ctx.split(' · ').pop()}</span> : null}
      {i.code ? <span className="block text-sm text-text2">{i.title}</span> : <span>{i.title}</span>}
    </span>
  );
} // MOCK-HOOK

function KeySheet({ v2, v3 }: { v2: string; v3: string }) { // MOCK-HOOK
  const rows: [string, string][] = [
    ['j  k', 'Move'],
    ['↵', 'Open here'],
    ...(v2 === 'c' ? ([['Space', 'Actions']] as [string, string][]) : ([['a', 'Accept or approve'], ['d', 'Decline'], ['w', 'Keep watching'], ['e', 'Done']] as [string, string][])),
    [v3 === 'b' ? 's  ⇧s' : 's', 'Snooze'],
    ['z', 'Undo'],
    ['Esc', 'Close'],
  ];
  return (
    <div role="dialog" aria-label="Keys" className="absolute top-full right-0 z-30 mt-1 w-64 rounded-panel border border-line bg-surface p-2 shadow-panel" data-testid="ik-keys">
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-base">
        {rows.map(([k, l]) => (
          <div key={l} className="contents">
            <dt className="flex justify-end gap-1">
              {k.split('  ').map((x) => (
                <Kbd key={x} k={x} />
              ))}
            </dt>
            <dd>{l}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
} // MOCK-HOOK

function SnoozeOptions({ p, i, onPick, touch, at = 0, dates, onDates }: { p: P; i: IkItem; onPick: (s: Snz) => void; touch?: boolean; at?: number; dates?: boolean; onDates?: () => void }) { // MOCK-HOOK
  const [pickDate, setPickDate] = useState(!!dates);
  if (p.v3 === 'c')
    return (
      <ul className="py-1" role="menu" aria-label="Snooze until">
        {snoozeEvents(i).map((o, n) => (
          <li key={o.label}>
            <button type="button" role="menuitem" onClick={() => onPick(o.snz)} className={`flex w-full items-start gap-2 rounded-goal px-3 py-2 text-left ${n === at && !touch ? 'bg-accent-soft' : 'hover:bg-surface2'}`}>
              <Icon name={n < 2 ? 'clock' : n === 2 ? 'target' : 'user'} />
              <span>
                <span className="block text-base font-semibold">{o.label}</span>
                <span className="block text-sm text-text2">{o.sub}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    );
  if (pickDate || (dates && !touch))
    return (
      <div className="p-2">
        <div className="mb-1.5 text-sm font-semibold text-text2">Pick a day · 9:00 AM</div>
        <div className="grid grid-cols-5 gap-1.5 max-[600px]:grid-cols-3">
          {DAYS.map((d, n) => (
            <button key={d} type="button" onClick={() => onPick({ until: `${d}, 9:00 AM` })} className="flex items-center justify-between rounded-goal border border-line px-2 py-1.5 text-sm hover:bg-surface2">
              {d}
              {!touch && n < 9 && <Kbd k={String(n + 1)} quiet />}
            </button>
          ))}
        </div>
      </div>
    );
  return (
    <ul className="py-1" role="menu" aria-label="Snooze until">
      {TIMES.map((t) => (
        <li key={t.key}>
          <button type="button" role="menuitem" onClick={() => onPick({ until: t.until })} className="flex w-full items-center gap-3 rounded-goal px-3 py-2 text-left hover:bg-surface2 max-[600px]:py-3">
            <span className="text-base font-semibold">{t.label}</span>
            <span className="text-sm text-text2">{t.when}</span>
            {!touch && <span className="ml-auto"><Kbd k={t.key} quiet /></span>}
          </button>
        </li>
      ))}
      <li>
        <button type="button" role="menuitem" onClick={() => (onDates ? onDates() : setPickDate(true))} className="flex w-full items-center gap-3 rounded-goal px-3 py-2 text-left hover:bg-surface2 max-[600px]:py-3">
          <span className="text-base font-semibold">Pick a day</span>
          {!touch && <span className="ml-auto"><Kbd k="4" quiet /></span>}
        </button>
      </li>
    </ul>
  );
} // MOCK-HOOK

function Row(props: { // MOCK-HOOK
  i: IkItem; p: P; focused: boolean; hints: boolean; open: boolean; back: boolean; mark?: Verb; ticked: boolean; may: boolean; denied: boolean; swiped: boolean; snz?: Snz;
  onSwipe: () => void; onFocus: () => void; onVerb: (v: Verb) => void; onLater: () => void; onSnooze: (s: Snz) => void; onWake: () => void;
  menu: null | 'keys' | 'snooze' | 'dates' | 'actions'; menuAt: number; onPick: (s: Snz) => void; onMenuDates: () => void;
}) {
  const { i, p, focused } = props;
  const hint = (k: string) => (focused && props.hints ? <Kbd k={k} /> : null);
  const mainBtn = props.may ? (
    <Button onClick={() => props.onVerb('main')}>
      {i.main}
      {hint(i.main === 'Review' || i.main === 'Answer' ? '↵' : 'a')}
    </Button>
  ) : (
    <span className="text-sm whitespace-nowrap text-text2" data-testid="need-by-role">Owners decide</span>
  );
  const snoozedRow = !!props.snz;
  const actions = snoozedRow ? (
    <>
      <span className="text-sm text-text2">Back {props.snz!.until}</span>
      <Button variant="ghost" onClick={props.onWake}>Bring back now</Button>
    </>
  ) : p.v2 === 'c' && focused ? (
    <>
      {mainBtn}
      <Button variant="ghost" aria-expanded={props.menu === 'actions'}>
        <Icon name="more" />
        <span className="sr-only">Actions</span>
        {hint('Space')}
      </Button>
    </>
  ) : (
    <>
      {mainBtn}
      {i.decline && props.may && (
        <Button variant="ghost" onClick={() => props.onVerb('decline')}>
          Decline{hint('d')}
        </Button>
      )}
      <Button variant="ghost" aria-label="Snooze" onClick={props.onLater} className="max-[600px]:inline-flex">
        <Icon name="clock" />
        {hint('s')}
      </Button>
    </>
  );
  const swipeOffset = props.swiped ? 'max-[600px]:-translate-x-[180px]' : '';
  return (
    <li
      data-ik-row={i.id}
      data-focused={focused || undefined}
      onClick={props.onFocus}
      className={`relative border-t border-line first:border-t-0 ${props.swiped ? 'overflow-x-clip' : ''} ${focused} ? 'bg-accent-soft/40 shadow-[inset_3px_0_0_var(--color-accent)]' : ''} ${props.mark ? 'opacity-70' : ''}`}
    >
      {p.v3 === 'b' && props.swiped && (
        <div className="absolute inset-y-0 right-0 hidden w-[180px] items-stretch max-[600px]:flex">
          <button type="button" className="flex-1 bg-accent-soft text-sm font-semibold text-accent-ink" onClick={() => props.onSnooze({ until: 'Nov 25, 9:00 AM' })}>
            <Icon name="clock" />
            <span className="block">Tomorrow</span>
          </button>
          <button type="button" className="flex-1 bg-surface2 text-sm font-semibold" onClick={props.onLater}>
            <Icon name="more" />
            <span className="block">Later</span>
          </button>
        </div>
      )}
      <div className={`relative z-10 flex items-center gap-3 px-4 py-2.5 transition-transform max-[600px]:flex-wrap max-[600px]:px-3 ${swipeOffset} ${props.swiped ? 'bg-surface shadow-panel' : ''}`}>
        {p.v1 === 'd' && (
          <input type="checkbox" aria-label={`Tick ${i.title}`} checked={props.ticked} readOnly className="size-4 flex-none accent-[var(--color-accent)]" />
        )}
        <span className="flex w-[170px] flex-none items-center gap-2 text-base max-[1099px]:w-[15%] max-[600px]:w-full max-[600px]:text-sm max-[600px]:text-text2">
          <Icon name={i.icon} />
          {i.kind}
        </span>
        <span className="min-w-0 flex-1 text-base">
          {props.back && <span className="mb-0.5 block"><Chip kind="acc">Back from snooze</Chip></span>}
          <ItemName i={i} />
        </span>
        <span className="w-[24%] min-w-0 text-base text-text2 max-[1099px]:w-[20%] max-[600px]:hidden">
          <span className="line-clamp-2">{i.code ? i.ctx.split(' · ')[0] : i.ctx}</span>
        </span>
        <span className="w-10 flex-none text-base text-text2 tnum max-[600px]:hidden">{i.age}</span>
        <span className="flex flex-none flex-wrap items-center justify-end gap-2 max-[600px]:w-full max-[600px]:justify-start">
          {props.mark && <Chip kind={props.mark === 'decline' ? 'crit' : props.mark === 'main' ? 'pass' : 'line'}>{MARK[props.mark]}</Chip>}
          {props.denied && <Chip kind="warn">Owners decide</Chip>}
          {actions}
        </span>
      </div>
      {props.open && (
        <div className="mx-4 mb-3 rounded-goal border border-line bg-surface p-3 text-base max-[600px]:mx-3" data-testid="ik-open">
          <p>{i.detail}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {i.main === 'Answer' ? (
              <>
                <input aria-label="Your answer" className="min-w-60 flex-1 rounded-goal border border-line bg-surface px-2 py-1 text-base" defaultValue="" />
                <Button variant="primary">Send</Button>
              </>
            ) : (
              <Button variant="primary">Open the full page</Button>
            )}
            {p.v2 !== 'c' && (
              <>
                <Button variant="ghost" onClick={() => props.onVerb('watch')}>Keep watching<Kbd k="w" quiet /></Button>
                <Button variant="ghost" onClick={() => props.onVerb('done')}>Done<Kbd k="e" quiet /></Button>
              </>
            )}
            <span className="ml-auto self-center text-sm text-text2">
              <Kbd k="Esc" quiet /> Close
            </span>
          </div>
        </div>
      )}
      {(props.menu === 'snooze' || props.menu === 'dates') && (
        <div role="dialog" aria-label="Snooze until" className={`absolute top-full right-4 z-30 -mt-1 rounded-panel border border-line bg-surface p-1 shadow-panel ${props.menu === 'dates' ? 'w-[520px]' : 'w-80'}`} data-testid="ik-snooze">
          <SnoozeOptions p={p} i={i} onPick={props.onPick} at={props.menuAt} dates={props.menu === 'dates'} onDates={props.onMenuDates} />
        </div>
      )}
      {props.menu === 'actions' && (
        <div role="menu" aria-label="Actions" className="absolute top-full right-4 z-30 -mt-1 w-64 rounded-panel border border-line bg-surface p-1 shadow-panel" data-testid="ik-actions">
          {([
            ['main', props.may ? i.main : null, 'a'],
            ['decline', props.may && i.decline ? 'Decline' : null, 'd'],
            ['watch', 'Keep watching', 'w'],
            ['done', 'Done', 'e'],
            ['snooze', 'Snooze', 's'],
          ] as const)
            .filter(([, l]) => l)
            .map(([v, l, k]) => (
              <button key={v} type="button" role="menuitem" onClick={() => (v === 'snooze' ? undefined : props.onVerb(v))} className="flex w-full items-center rounded-goal px-3 py-2 text-left text-base hover:bg-surface2">
                {l}
                <span className="ml-auto"><Kbd k={k} quiet /></span>
              </button>
            ))}
          {!props.may && <div className="border-t border-line px-3 py-2 text-sm text-text2">Owners decide the rest</div>}
        </div>
      )}
    </li>
  );
} // MOCK-HOOK

function Pane({ i, may, hints, onVerb }: { i: IkItem; may: boolean; hints: boolean; onVerb: (v: Verb) => void }) { // MOCK-HOOK
  return (
    <div className="p-4" data-testid="ik-pane">
      <div className="flex items-center gap-2 text-sm text-text2">
        <Icon name={i.icon} />
        {i.kind} · {i.age}
      </div>
      <h3 className="mt-1 font-display text-xl font-bold tracking-heading"><ItemName i={i} /></h3>
      <p className="mt-1 text-base text-text2">{i.ctx}</p>
      <p className="mt-3 text-base">{i.detail}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {i.main === 'Answer' ? (
          <form className="flex w-full gap-2" onSubmit={(e) => { e.preventDefault(); onVerb('main'); }}>
            <input aria-label="Your answer" className="min-w-0 flex-1 rounded-goal border border-line bg-surface px-2 py-1 text-base" />
            <Button variant="primary" type="submit">Send{hints && <Kbd k="↵" />}</Button>
          </form>
        ) : may ? (
          <>
            <Button variant="primary" onClick={() => onVerb('main')}>{i.main}{hints && <Kbd k="a" />}</Button>
            {i.decline && <Button onClick={() => onVerb('decline')}>Decline{hints && <Kbd k="d" />}</Button>}
          </>
        ) : (
          <span className="self-center text-sm text-text2">Owners decide</span>
        )}
        <Button variant="ghost" onClick={() => onVerb('watch')}>Keep watching{hints && <Kbd k="w" quiet />}</Button>
        <Button variant="ghost"><Icon name="clock" /> Snooze{hints && <Kbd k="s" quiet />}</Button>
      </div>
    </div>
  );
} // MOCK-HOOK

function Split({ shown, focused, setFocus, may, p, openSheet, marks, onVerb }: { shown: IkItem[]; focused: string | null; setFocus: (id: string) => void; may: (i: IkItem) => boolean; p: P; openSheet: (id: string) => void; marks: Record<string, Verb>; onVerb: (i: IkItem, v: Verb) => void }) { // MOCK-HOOK
  const cur = shown.find((i) => i.id === focused) ?? shown[0];
  const n = shown.findIndex((i) => i.id === cur?.id);
  void marks;
  void p;
  return (
    <div className="mt-2 grid grid-cols-[minmax(0,42%)_1fr] border-t border-line max-[900px]:grid-cols-1">
      <ul className="max-h-[640px] overflow-y-auto border-r border-line max-[900px]:max-h-none max-[900px]:border-r-0" data-testid="ik-list">
        {shown.map((i) => (
          <li
            key={i.id}
            data-ik-row={i.id}
            onClick={() => (window.innerWidth <= 900 ? openSheet(i.id) : setFocus(i.id))}
            className={`flex cursor-pointer items-start gap-2.5 border-b border-line px-4 py-2.5 text-base ${i.id === cur?.id ? 'bg-accent-soft/50 shadow-[inset_3px_0_0_var(--color-accent)] max-[900px]:bg-transparent max-[900px]:shadow-none' : 'hover:bg-surface2'}`}
          >
            <span className="mt-0.5 text-text2"><Icon name={i.icon} /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm text-text2">{i.kind}</span>
              <ItemName i={i} />
            </span>
            <span className="text-sm text-text2 tnum">{i.age}</span>
          </li>
        ))}
      </ul>
      {cur && (
        <div className="max-[900px]:hidden">
          <div className="flex items-center gap-2 border-b border-line px-4 py-2 text-sm text-text2">
            <span className="tnum">{n + 1} of {shown.length}</span>
            <span className="ml-auto flex items-center gap-1">
              <Button variant="ghost" aria-label="Previous"><Icon name="chevron-up" /><Kbd k="k" quiet /></Button>
              <Button variant="ghost" aria-label="Next"><Icon name="chevron-down" /><Kbd k="j" quiet /></Button>
            </span>
          </div>
          <Pane i={cur} may={may(cur)} hints onVerb={(v) => onVerb(cur, v)} />
        </div>
      )}
    </div>
  );
} // MOCK-HOOK

function SnoozeFold({ list }: { list: { i: IkItem; s: Snz }[] }): ReactNode { // MOCK-HOOK
  const [open, setOpen] = useState(false);
  return (
    <section className="border-t border-line" data-testid="ik-snoozed-fold">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-base font-semibold text-text2 hover:bg-surface2">
        <Icon name="clock" />
        Snoozed <span className="tnum">{list.length}</span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} />
      </button>
      {open &&
        list.map(({ i, s }) => (
          <div key={i.id} className="flex items-center gap-3 border-t border-line px-4 py-2 text-base text-text2">
            <ItemName i={i} />
            <span className="ml-auto text-sm whitespace-nowrap">Back {s.until}</span>
          </div>
        ))}
    </section>
  );
} // MOCK-HOOK
