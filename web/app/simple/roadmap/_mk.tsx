"use client";
// MOCK-HOOK: this whole file is mock-up variants for the owner to pick from (mk-qa4-roadmap,
// decisions QR1..QR4); it is read only when the page's URL carries ?qr1= / ?qr2= / ?qr3= / ?qr4=.

import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"; // MOCK-HOOK
import { useSearchParams } from "next/navigation"; // MOCK-HOOK

import { FixButtons, type Act } from "./_card"; // MOCK-HOOK
import { addDays, broken, closedItem, daysBetween, ms, quarters, shortDay, spanWords, type Flag, type Item, type Roadmap } from "./_lib"; // MOCK-HOOK

export type MkOpts = { qr1: string; qr2: string; qr3: string; qr4: string; zoom: string; open: string | null }; // MOCK-HOOK

/** The URL switches: ?qr1=a|b|c|d &qr2=a|b|c|d &qr3=a|b|c|d &qr4=a|b|c, &zoom=6m|1y|all, &open=<item key>. */
export function useMk(): MkOpts | null { // MOCK-HOOK
  const p = useSearchParams(); // MOCK-HOOK
  if (!["qr1", "qr2", "qr3", "qr4"].some((k) => p.get(k))) return null; // MOCK-HOOK
  return { qr1: p.get("qr1") ?? "a", qr2: p.get("qr2") ?? "a", qr3: p.get("qr3") ?? "a", qr4: p.get("qr4") ?? "a", zoom: p.get("zoom") ?? "6m", open: p.get("open") }; // MOCK-HOOK
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]; // MOCK-HOOK
const monthWord = (day: string) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`; // MOCK-HOOK
const quarterWords = (q: { start: string; end: string }) => `${MONTHS[Number(q.start.slice(5, 7)) - 1]} – ${MONTHS[Number(q.end.slice(5, 7)) - 1]} ${q.start.slice(0, 4)}`; // MOCK-HOOK

type Row = { kind: "lane"; key: string; title: string; count: number } | { kind: "item"; item: Item }; // MOCK-HOOK

/** Items by goal (a lane per goal, then No goal, then Below the line), each item its own row. */
function rowsOf(data: Roadmap): Row[] { // MOCK-HOOK
  const lanes = new Map<string, { title: string; items: Item[] }>(); // MOCK-HOOK
  const below: Item[] = []; // MOCK-HOOK
  for (const i of data.items) { // MOCK-HOOK
    if (closedItem(i)) { below.push(i); continue; } // MOCK-HOOK
    const k = i.goal?.id ?? "none"; // MOCK-HOOK
    if (!lanes.has(k)) lanes.set(k, { title: i.goal?.title ?? "No goal", items: [] }); // MOCK-HOOK
    lanes.get(k)!.items.push(i); // MOCK-HOOK
  } // MOCK-HOOK
  const order = [...lanes.entries()].sort(([a], [b]) => (a === "none" ? 1 : b === "none" ? -1 : 0)); // MOCK-HOOK
  const out: Row[] = []; // MOCK-HOOK
  for (const [k, l] of order) { // MOCK-HOOK
    out.push({ kind: "lane", key: k, title: l.title, count: l.items.length }); // MOCK-HOOK
    for (const i of [...l.items].sort((a, b) => (a.start.date < b.start.date ? -1 : 1))) out.push({ kind: "item", item: i }); // MOCK-HOOK
  } // MOCK-HOOK
  if (below.length) { out.push({ kind: "lane", key: "below", title: "Below the line", count: below.length }); for (const i of below) out.push({ kind: "item", item: i }); } // MOCK-HOOK
  return out; // MOCK-HOOK
}

/** QR2: how a bar shows its state. "" is today's build (one red for a draft, a broken link, a cut item and Today). */
type Look = { bar: CSSProperties; name?: CSSProperties; chip?: string; mark?: string }; // MOCK-HOOK
function lookOf(i: Item, qr2: string): Look { // MOCK-HOOK
  const isBroken = broken(i).length > 0; // MOCK-HOOK
  const cut = closedItem(i); // MOCK-HOOK
  const hatch = "repeating-linear-gradient(45deg, var(--accent-soft) 0 3px, color-mix(in srgb, var(--accent) 35%, transparent) 3px 6px)"; // MOCK-HOOK
  const base: CSSProperties = { background: i.estimated ? hatch : "var(--accent-soft)", border: "1.5px solid var(--accent)" }; // MOCK-HOOK
  if (!qr2) { // MOCK-HOOK
    if (i.draft) return { bar: { background: "var(--surface)", border: "1.5px dashed var(--crit)" } }; // MOCK-HOOK
    if (cut) return { bar: { background: "var(--crit-bg)", border: "1.5px solid var(--crit)" }, name: { textDecoration: "line-through" } }; // MOCK-HOOK
    if (isBroken) return { bar: { ...base, border: "2px solid var(--crit)" } }; // MOCK-HOOK
    return { bar: base }; // MOCK-HOOK
  } // MOCK-HOOK
  if (qr2 === "c") { // MOCK-HOOK
    const chip = cut ? "Cut" : i.draft ? "Draft" : isBroken ? "Broken link" : undefined; // MOCK-HOOK
    return { bar: base, chip, name: cut ? { textDecoration: "line-through" } : undefined }; // MOCK-HOOK
  } // MOCK-HOOK
  let bar: CSSProperties = base; // MOCK-HOOK
  if (qr2 === "d") { // MOCK-HOOK
    bar = i.status === "in_progress" ? { background: "var(--pass-bg)", border: "1.5px solid var(--pass)" } : i.status === "done" ? { background: "var(--surface2)", border: "1.5px solid var(--line-strong)" } : base; // MOCK-HOOK
  } // MOCK-HOOK
  if (i.draft) return { bar: { background: "var(--surface)", border: "1.5px dashed var(--line-strong)" }, chip: "Draft" }; // MOCK-HOOK
  if (cut) return { bar: { background: "var(--surface2)", border: "1.5px solid var(--line)" }, name: { textDecoration: "line-through", color: "var(--text2)" } }; // MOCK-HOOK
  if (isBroken) return { bar: { ...bar, border: "2px solid var(--crit)" }, mark: "⚠" }; // MOCK-HOOK
  return { bar }; // MOCK-HOOK
}

const TODAY_COLOR = (qr2: string) => (!qr2 ? "var(--crit)" : qr2 === "c" ? "var(--text)" : "var(--mk-today)"); // MOCK-HOOK

/** QR2's key: a swatch drawn as the mark is, then short words; only the states on the chart. */
function Key({ data, qr2 }: { data: Roadmap; qr2: string }) { // MOCK-HOOK
  const has = (f: (i: Item) => boolean) => data.items.some(f); // MOCK-HOOK
  const sw = (s: CSSProperties) => <i aria-hidden className="inline-block h-3 w-7 flex-none rounded-sm" style={s} />; // MOCK-HOOK
  const e: [string, ReactNode, string][] = []; // MOCK-HOOK
  if (qr2 === "d") { // MOCK-HOOK
    e.push(["prog", sw({ background: "var(--pass-bg)", border: "1.5px solid var(--pass)" }), "In progress"]); // MOCK-HOOK
    e.push(["plan", sw({ background: "var(--accent-soft)", border: "1.5px solid var(--accent)" }), "Planned"]); // MOCK-HOOK
  } else e.push(["plan", sw({ background: "var(--accent-soft)", border: "1.5px solid var(--accent)" }), "Dated"]); // MOCK-HOOK
  if (has((i) => i.estimated)) e.push(["est", sw(lookOf({ ...data.items.find((i) => i.estimated)!, draft: false, flags: [], status: "planned" }, "a").bar), "Estimated"]); // MOCK-HOOK
  if (qr2 === "c") { // MOCK-HOOK
    e.push(["words", <span key="w" className="rounded-full bg-surface2 px-2 text-xs text-text2">Draft</span>, "A word on the row says a draft, a cut item or a broken link"]); // MOCK-HOOK
  } else { // MOCK-HOOK
    if (has((i) => i.draft)) e.push(["draft", sw({ background: "var(--surface)", border: "1.5px dashed var(--line-strong)" }), "Draft"]); // MOCK-HOOK
    if (has((i) => broken(i).length > 0)) e.push(["broken", sw({ background: "var(--accent-soft)", border: "2px solid var(--crit)" }), "⚠ Broken link (red is only this)"]); // MOCK-HOOK
    if (has(closedItem)) e.push(["cut", <span key="c" className="text-sm text-text2 line-through">Cut</span>, "Cut, below the line"]); // MOCK-HOOK
  } // MOCK-HOOK
  e.push(["today", <i key="t" aria-hidden className="inline-block h-3.5 w-0.5 flex-none" style={{ background: TODAY_COLOR(qr2) }} />, `Today ${shortDay(data.today)}`]); // MOCK-HOOK
  return ( // MOCK-HOOK
    <ul data-testid="mk-key" className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-text2"> {/* MOCK-HOOK */}
      {e.map(([k, s, w]) => <li key={k} className="flex items-center gap-2">{s}{w}</li>)} {/* MOCK-HOOK */}
    </ul> // MOCK-HOOK
  ); // MOCK-HOOK
}

export interface MkProps { // MOCK-HOOK
  data: Roadmap; // MOCK-HOOK
  opts: MkOpts; // MOCK-HOOK
  phone: boolean; // MOCK-HOOK
  act: Act; // MOCK-HOOK
  canChange: boolean; // MOCK-HOOK
  byId: Map<string, Item>; // MOCK-HOOK
  /** The real item card (FloatingCard), placed by `style`; `sheet`: a phone's bottom sheet. */
  card: (item: Item, style: CSSProperties, sheet: boolean, onClose: () => void) => ReactNode; // MOCK-HOOK
}

const LABEL_W = 232; // MOCK-HOOK
const ROW_H = 34; // MOCK-HOOK

export function MkTimeline(props: MkProps) { // MOCK-HOOK
  const { data, opts, phone } = props; // MOCK-HOOK
  const [openKey, setOpenKey] = useState<string | null>(opts.open); // MOCK-HOOK
  const [keyOpen, setKeyOpen] = useState(false); // MOCK-HOOK
  const openItem = openKey ? data.items.find((i) => i.key === openKey) ?? null : null; // MOCK-HOOK
  const qr1 = opts.qr1; // MOCK-HOOK
  const list = qr1 === "d" || (phone && qr1 === "a"); // MOCK-HOOK
  const side = opts.qr4 === "a" && !phone && !!openItem; // MOCK-HOOK
  const sideList = opts.qr3 === "d" && !phone; // MOCK-HOOK
  return ( // MOCK-HOOK
    <div data-testid="mk-timeline" className="mt-2" style={{ ["--mk-today" as string]: "#7c3aed" }}> {/* MOCK-HOOK */}
      <style>{`[data-theme="dark"] [data-testid="mk-timeline"]{--mk-today:#b69cff !important}`}</style> {/* MOCK-HOOK */}
      {opts.qr2 && opts.qr2 !== "b" && <div className="mb-2 rounded-lg border border-line bg-surface px-3 py-2"><Key data={data} qr2={opts.qr2} /></div>} {/* MOCK-HOOK */}
      {opts.qr2 === "b" && ( // MOCK-HOOK
        <div className="relative mb-2 flex justify-end"> {/* MOCK-HOOK */}
          <button type="button" data-testid="mk-key-button" aria-expanded={keyOpen} onClick={() => setKeyOpen(!keyOpen)} className="h-8 rounded-lg border border-line bg-surface px-3 text-sm font-semibold hover:bg-surface2">What the colours mean</button> {/* MOCK-HOOK */}
          {keyOpen && <div role="dialog" aria-label="What the colours mean" className="absolute top-9 right-0 z-30 w-[420px] max-w-[92vw] rounded-xl border border-line bg-surface p-3 shadow-tip"><Key data={data} qr2="a" /></div>} {/* MOCK-HOOK */}
        </div> // MOCK-HOOK
      )}
      {opts.qr3 === "a" && <ConflictPanel {...props} onShow={setOpenKey} />} {/* MOCK-HOOK */}
      <div className={sideList || side ? "flex items-start gap-3" : ""}> {/* MOCK-HOOK */}
        <div className="min-w-0 flex-1"> {/* MOCK-HOOK */}
          {list ? <QuarterList {...props} openKey={openKey} onOpen={setOpenKey} /> : qr1 === "b" ? <QuarterGrid {...props} openKey={openKey} onOpen={setOpenKey} /> : <DayChart {...props} openKey={openKey} onOpen={setOpenKey} />} {/* MOCK-HOOK */}
        </div> {/* MOCK-HOOK */}
        {sideList && !side && <ConflictPanel {...props} onShow={setOpenKey} rail />} {/* MOCK-HOOK */}
        {side && openItem && ( // MOCK-HOOK
          <aside data-testid="mk-side" className="sticky top-3 max-h-[calc(100dvh-24px)] w-[400px] flex-none overflow-y-auto rounded-xl border border-line bg-surface shadow-tip"> {/* MOCK-HOOK */}
            {props.card(openItem, { position: "relative", left: 0, top: 0, width: "100%", border: 0, boxShadow: "none" }, false, () => setOpenKey(null))} {/* MOCK-HOOK */}
          </aside> // MOCK-HOOK
        )}
      </div> {/* MOCK-HOOK */}
      {openItem && (phone ? opts.qr4 !== "b" : false) && props.card(openItem, {}, true, () => setOpenKey(null))} {/* MOCK-HOOK */}
    </div> // MOCK-HOOK
  ); // MOCK-HOOK
}

/** QR4 c: the card beside the bar's visible part; right when it fits, else left, else under the bar. */
function popPlace(bx: number, bw: number, visL: number, visR: number, rowH: number): CSSProperties { // MOCK-HOOK
  const end = Math.min(bx + bw, visR); // MOCK-HOOK
  if (end + 12 + 380 <= visR) return { left: end + 12, top: 0 }; // MOCK-HOOK
  const start = Math.max(bx, visL); // MOCK-HOOK
  if (start - 392 >= visL) return { left: start - 392, top: 0 }; // MOCK-HOOK
  return { left: Math.max(visL + 8, Math.min(start + 12, visR - 392)), top: rowH + 2 }; // MOCK-HOOK
}

type Inner = MkProps & { openKey: string | null; onOpen: (k: string | null) => void }; // MOCK-HOOK

/** QR3 a / d: the broken links in a panel of their own (a: above the chart; d: a rail beside it). */
function ConflictPanel({ data, act, canChange, byId, onShow, phone, rail = false }: MkProps & { onShow: (k: string) => void; rail?: boolean }) { // MOCK-HOOK
  const list = data.items.flatMap((i) => (closedItem(i) ? [] : broken(i).filter((f) => f.kind === "dependency_order").map((f) => ({ i, f })))); // MOCK-HOOK
  const [shut, setShut] = useState(false); // MOCK-HOOK
  if (!list.length) return <p data-testid="mk-conflicts" className="mb-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-text2">No broken links</p>; // MOCK-HOOK
  return ( // MOCK-HOOK
    <section data-testid="mk-conflicts" className={`rounded-xl border border-crit bg-surface ${rail ? "sticky top-3 w-[340px] flex-none" : "mb-2"}`}> {/* MOCK-HOOK */}
      <button type="button" aria-expanded={!shut} onClick={() => setShut(!shut)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-semibold text-crit"> {/* MOCK-HOOK */}
        ⚠ {list.length} broken {list.length === 1 ? "link" : "links"} <span className="ml-auto text-text2">{shut ? "Show" : "Hide"}</span> {/* MOCK-HOOK */}
      </button> {/* MOCK-HOOK */}
      {!shut && ( // MOCK-HOOK
        <ul className="divide-y divide-line border-t border-line"> {/* MOCK-HOOK */}
          {list.map(({ i, f }) => ( // MOCK-HOOK
            <li key={i.id} data-testid="mk-conflict" data-item={i.key} className={`flex gap-3 px-3 py-2 ${rail || phone ? "flex-col" : "flex-wrap items-center"}`}> {/* MOCK-HOOK */}
              <button type="button" onClick={() => onShow(i.key)} className="min-w-0 flex-1 text-left text-sm text-text hover:underline">{f.reason}</button> {/* MOCK-HOOK */}
              <div className="max-w-full min-w-0"><FixButtons item={i} flag={f} items={byId} act={act} canChange={canChange} inline={!(rail || phone)} /></div> {/* MOCK-HOOK */}
            </li> // MOCK-HOOK
          ))}
        </ul> // MOCK-HOOK
      )}
    </section> // MOCK-HOOK
  ); // MOCK-HOOK
}

/** QR3 b / c and today's build: the conflict shown at the item itself. */
function brokenFlag(i: Item): Flag | undefined { // MOCK-HOOK
  return closedItem(i) ? undefined : broken(i).find((f) => f.kind === "dependency_order"); // MOCK-HOOK
}

/** QR1 a (zoom around today) and c (names above bars, all three years at once): one row per item, days to scale. */
function DayChart(props: Inner) { // MOCK-HOOK
  const { data, opts, phone, openKey, onOpen } = props; // MOCK-HOOK
  const rows = useMemo(() => rowsOf(data), [data]); // MOCK-HOOK
  const fit = opts.qr1 === "c" || opts.zoom === "all"; // MOCK-HOOK
  const box = useRef<HTMLDivElement>(null); // MOCK-HOOK
  const [w, setW] = useState(1000); // MOCK-HOOK
  const [pop, setPop] = useState<string | null>(null); // MOCK-HOOK
  const [sl, setSl] = useState(0); // MOCK-HOOK
  useLayoutEffect(() => { // MOCK-HOOK
    const el = box.current; // MOCK-HOOK
    if (!el) return; // MOCK-HOOK
    const on = () => setW(el.clientWidth); // MOCK-HOOK
    on(); // MOCK-HOOK
    const ro = new ResizeObserver(on); // MOCK-HOOK
    ro.observe(el); // MOCK-HOOK
    return () => ro.disconnect(); // MOCK-HOOK
  }, []); // MOCK-HOOK
  const labelW = opts.qr1 === "c" ? 0 : phone ? 132 : LABEL_W; // MOCK-HOOK
  const days = data.items.flatMap((i) => [i.start.date, i.end.date]).concat(data.today).sort(); // MOCK-HOOK
  const t0 = addDays(days[0].slice(0, 8) + "01", 0); // MOCK-HOOK
  const t1 = addDays(days[days.length - 1], 20); // MOCK-HOOK
  const span = daysBetween(t0, t1); // MOCK-HOOK
  const visible = Math.max(200, w - labelW - 2); // MOCK-HOOK
  const windowDays = opts.zoom === "1y" ? 365 : 182; // MOCK-HOOK
  const ppd = fit ? visible / span : visible / windowDays; // MOCK-HOOK
  const trackW = Math.round(span * ppd); // MOCK-HOOK
  const x = (d: string) => daysBetween(t0, d) * ppd; // MOCK-HOOK
  const xt = x(data.today); // MOCK-HOOK
  useLayoutEffect(() => { // MOCK-HOOK
    if (box.current && !fit) box.current.scrollLeft = Math.max(0, xt - 60); // MOCK-HOOK
  }, [xt, fit, opts.zoom]); // MOCK-HOOK
  const months: { day: string; label: string }[] = []; // MOCK-HOOK
  for (let d = t0; d <= t1; ) { // MOCK-HOOK
    const m = Number(d.slice(5, 7)); // MOCK-HOOK
    const every = fit ? (phone ? 12 : 3) : 1; // MOCK-HOOK
    if ((m - 1) % every === 0) months.push({ day: d, label: m === 1 || months.length === 0 ? monthWord(d) : MONTHS[m - 1] }); // MOCK-HOOK
    const n = new Date(ms(d)); // MOCK-HOOK
    d = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 1)).toISOString().slice(0, 10); // MOCK-HOOK
  } // MOCK-HOOK
  const two = opts.qr1 === "c"; // MOCK-HOOK
  const rowH = two ? (phone ? 40 : 42) : ROW_H; // MOCK-HOOK
  const zooms: [string, string][] = [["6m", "6 months"], ["1y", "1 year"], ["all", "All 3 years"]]; // MOCK-HOOK
  const here = typeof window === "undefined" ? "" : window.location.search; // MOCK-HOOK
  const zoomHref = (z: string) => { const p = new URLSearchParams(here); p.set("zoom", z); return `?${p.toString()}`; }; // MOCK-HOOK
  return ( // MOCK-HOOK
    <div className="rounded-xl border border-line bg-surface"> {/* MOCK-HOOK */}
      {opts.qr1 === "a" && ( // MOCK-HOOK
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2"> {/* MOCK-HOOK */}
          <span className="text-sm text-text2">Show</span> {/* MOCK-HOOK */}
          <div role="group" aria-label="Show" className="inline-flex overflow-hidden rounded-lg border border-line"> {/* MOCK-HOOK */}
            {zooms.map(([z, words]) => <a key={z} href={zoomHref(z)} data-testid={`mk-zoom-${z}`} aria-pressed={opts.zoom === z} className={`px-3 py-1 text-sm font-semibold ${opts.zoom === z ? "bg-accent text-on-accent" : "hover:bg-surface2"}`}>{words}</a>)} {/* MOCK-HOOK */}
          </div> {/* MOCK-HOOK */}
          {!fit && <button type="button" onClick={() => box.current?.scrollTo({ left: Math.max(0, xt - 60), behavior: "smooth" })} className="h-8 rounded-lg border border-line px-3 text-sm font-semibold hover:bg-surface2">Back to today</button>} {/* MOCK-HOOK */}
          {!fit && <span className="ml-auto text-sm text-text2">Scroll sideways for earlier and later</span>} {/* MOCK-HOOK */}
        </div> // MOCK-HOOK
      )}
      <div ref={box} data-testid="mk-scroll" onScroll={(e) => setSl(e.currentTarget.scrollLeft)} className="relative overflow-x-auto"> {/* MOCK-HOOK */}
        <div className="relative" style={{ width: labelW + trackW }}> {/* MOCK-HOOK */}
          <div className="sticky top-0 z-20 flex h-8 border-b border-line bg-surface"> {/* MOCK-HOOK */}
            {labelW > 0 && <div className="sticky left-0 z-20 flex-none border-r border-line bg-surface" style={{ width: labelW }} />} {/* MOCK-HOOK */}
            <div className="relative" style={{ width: trackW }}> {/* MOCK-HOOK */}
              {months.map((m) => <span key={m.day} className="absolute top-2 text-xs whitespace-nowrap text-text2" style={{ left: x(m.day) + 4 }}>{m.label}</span>)} {/* MOCK-HOOK */}
            </div> {/* MOCK-HOOK */}
          </div> {/* MOCK-HOOK */}
          <div className="pointer-events-none absolute top-8 bottom-0 z-10" style={{ left: labelW + xt, width: 2, background: TODAY_COLOR(opts.qr2) }} data-testid="mk-today" /> {/* MOCK-HOOK */}
          <span className="absolute top-1 z-30 rounded-full px-2 text-xs leading-5 font-bold text-white" style={{ left: labelW + xt - 22, background: TODAY_COLOR(opts.qr2) }}>Today</span> {/* MOCK-HOOK */}
          {months.map((m) => <div key={m.day} aria-hidden className="absolute top-8 bottom-0 border-l border-line/60" style={{ left: labelW + x(m.day) }} />)} {/* MOCK-HOOK */}
          {rows.map((r) => { // MOCK-HOOK
            if (r.kind === "lane") return ( // MOCK-HOOK
              <div key={`l-${r.key}`} className="relative z-[11] flex h-8 items-end border-b border-line bg-surface2/70"> {/* MOCK-HOOK */}
                <div className="sticky left-0 px-3 pb-1 text-sm font-semibold whitespace-nowrap">{r.title} <span className="font-normal text-text2">· {r.count} {r.count === 1 ? "item" : "items"}</span></div> {/* MOCK-HOOK */}
              </div> // MOCK-HOOK
            ); // MOCK-HOOK
            const i = r.item; // MOCK-HOOK
            const lk = lookOf(i, opts.qr2); // MOCK-HOOK
            const f = brokenFlag(i); // MOCK-HOOK
            const bx = x(i.start.date); // MOCK-HOOK
            const bw = Math.max(8, x(addDays(i.end.date, 1)) - bx); // MOCK-HOOK
            const sel = openKey === i.key; // MOCK-HOOK
            const nameX = Math.max(0, Math.min(bx, trackW - 220)); // MOCK-HOOK
            const inline = opts.qr4 === "b" && sel; // MOCK-HOOK
            const popHere = opts.qr4 === "c" && sel && !phone; // MOCK-HOOK
            return ( // MOCK-HOOK
              <div key={i.id} data-testid="mk-row" data-item={i.key}> {/* MOCK-HOOK */}
                <div className={`relative flex border-b border-line/60 ${sel ? "bg-accent-soft/50" : ""}`} style={{ height: rowH }}> {/* MOCK-HOOK */}
                  {labelW > 0 && ( // MOCK-HOOK
                    <button type="button" onClick={() => { onOpen(sel ? null : i.key); if (!sel && (bx + bw < sl || bx > sl + visible)) box.current?.scrollTo({ left: Math.max(0, bx - 60) }); }} className={`sticky left-0 z-[12] flex flex-none items-center gap-1.5 border-r border-line px-3 text-left text-sm ${sel ? "bg-accent-soft" : "bg-surface"} hover:underline`} style={{ width: labelW }} title={i.title}> {/* MOCK-HOOK */}
                      <span className="min-w-0 truncate" style={lk.name}>{i.title}</span> {/* MOCK-HOOK */}
                      {lk.chip && <span className={`flex-none rounded-full px-1.5 text-[11px] ${lk.chip === "Broken link" ? "bg-crit-bg text-crit" : "bg-surface2 text-text2"}`}>{lk.chip}</span>} {/* MOCK-HOOK */}
                      {lk.mark && <span className="flex-none text-crit" aria-label="Broken link">⚠</span>} {/* MOCK-HOOK */}
                    </button> // MOCK-HOOK
                  )}
                  <div className="relative" style={{ width: trackW }}> {/* MOCK-HOOK */}
                    {two && <span className="absolute top-0.5 text-[13px] whitespace-nowrap" style={{ left: nameX, ...lk.name }}>{i.title}{lk.chip ? ` · ${lk.chip}` : ""}{lk.mark ? " ⚠" : ""}</span>} {/* MOCK-HOOK */}
                    <button type="button" data-bar-id={i.id} data-testid="mk-bar" aria-label={`${i.title}, ${spanWords(i.start.date, i.end.date, data.today)}`} onClick={() => onOpen(sel ? null : i.key)} className="absolute rounded-full" style={{ ...lk.bar, left: bx, width: bw, top: two ? 22 : 8, height: two ? 12 : 18, outline: sel ? "2px solid var(--accent-ink)" : undefined, outlineOffset: 2 }} /> {/* MOCK-HOOK */}
                    {!two && !fit && bx + bw - Math.max(bx, sl) > 120 && <span className="pointer-events-none absolute top-[9px] truncate px-2 text-xs leading-4 text-text2" style={{ left: Math.max(bx, sl), width: bx + bw - Math.max(bx, sl) }}>{spanWords(i.start.date, i.end.date, data.today)}</span>} {/* MOCK-HOOK */}
                    {f && opts.qr3 === "c" && ( // MOCK-HOOK
                      <button type="button" data-testid="mk-badge" aria-label="Broken link: show it" onClick={() => setPop(pop === i.key ? null : i.key)} className="absolute z-[13] grid h-5 w-5 place-items-center rounded-full bg-crit text-[11px] font-bold text-white" style={{ left: bx + bw + 6, top: two ? 18 : 7 }}>!</button> // MOCK-HOOK
                    )}
                    {f && opts.qr3 === "c" && pop === i.key && ( // MOCK-HOOK
                      <div role="dialog" aria-label="Broken link" className="absolute z-40 w-[420px] rounded-xl border border-crit bg-surface p-3 shadow-tip" style={{ left: Math.min(bx + bw + 6, trackW - 430), top: rowH }}> {/* MOCK-HOOK */}
                        <p className="mb-2 text-sm text-crit">⚠ {f.reason}</p> {/* MOCK-HOOK */}
                        <FixButtons item={i} flag={f} items={props.byId} act={props.act} canChange={props.canChange} inline /> {/* MOCK-HOOK */}
                      </div> // MOCK-HOOK
                    )}
                    {f && !opts.qr3 && ( // MOCK-HOOK
                      <div className="absolute z-[14] flex items-center gap-2 rounded-lg border border-crit bg-crit-bg px-2 py-0.5" style={{ left: bx + bw + 8, top: 3 }}> {/* MOCK-HOOK */}
                        <span className="max-w-[360px] truncate text-sm text-crit">⚠ {f.reason}</span> {/* MOCK-HOOK */}
                        <FixButtons item={i} flag={f} items={props.byId} act={props.act} canChange={props.canChange} inline /> {/* MOCK-HOOK */}
                      </div> // MOCK-HOOK
                    )}
                    {popHere && ( // MOCK-HOOK
                      <div data-testid="mk-pop" className="absolute z-40" style={popPlace(bx, bw, sl, sl + visible, rowH)}> {/* MOCK-HOOK */}
                        {props.card(i, { position: "relative", left: 0, top: 0 }, false, () => onOpen(null))} {/* MOCK-HOOK */}
                      </div> // MOCK-HOOK
                    )}
                  </div> {/* MOCK-HOOK */}
                </div> {/* MOCK-HOOK */}
                {f && opts.qr3 === "b" && ( // MOCK-HOOK
                  <div data-testid="mk-conflict" data-item={i.key} className="flex border-b border-line/60 bg-crit-bg"> {/* MOCK-HOOK */}
                    <div className="sticky left-0 flex flex-wrap items-center gap-2 px-3 py-1.5" style={{ width: Math.min(w - 4, labelW + trackW) }}> {/* MOCK-HOOK */}
                      <span className="text-sm text-crit">⚠ {f.reason}</span> {/* MOCK-HOOK */}
                      <FixButtons item={i} flag={f} items={props.byId} act={props.act} canChange={props.canChange} inline /> {/* MOCK-HOOK */}
                    </div> {/* MOCK-HOOK */}
                  </div> // MOCK-HOOK
                )}
                {inline && ( // MOCK-HOOK
                  <div data-testid="mk-inline" className="relative z-[15] border-b border-line bg-surface2 py-2"> {/* MOCK-HOOK */}
                    <div className="sticky left-0 px-3" style={{ width: Math.min(w - 4, 760) }}> {/* MOCK-HOOK */}
                      {props.card(i, { position: "relative", left: 0, top: 0, width: "100%" }, false, () => onOpen(null))} {/* MOCK-HOOK */}
                    </div> {/* MOCK-HOOK */}
                  </div> // MOCK-HOOK
                )}
              </div> // MOCK-HOOK
            ); // MOCK-HOOK
          })}
        </div> {/* MOCK-HOOK */}
      </div> {/* MOCK-HOOK */}
    </div> // MOCK-HOOK
  ); // MOCK-HOOK
}

/** QR1 b: quarters as columns; a lane per goal; each item a block over its quarters, its name inside. */
function QuarterGrid(props: Inner) { // MOCK-HOOK
  const { data, opts, phone, openKey, onOpen } = props; // MOCK-HOOK
  const live = data.items.filter((i) => !closedItem(i)); // MOCK-HOOK
  const days = data.items.flatMap((i) => [i.start.date, i.end.date]).concat(data.today).sort(); // MOCK-HOOK
  const qs = quarters(days[0], days[days.length - 1]); // MOCK-HOOK
  const colW = phone ? 168 : 236; // MOCK-HOOK
  const laneW = phone ? 96 : 168; // MOCK-HOOK
  const qi = (d: string) => qs.findIndex((q) => q.start <= d && d <= q.end); // MOCK-HOOK
  const box = useRef<HTMLDivElement>(null); // MOCK-HOOK
  useLayoutEffect(() => { if (box.current) box.current.scrollLeft = Math.max(0, qi(data.today) * colW); }, [colW]); // eslint-disable-line react-hooks/exhaustive-deps -- MOCK-HOOK
  const lanes = new Map<string, { title: string; items: Item[] }>(); // MOCK-HOOK
  for (const i of live) { const k = i.goal?.id ?? "none"; if (!lanes.has(k)) lanes.set(k, { title: i.goal?.title ?? "No goal", items: [] }); lanes.get(k)!.items.push(i); } // MOCK-HOOK
  const order = [...lanes.entries()].sort(([a], [b]) => (a === "none" ? 1 : b === "none" ? -1 : 0)); // MOCK-HOOK
  const tq = qi(data.today); // MOCK-HOOK
  return ( // MOCK-HOOK
    <div ref={box} data-testid="mk-scroll" className="overflow-x-auto rounded-xl border border-line bg-surface"> {/* MOCK-HOOK */}
      <div style={{ width: laneW + qs.length * colW }}> {/* MOCK-HOOK */}
        <div className="flex border-b border-line"> {/* MOCK-HOOK */}
          <div className="sticky left-0 z-10 flex-none border-r border-line bg-surface" style={{ width: laneW }} /> {/* MOCK-HOOK */}
          {qs.map((q, n) => ( // MOCK-HOOK
            <div key={q.start} className={`flex-none border-r border-line px-2 py-1.5 text-sm ${n === tq ? "bg-accent-soft/60" : ""}`} style={{ width: colW }}> {/* MOCK-HOOK */}
              <b>{q.label}</b> <span className="text-text2">{quarterWords(q)}</span> {/* MOCK-HOOK */}
              {n === tq && <span className="ml-1 rounded-full px-1.5 whitespace-nowrap text-[11px] font-bold text-white" style={{ background: TODAY_COLOR(opts.qr2) }}>Today {shortDay(data.today)}</span>} {/* MOCK-HOOK */}
            </div> // MOCK-HOOK
          ))}
        </div> {/* MOCK-HOOK */}
        {order.map(([k, l]) => { // MOCK-HOOK
          const rows: Item[][] = []; // MOCK-HOOK
          for (const i of [...l.items].sort((a, b) => (a.start.date < b.start.date ? -1 : 1))) { // MOCK-HOOK
            const s = qi(i.start.date); // MOCK-HOOK
            const row = rows.find((r) => qi(r[r.length - 1].end.date) < s); // MOCK-HOOK
            if (row) row.push(i); else rows.push([i]); // MOCK-HOOK
          } // MOCK-HOOK
          return ( // MOCK-HOOK
            <div key={k} className="flex border-b border-line"> {/* MOCK-HOOK */}
              <div className="sticky left-0 z-10 flex-none border-r border-line bg-surface px-3 py-2 text-sm font-semibold" style={{ width: laneW }}>{l.title}<div className="font-normal text-text2">{l.items.length} items</div></div> {/* MOCK-HOOK */}
              <div className="relative flex-1 py-1"> {/* MOCK-HOOK */}
                {qs.map((q, n) => <div key={q.start} aria-hidden className={`absolute top-0 bottom-0 border-r border-line/60 ${n === tq ? "bg-accent-soft/30" : ""}`} style={{ left: n * colW, width: colW }} />)} {/* MOCK-HOOK */}
                {rows.map((r, rn) => ( // MOCK-HOOK
                  <div key={rn} className="relative h-[54px]"> {/* MOCK-HOOK */}
                    {r.map((i) => { // MOCK-HOOK
                      const s = qi(i.start.date), e = qi(i.end.date); // MOCK-HOOK
                      const lk = lookOf(i, opts.qr2); // MOCK-HOOK
                      return ( // MOCK-HOOK
                        <button key={i.id} type="button" data-bar-id={i.id} data-testid="mk-bar" onClick={() => onOpen(openKey === i.key ? null : i.key)} className="absolute top-1 h-[46px] overflow-hidden rounded-lg px-2 text-left" style={{ ...lk.bar, left: s * colW + 4, width: (e - s + 1) * colW - 8, outline: openKey === i.key ? "2px solid var(--accent-ink)" : undefined }}> {/* MOCK-HOOK */}
                          <span className="block w-fit max-w-full truncate rounded bg-surface/85 px-1 text-sm font-semibold" style={lk.name}>{lk.mark ? "⚠ " : ""}{i.title}</span> {/* MOCK-HOOK */}
                          <span className="block w-fit max-w-full truncate rounded bg-surface/85 px-1 text-xs text-text2">{spanWords(i.start.date, i.end.date, data.today)}</span> {/* MOCK-HOOK */}
                        </button> // MOCK-HOOK
                      ); // MOCK-HOOK
                    })}
                  </div> // MOCK-HOOK
                ))}
              </div> {/* MOCK-HOOK */}
            </div> // MOCK-HOOK
          ); // MOCK-HOOK
        })}
      </div> {/* MOCK-HOOK */}
    </div> // MOCK-HOOK
  ); // MOCK-HOOK
}

/** QR1 d (and a's phone): a list by quarter; an item sits in the quarter it starts in. */
function QuarterList(props: Inner) { // MOCK-HOOK
  const { data, opts, phone, openKey, onOpen } = props; // MOCK-HOOK
  const days = data.items.flatMap((i) => [i.start.date, i.end.date]).concat(data.today).sort(); // MOCK-HOOK
  const qs = quarters(days[0], days[days.length - 1]); // MOCK-HOOK
  const tq = qs.find((q) => q.start <= data.today && data.today <= q.end); // MOCK-HOOK
  return ( // MOCK-HOOK
    <div data-testid="mk-list" className="space-y-3"> {/* MOCK-HOOK */}
      {qs.map((q) => { // MOCK-HOOK
        const items = data.items.filter((i) => q.start <= i.start.date && i.start.date <= q.end || (q === tq && i.start.date < q.start && i.end.date >= q.start)).sort((a, b) => (a.start.date < b.start.date ? -1 : 1)); // MOCK-HOOK
        if (!items.length) return null; // MOCK-HOOK
        return ( // MOCK-HOOK
          <section key={q.start} className="rounded-xl border border-line bg-surface"> {/* MOCK-HOOK */}
            <h3 className="flex items-center gap-2 border-b border-line px-3 py-2 text-sm font-semibold">{q.label} <span className="font-normal text-text2">{quarterWords(q)} · {items.length} items</span>{q === tq && <span className="rounded-full px-2 text-xs font-bold whitespace-nowrap text-white" style={{ background: TODAY_COLOR(opts.qr2) }}>Today {shortDay(data.today)}</span>}</h3> {/* MOCK-HOOK */}
            <ul className="divide-y divide-line/60"> {/* MOCK-HOOK */}
              {items.map((i) => { // MOCK-HOOK
                const lk = lookOf(i, opts.qr2); // MOCK-HOOK
                const sel = openKey === i.key; // MOCK-HOOK
                const f = brokenFlag(i); // MOCK-HOOK
                return ( // MOCK-HOOK
                  <li key={i.id}> {/* MOCK-HOOK */}
                    <button type="button" data-bar-id={i.id} data-testid="mk-bar" onClick={() => onOpen(sel ? null : i.key)} className={`flex w-full items-center gap-3 px-3 py-2 text-left ${sel ? "bg-accent-soft" : "hover:bg-surface2"}`}> {/* MOCK-HOOK */}
                      <i aria-hidden className="h-3 w-6 flex-none rounded-full" style={lk.bar} /> {/* MOCK-HOOK */}
                      <span className="min-w-0 flex-1"> {/* MOCK-HOOK */}
                        <span className="block text-sm font-semibold" style={lk.name}>{i.title}{lk.chip ? <span className="ml-2 rounded-full bg-surface2 px-1.5 text-[11px] font-normal text-text2">{lk.chip}</span> : null}</span> {/* MOCK-HOOK */}
                        <span className="block text-xs text-text2">{spanWords(i.start.date, i.end.date, data.today)}{i.goal ? ` · ${i.goal.title}` : ""}</span> {/* MOCK-HOOK */}
                        {f && (opts.qr3 === "a" || opts.qr3 === "d" ? <span className="block text-xs text-crit">⚠ Broken link</span> : <span className="block text-xs text-crit">⚠ {f.reason}</span>)} {/* MOCK-HOOK */}
                      </span> {/* MOCK-HOOK */}
                    </button> {/* MOCK-HOOK */}
                    {sel && opts.qr4 === "b" && <div className="px-3 pb-3">{props.card(i, { position: "relative", left: 0, top: 0, width: "100%" }, false, () => onOpen(null))}</div>} {/* MOCK-HOOK */}
                  </li> // MOCK-HOOK
                ); // MOCK-HOOK
              })}
            </ul> {/* MOCK-HOOK */}
          </section> // MOCK-HOOK
        ); // MOCK-HOOK
      })}
      {phone ? null : null} {/* MOCK-HOOK */}
    </div> // MOCK-HOOK
  ); // MOCK-HOOK
}
