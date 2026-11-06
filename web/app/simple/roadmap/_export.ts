/**
 * D20: the current roadmap view (its format and filters) as PNG and PDF, drawn in the
 * browser from what is on screen: the timeline, Gantt and waterfall from the labels column
 * and the chart's SVG, the board from its columns; framed with the company's branding (its
 * logo, name and accent, the public disclaimer) and a line naming the filters, with the
 * light theme's colours resolved (E-10: whatever the page's theme), onto a canvas. The PNG
 * is one picture (scaled down past a canvas's limits, E-7); the PDF is Letter landscape
 * pages, the picture cut into bands under its header and date axis repeated on each, a page
 * number in each footer (E-2).
 */
import { calendarDay, displayZone, zoneTime } from "@/lib/dates";

import type { BoardColumn } from "./_board";
import { brokenLinks, shortDay, spanWords } from "./_lib";
import { ordinal } from "./_timeline";

const SCALE = 2;
const HEAD = 88;
const FOOT = 34;

/** The company's branding as the export draws it (GET /v1/branding). */
export interface Brand {
  name: string;
  /** A data: URL (the app's CSP allows data: images). */
  logo: string | null;
  accent: string | null;
  disclaimer: string;
  mark: boolean;
}

export interface ExportHead {
  /** "Roadmap · Timeline". */
  title: string;
  /** The filters in words ("Grouped by goal · Goal: …"). */
  filters: string;
  brand: Brand | null;
}

/** SVG elements drawn from (0, 0), and their size. */
export interface Picture {
  body: string;
  width: number;
  height: number;
  /** E-2: the height of its header (the date axis and its marks), repeated on each PDF page. */
  head?: number;
  /** E-2: the width of its names column, repeated at the left of each PDF page across. */
  left?: number;
  /** E-2: the y of each row's top below the header, where a PDF page may end. */
  breaks?: number[];
  /** The date axis's words and days (in the picture's pixels): a PDF page's column that starts
   * mid-axis names its month and year at its left, never a label cut at its edge ("r 12"). */
  axis?: { days: { x: number; day: string }[]; words: { x0: number; x1: number; y: number; size: number }[] };
}

/** E-7: a view too large for one canvas, even scaled down. */
export class TooLarge extends Error {}

declare global {
  interface Window {
    /** A spec sets it to an array to read what each export drew (its header, size and key-date markers). */
    __poExports?: { kind: "png" | "pdf"; title: string; filters: string; brand: string | null; logo: boolean; width: number; height: number; keyDates: string[] }[];
  }
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

const SVG_NS = "http://www.w3.org/2000/svg";
const KEY_ROW = 20;
const KEY_COL = 280;

/** A bar's item name, from its spoken label ("<name>: Oct 1 to Nov 2, …"). */
function barName(g: Element): string {
  const said = g.getAttribute("aria-label") ?? "";
  const m = /^(.*?): (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d/.exec(said);
  return (m ? m[1] : said.split(": ")[0]).trim();
}

/** qa4-simple-roadmap-2: the timeline's pills too short for their names (a blank pill, or one
 * whose name is cut to "…") get a number in the copy, and the picture a key under the chart
 * naming each number, so every bar in the file says what it is. */
function numberShortBars(chart: SVGSVGElement): { name: string; n: number }[] {
  const bars = [...chart.querySelectorAll<SVGGElement>('g[data-testid="bar"][data-lane]')]
    .map((g) => {
      const body = g.querySelector("rect[data-body], rect[data-slice-body]");
      const y = Number(body?.getAttribute("y") ?? 0);
      const h = Number(body?.getAttribute("height") ?? 20);
      return { g, x: Number(g.dataset.x0 ?? body?.getAttribute("x") ?? 0), y, h };
    })
    .filter(({ g }) => {
      const words = [...g.querySelectorAll('[data-testid="bar-label"], [data-testid="slice-label"]')].map((t) => (t.textContent ?? "").trim());
      return !words.some((w) => w && !w.endsWith("…"));
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);
  return bars.map(({ g, x, y, h }, k) => {
    const n = k + 1;
    // The cut name gives way to the number (the whole name is in the key).
    g.querySelectorAll('[data-testid="bar-label"], [data-testid="slice-label"]').forEach((t) => t.remove());
    const badge = document.createElementNS(SVG_NS, "g");
    badge.setAttribute("data-export-key", String(n));
    badge.innerHTML =
      `<circle cx="${x + 9}" cy="${y + h / 2}" r="8" fill="var(--surface)" stroke="var(--text)" stroke-width="1"/>` +
      `<text x="${x + 9}" y="${y + h / 2 + 3.5}" font-size="10" font-weight="700" text-anchor="middle" fill="var(--text)">${n}</text>`;
    g.append(badge);
    return { name: barName(g), n };
  });
}

/** An estimate of a text's width in the export's sans-serif type (a canvas measures it). */
let ruler: CanvasRenderingContext2D | null | undefined;
function widthOf(s: string, size: number, weight = 400): number {
  if (ruler === undefined) ruler = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  if (!ruler) return s.length * size * 0.6;
  ruler.font = `${weight} ${size}px sans-serif`;
  return Math.ceil(ruler.measureText(s).width) + 1;
}

/** `s` whole when it fits `room` pixels, else cut with "…". */
function fit(s: string, room: number, size: number, weight = 400): string {
  if (widthOf(s, size, weight) <= room) return s;
  let n = s.length - 1;
  while (n > 1 && widthOf(`${s.slice(0, n).trimEnd()}…`, size, weight) > room) n--;
  return n > 1 ? `${s.slice(0, n).trimEnd()}…` : "";
}

/** R1: the chart's quarter labels as the chart itself places them (data-whole*), never as a
 * phone's scroll window moved or shortened them: the copy shows the whole chart. */
function wholeAxis(chart: SVGSVGElement) {
  chart.querySelectorAll<SVGTextElement>("text[data-whole]").forEach((t) => {
    t.textContent = t.getAttribute("data-whole");
    t.setAttribute("x", t.getAttribute("data-whole-x") ?? t.getAttribute("x") ?? "0");
    t.setAttribute("text-anchor", t.getAttribute("data-whole-anchor") ?? "start");
    t.setAttribute("data-testid", "axis-tick");
  });
}

/** E-5: a label row's words, every line of it: its name first, then its notes ("In-app tour ·
 * 1st to return"); a Current-state pill is not part of them. */
function rowWords(el: HTMLElement): string {
  const pills = [...el.querySelectorAll<HTMLElement>('[data-testid="cs-mark"]')].map((p) => p.innerText.trim());
  const title = el.querySelector<HTMLElement>('[data-testid="label-title"]')?.innerText.trim();
  const lines = el.innerText
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !pills.includes(s) && s !== title);
  return [...(title ? [title] : []), ...lines].join(" · ");
}

/** The labels (as text) and a copy of the chart's SVG beside them, with a key to the
 * numbered short bars under it. */
export function chartPicture(svg: SVGSVGElement, labels: HTMLElement | null): Picture {
  const lanes = labels ? [...labels.children].filter((el) => (el as HTMLElement).dataset.testid === "chart-group") : [];
  // A goal lane's words (its name, its metric) are never cut: the names column widens to the
  // longest (a phone's is narrow), to a limit past which only the metric is cut.
  const longest = Math.max(0, ...lanes.map((el) => widthOf(rowWords(el as HTMLElement), 13) + 16));
  const labelW = Math.max(labels?.offsetWidth ?? 0, Math.min(LANE_NAME_MAX, longest));
  const chart = svg.cloneNode(true) as SVGSVGElement;
  chart.setAttribute("x", String(labelW));
  chart.setAttribute("y", "0");
  wholeAxis(chart);
  const rows: string[] = [];
  const breaks: number[] = [];
  const head = Number(svg.getAttribute("data-head") ?? 0) || 0;
  if (labels) {
    const top = labels.getBoundingClientRect().top;
    for (const el of labels.children) {
      const r = (el as HTMLElement).getBoundingClientRect();
      const y = r.top - top;
      if (y >= head - 0.5) breaks.push(y);
      const words = rowWords(el as HTMLElement);
      if (!words) continue;
      const lane = (el as HTMLElement).dataset.testid === "chart-group" ? ' data-testid="export-lane"' : "";
      // Two lines where one cannot hold them and the row has room: the name, then its notes.
      const [first, ...rest] = words.split(" · ");
      if (widthOf(words, 13) > labelW - 14 && rest.length && r.height >= 32) {
        rows.push(`<text${lane} x="10" y="${y + r.height / 2 - 2}" font-size="13" fill="var(--text)">${esc(fit(first, labelW - 14, 13))}</text>`);
        rows.push(`<text x="10" y="${y + r.height / 2 + 12}" font-size="11" fill="var(--text2)">${esc(fit(rest.join(" · "), labelW - 14, 11))}</text>`);
      } else {
        // One line: smaller type before a word of it is lost.
        const size = widthOf(words, 13) <= labelW - 14 ? 13 : 11;
        rows.push(`<text${lane} x="10" y="${y + r.height / 2 + (size === 13 ? 5 : 4)}" font-size="${size}" fill="var(--text)">${esc(fit(words, labelW - 14, size) || cut(words, 34))}</text>`);
      }
    }
  }
  const width = labelW + svg.width.baseVal.value;
  const chartH = svg.height.baseVal.value;
  const keyed = numberShortBars(chart);
  const perRow = Math.max(1, Math.floor(width / KEY_COL));
  const key = keyed.map(({ name, n }, k) => {
    const x = (k % perRow) * KEY_COL + 10;
    const y = chartH + 22 + Math.floor(k / perRow) * KEY_ROW;
    return (
      `<circle cx="${x + 8}" cy="${y - 4}" r="8" fill="var(--surface)" stroke="var(--text)" stroke-width="1"/>` +
      `<text x="${x + 8}" y="${y - 0.5}" font-size="10" font-weight="700" text-anchor="middle" fill="var(--text)">${n}</text>` +
      `<text data-export-key="${n}" x="${x + 22}" y="${y}" font-size="12" fill="var(--text)">${esc(cut(name, 40))}</text>`
    );
  });
  const keyH = keyed.length ? 14 + Math.ceil(keyed.length / perRow) * KEY_ROW : 0;
  for (let k = 0; k < Math.ceil(keyed.length / perRow); k++) breaks.push(chartH + 8 + k * KEY_ROW);
  return { body: rows.join("") + new XMLSerializer().serializeToString(chart) + key.join(""), width, height: chartH + keyH, head, breaks, left: labelW, axis: axisOf(chart, labelW) };
}

/** The copied chart's axis: each tick's day and x, and each of its words' extent. */
function axisOf(chart: SVGSVGElement, dx: number): Picture["axis"] {
  const axis = chart.querySelector('[data-testid="chart-axis"]');
  if (!axis) return undefined;
  const days = [...axis.querySelectorAll<SVGGElement>("g[data-day]")].map((g) => ({ x: dx + Number(g.querySelector("line")?.getAttribute("x1") ?? 0), day: g.dataset.day ?? "" }));
  const words = [...axis.querySelectorAll<SVGTextElement>("text")].map((t) => {
    const size = Number(t.getAttribute("font-size") ?? 11);
    const w = widthOf(t.textContent ?? "", size, Number(t.getAttribute("font-weight") ?? 400));
    const x = dx + Number(t.getAttribute("x") ?? 0);
    return t.getAttribute("text-anchor") === "end" ? { x0: x - w, x1: x, y: Number(t.getAttribute("y") ?? 0), size } : { x0: x, x1: x + w, y: Number(t.getAttribute("y") ?? 0), size };
  });
  return { days, words };
}

/** The widest a names column grows to keep a goal lane's name whole. */
const LANE_NAME_MAX = 360;

const MONTH_WORDS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const px = (v: string) => Number.parseFloat(v) || 0;

/** E-1: the Timeline as the page shows it (its zoom, the window scrolled into view, its
 * month and week header): the names column, each goal's lane by name, each item's bar with
 * its dates beside it (right of the bar, or left of it where the right has no room), the
 * milestones with their days and Today in rows above the chart, their lines under it. */
export function zoomPicture(scroll: HTMLElement, today: string): Picture {
  const inner = scroll.firstElementChild as HTMLElement;
  const labelW = scroll.querySelector<HTMLElement>('[data-testid="timeline-names-head"]')?.offsetWidth ?? 232;
  const sl = scroll.scrollLeft;
  const width = Math.max(labelW + 200, scroll.clientWidth);
  // The page's x (inside the chart's content) as the picture's: the names column stays put.
  const X = (left: number) => left - sl;
  const seen = (x: number) => x >= labelW - 0.5 && x <= width + 0.5;
  const parts: string[] = [];
  const lines: string[] = [];

  // The months (the first in sight, and each January, with its year) and the 3 months' weeks.
  const MONTH_Y = 18;
  const monthLines = [...inner.querySelectorAll<HTMLElement>('[data-testid="timeline-month-line"]')].map((el) => ({ day: el.dataset.day ?? "", x: X(px(el.style.left)) }));
  const shown = monthLines.filter((m) => seen(m.x));
  const before = monthLines.filter((m) => m.x < labelW).at(-1);
  const heads: { day: string; x: number }[] = [];
  // The month the view starts in names itself at its left edge while there is room before the next.
  if (before && (!shown.length || shown[0].x - labelW > 70)) heads.push({ day: before.day, x: labelW });
  heads.push(...shown);
  const used: [number, number][] = [];
  heads.forEach((m, n) => {
    const mo = Number(m.day.slice(5, 7));
    const words = n === 0 || mo === 1 ? `${MONTH_WORDS[mo - 1]} ${m.day.slice(0, 4)}` : MONTH_WORDS[mo - 1];
    const w = widthOf(words, 12, 600);
    if (m.x + 4 + w > width - 2) return;
    used.push([m.x, m.x + 8 + w]);
    parts.push(`<text data-testid="export-month" x="${m.x + 4}" y="${MONTH_Y}" font-size="12" font-weight="600" fill="var(--text2)">${esc(words)}</text>`);
  });
  for (const m of shown) lines.push(`<line x1="${m.x}" x2="${m.x}" y1="0" y2="@H" stroke="var(--line)"/>`);
  let lastMonth = "";
  for (const el of inner.querySelectorAll<HTMLElement>('[data-testid="timeline-week-line"]')) {
    const day = el.dataset.day ?? "";
    const x = X(px(el.style.left));
    if (!seen(x)) continue;
    lines.push(`<line x1="${x}" x2="${x}" y1="@T" y2="@H" stroke="var(--line)" stroke-dasharray="3 3" opacity="0.6"/>`);
    const words = day.slice(0, 7) === lastMonth ? String(Number(day.slice(8, 10))) : shortDay(day);
    const w = widthOf(words, 11);
    if (x + 4 + w > width - 2 || used.some(([a, b]) => x + 4 + w > a - 4 && x < b)) continue;
    used.push([x, x + 8 + w]);
    lastMonth = day.slice(0, 7);
    parts.push(`<text data-testid="export-week" x="${x + 4}" y="${MONTH_Y}" font-size="11" fill="var(--text2)">${esc(words)}</text>`);
  }

  // The milestones (each with its day) and Today, in rows under the months, each clear of the one before.
  const ROW0 = 28;
  const MS_ROW = 20;
  type Flag = { x: number; words: string; today?: boolean; name?: string };
  const flags: Flag[] = [];
  const todayEl = inner.querySelector<HTMLElement>('[data-testid="today-line"]');
  const tx = todayEl ? X(px(todayEl.style.left)) : -1;
  if (todayEl && seen(tx)) flags.push({ x: tx, words: "Today", today: true });
  for (const el of inner.querySelectorAll<HTMLElement>('[data-testid="timeline-milestone-line"]')) {
    const day = el.dataset.day ?? "";
    const x = X(px(el.style.left));
    if (!day || !seen(x)) continue;
    const said = el.getAttribute("aria-label") ?? "";
    const full = calendarDay(day, { month: "short", day: "numeric", year: "numeric" });
    const name = said.includes(`, ${full}`) ? said.slice(0, said.indexOf(`, ${full}`)) : said;
    flags.push({ x, words: `${name} · ${shortDay(day)}`, name });
    lines.push(`<line x1="${x}" x2="${x}" y1="@T" y2="@H" stroke="var(--text2)" stroke-width="1.5" stroke-dasharray="4 3"/>`);
  }
  flags.sort((a, b) => a.x - b.x);
  const ends: number[] = [];
  for (const f of flags) {
    const size = f.today ? 11 : 12;
    let words = f.words;
    // A milestone's diamond is drawn (not a glyph a font may lack), 10 px before its words.
    const lead = f.today ? 0 : 12;
    let w = widthOf(words, size, f.today ? 700 : 400) + 12 + lead;
    // After its line, or ending at it where the chart's right edge is near; cut to the room left.
    let left = f.x + 2;
    if (left + w > width - 2) left = Math.max(labelW + 2, f.x - w - 2);
    if (left + w > width - 2) {
      words = fit(words, width - 2 - left - 12 - lead, size);
      w = widthOf(words, size) + 12 + lead;
    }
    let row = ends.findIndex((e) => e + 6 <= left);
    if (row < 0) row = ends.push(-Infinity) - 1;
    ends[row] = left + w;
    const y = ROW0 + row * MS_ROW;
    parts.push(
      f.today
        ? `<g data-testid="export-today-pill"><rect x="${left}" y="${y}" width="${w}" height="16" rx="8" fill="var(--today)"/><text x="${left + 6}" y="${y + 12}" font-size="11" font-weight="700" fill="#ffffff">Today</text></g>`
        : `<g data-testid="key-date-marker" data-name="${esc(f.name ?? "")}"><rect x="${left}" y="${y}" width="${w}" height="16" rx="8" fill="var(--surface)" stroke="var(--line)"/><rect x="${left + 7}" y="${y + 4.5}" width="7" height="7" fill="var(--text)" transform="rotate(45 ${left + 10.5} ${y + 8})"/><text data-testid="export-milestone" x="${left + 6 + lead}" y="${y + 12}" font-size="12" fill="var(--text)">${esc(words)}</text></g>`,
    );
  }
  const head = ROW0 + Math.max(1, ends.length) * MS_ROW + 6;

  // The lanes and rows, in the page's order.
  const rows: string[] = [];
  const breaks: number[] = [];
  let y = head;
  for (const el of inner.querySelectorAll<HTMLElement>('[data-testid="timeline-lane"], [data-testid="timeline-row"]')) {
    breaks.push(y);
    if (el.dataset.testid === "timeline-lane") {
      const h = el.offsetHeight || 32;
      const words = (el.firstElementChild?.textContent ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
      rows.push(`<rect x="0" y="${y}" width="${width}" height="${h}" fill="var(--surface2)"/><line x1="0" x2="${width}" y1="${y + h}" y2="${y + h}" stroke="var(--line)"/>`);
      rows.push(`<text data-testid="export-lane" x="12" y="${y + h - 10}" font-size="13" font-weight="600" fill="var(--text)">${esc(fit(words, width - 24, 13, 600))}</text>`);
      y += h;
      continue;
    }
    const h = el.offsetHeight || 34;
    const name = el.querySelector<HTMLElement>("button[title]");
    const title = name?.getAttribute("title") ?? "";
    const chip = el.querySelector('[data-testid="draft-tag"]')?.textContent ?? "";
    const warn = el.querySelector('[aria-label="Broken link"]') ? " ⚠" : "";
    const closed = name?.querySelector<HTMLElement>("span")?.style.textDecoration.includes("line-through");
    const bar = el.querySelector<HTMLElement>('[data-testid="timeline-bar"]');
    const out: string[] = [`<g data-testid="export-row">`];
    out.push(`<line x1="0" x2="${width}" y1="${y + h}" y2="${y + h}" stroke="var(--line)" opacity="0.6"/>`);
    if (bar) {
      const x0 = labelW + px(bar.style.left) - sl;
      const x1 = x0 + px(bar.style.width);
      const bg = bar.style.background || bar.style.backgroundColor || "var(--accent-soft)";
      const border = /^([\d.]+)px (solid|dashed) (.+)$/.exec(bar.style.border ?? "");
      const fill = bg.includes("gradient") ? "url(#export-hatch)" : bg;
      const stroke = border ? ` stroke="${esc(border[3])}" stroke-width="${border[1]}"${border[2] === "dashed" ? ' stroke-dasharray="5 3"' : ""}` : "";
      const a = Math.max(x0, labelW);
      const b = Math.min(x1, width);
      const words = spanWords(bar.dataset.start ?? "", bar.dataset.end ?? "", today);
      const ww = widthOf(words, 11) + 8;
      if (b > a) out.push(`<rect data-testid="export-bar" x="${a}" y="${y + 8}" width="${b - a}" height="18" rx="9" fill="${esc(fill)}"${stroke}/>`);
      // The dates beside the bar: after its end, or before its start where the right has no room;
      // over a bar wider than the view (no side in sight), on it.
      let at: number | null = null;
      let anchor = "start";
      let place = "after";
      if (x1 + 6 + ww <= width - 2) at = Math.max(x1 + 6, labelW + 4);
      else if (x0 - 6 - ww >= labelW + 2) [at, anchor, place] = [x0 - 6, "end", "before"];
      else if (b - a >= ww + 8) [at, place] = [a + 6, "inside"];
      // A bar wholly out of the window says where it lies, at that edge.
      const off = b <= a ? (x1 <= labelW ? "Earlier: " : "Later: ") : "";
      if (off) {
        const ow = widthOf(off + words, 11) + 8;
        [at, anchor, place] = off === "Earlier: " ? [labelW + 8, "start", "earlier"] : [width - 8, "end", "later"];
        out.push(`<rect x="${anchor === "end" ? at - ow + 4 : at - 4}" y="${y + 9}" width="${ow}" height="16" rx="8" fill="var(--surface)" stroke="var(--line)"/>`);
        out.push(`<text data-testid="export-bar-words" data-place="${place}" x="${at}" y="${y + 21}" font-size="11" text-anchor="${anchor}" fill="var(--text2)">${esc(off + words)}</text>`);
        at = null;
      }
      if (at !== null) {
        const bx = anchor === "end" ? at - ww + 4 : at - 4;
        out.push(`<rect x="${bx}" y="${y + 9}" width="${ww}" height="16" rx="3" fill="var(--surface)"${place === "inside" ? ' opacity="0.9"' : ""}/>`);
        out.push(`<text data-testid="export-bar-words" data-place="${place}" x="${at}" y="${y + 21}" font-size="11" text-anchor="${anchor}" fill="var(--text)">${esc(words)}</text>`);
      }
    }
    // The names column, over the chart's lines.
    out.push(`<rect x="0" y="${y}" width="${labelW}" height="${h}" fill="var(--surface)"/><line x1="${labelW}" x2="${labelW}" y1="${y}" y2="${y + h}" stroke="var(--line)"/>`);
    const tail = `${chip ? ` · ${chip}` : ""}${warn}`;
    out.push(`<text x="12" y="${y + h / 2 + 4.5}" font-size="13" fill="${closed ? "var(--text2)" : "var(--text)"}"${closed ? ' text-decoration="line-through"' : ""}>${esc(fit(title, labelW - 24 - widthOf(tail, 13), 13) + tail)}</text>`);
    out.push("</g>");
    rows.push(out.join(""));
    y += h;
  }
  const height = y;
  const T = head;
  const hatch =
    '<defs><pattern id="export-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="var(--accent-soft)"/><line x1="0" y1="0" x2="0" y2="6" stroke="var(--accent-mid)" stroke-width="3"/></pattern></defs>';
  const grid = lines.join("").replace(/@H/g, String(height)).replace(/@T/g, String(T));
  const todayLine = todayEl && seen(tx) ? `<line data-testid="export-today" x1="${tx}" x2="${tx}" y1="${T}" y2="${height}" stroke="var(--today)" stroke-width="2"/>` : "";
  const frame = `<rect x="0" y="0" width="${width}" height="${head}" fill="var(--surface)"/><line x1="0" x2="${width}" y1="${head}" y2="${head}" stroke="var(--line)"/><rect x="0" y="0" width="${labelW}" height="${head}" fill="var(--surface)"/><line x1="${labelW}" x2="${labelW}" y1="0" y2="${height}" stroke="var(--line)"/>`;
  // Lines under the rows' words (each on its own white), the header's words over all.
  return { body: hatch + frame + grid + todayLine + rows.join("") + parts.join(""), width, height, head, breaks, left: labelW };
}

/** The board's columns, each group and card as boxes and text; a cut card says its place in the
 * return queue (`queue`: the cut items' ids in the queue's order), as the Gantt's row does. */
export function boardPicture(cols: BoardColumn[], today: string, queue: string[] = []): Picture {
  const colW = 300;
  const gap = 12;
  const out: string[] = [];
  let height = 0;
  cols.forEach((c, n) => {
    const x = n * (colW + gap);
    const parts: string[] = [];
    let y = 34;
    parts.push(`<text x="${x + 10}" y="22" font-size="16" font-weight="600" fill="var(--text)">${esc(c.label)}</text>`);
    parts.push(`<text x="${x + colW - 10}" y="22" font-size="12" text-anchor="end" fill="var(--text2)">${esc(spanWords(c.window.start, c.window.end, today, true))}</text>`);
    const cardOf = (i: BoardColumn["below"][number]) => {
      const est = i.estimated && !i.draft;
      // fix4 qa-simple-roadmap-7: as the board draws it, only a broken link is red.
      const red = brokenLinks(i).length > 0;
      const fill = i.status === "cut" ? "var(--na-bg)" : est ? "url(#export-hatch)" : "var(--surface)";
      const stroke = red ? "var(--crit)" : "var(--line)";
      parts.push(`<rect x="${x + 8}" y="${y}" width="${colW - 16}" height="44" rx="8" fill="${fill}" stroke="${stroke}"${i.draft ? ' stroke-dasharray="5 3"' : ""}/>`);
      parts.push(`<text x="${x + 16}" y="${y + 18}" font-size="13" font-weight="500" fill="var(--text)"${i.status === "cut" ? ' text-decoration="line-through"' : ""}>${esc(fit(i.title, colW - 32, 13, 500))}</text>`);
      const place = queue.indexOf(i.id);
      const meta = `${spanWords(i.start.date, i.end.date, today, true)}${est ? " · estimated" : ""}${i.draft ? " · draft" : ""}${place >= 0 ? ` · ${ordinal(place + 1)} to return` : ""}`;
      parts.push(`<text x="${x + 16}" y="${y + 35}" font-size="11" fill="var(--text2)">${esc(meta)}</text>`);
      y += 50;
    };
    for (const g of c.groups) {
      parts.push(`<text x="${x + 10}" y="${y + 13}" font-size="12" font-weight="600" fill="var(--text2)">${esc(cut(g.title, 40))}</text>`);
      y += 20;
      g.items.forEach(cardOf);
      y += 6;
    }
    if (c.below.length) {
      parts.push(`<text x="${x + 10}" y="${y + 13}" font-size="12" font-weight="600" fill="var(--text2)">Below the line</text>`);
      y += 20;
      c.below.forEach(cardOf);
    }
    y += 6;
    height = Math.max(height, y);
    out.push(parts.join(""));
  });
  const width = cols.length * colW + (cols.length - 1) * gap;
  const columns = cols.map((_, n) => `<rect x="${n * (colW + gap)}" y="0" width="${colW}" height="${height}" rx="12" fill="var(--surface2)" stroke="var(--line)"/>`).join("");
  const hatch =
    '<defs><pattern id="export-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="8" fill="var(--accent-soft)"/><line x1="0" y1="0" x2="0" y2="8" stroke="var(--accent-mid)" stroke-width="4"/></pattern></defs>';
  return { body: hatch + columns + out.join(""), width, height };
}

/** E-10: every `var(--name)` in the markup as the light theme sets it, whatever theme the
 * page is in: the theme is set to light for the read (no paint happens in between) and put
 * back. Read on the Simple pages' root, where Simple's own tokens are set. */
function lightColours(markup: string): string {
  const root = document.documentElement;
  const names = [...new Set([...markup.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]))];
  const was = root.getAttribute("data-theme");
  root.setAttribute("data-theme", "light");
  const style = getComputedStyle(document.querySelector('[data-mode="simple"]') ?? root);
  const values = new Map(names.map((n) => [n, style.getPropertyValue(n).trim()]));
  if (was === null) root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", was);
  return markup.replace(/var\((--[a-z0-9-]+)\)/g, (_, name: string) => values.get(name) || "#000");
}

const stamp = (today: string, b: Brand | null) => `${calendarDay(today, { month: "short", day: "numeric", year: "numeric" })}, ${zoneTime(new Date().toISOString(), displayZone())}${b?.mark ? " · Made with Product Oracle" : ""}`;

/** One standalone SVG: the branded header (logo, company, title, filters), the picture and
 * the footer (the public disclaimer, the day and time it was made, Oracle's mark), in the
 * light theme's colours. The day is the company's (data.today); the time is in its zone ("Oct
 * 30, 2026, 2:49 PM PDT"). */
export function framed(pic: Picture, head: ExportHead, today: string): { markup: string; width: number; height: number } {
  const pad = 16;
  const width = Math.max(pic.width + 2 * pad, 640);
  const height = HEAD + pic.height + FOOT + pad;
  const b = head.brand;
  const accent = b?.accent ?? "var(--accent)";
  const textX = b?.logo ? pad + 132 : pad;
  const markup =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="sans-serif">` +
    `<rect width="100%" height="100%" fill="var(--surface)"/>` +
    `<rect width="100%" height="5" fill="${esc(accent)}"/>` +
    (b?.logo ? `<image href="${esc(b.logo)}" x="${pad}" y="16" width="120" height="34" preserveAspectRatio="xMinYMid meet"/>` : "") +
    `<text x="${textX}" y="32" font-size="13" font-weight="600" fill="var(--text2)">${esc(b?.name ?? "")}</text>` +
    `<text x="${textX}" y="54" font-size="18" font-weight="700" fill="var(--text)">${esc(head.title)}</text>` +
    `<text x="${pad}" y="76" font-size="12" fill="var(--text2)">${esc(cut(head.filters, 140))}</text>` +
    `<g transform="translate(${pad}, ${HEAD})">${pic.body}</g>` +
    `<line x1="${pad}" x2="${width - pad}" y1="${height - FOOT}" y2="${height - FOOT}" stroke="var(--line)"/>` +
    // The disclaimer ends short of the day and time at the right.
    `<text x="${pad}" y="${height - 13}" font-size="11" fill="var(--text2)">${esc(fit(b?.disclaimer ?? "", width - 2 * pad - widthOf(stamp(today, b), 11) - 16, 11))}</text>` +
    `<text x="${width - pad}" y="${height - 13}" font-size="11" text-anchor="end" fill="var(--text2)">${esc(stamp(today, b))}</text>` +
    `</svg>`;
  return { markup: lightColours(markup), width, height };
}

/** E-7: the most a canvas holds (a side, and pixels in all). */
const MAX_SIDE = 16_000;
const MAX_AREA = 268_000_000;
/** Past this the picture is too small to read: a filter or the PDF's pages, then. */
const MIN_SCALE = 0.5;

async function imageOf(markup: string): Promise<HTMLImageElement> {
  // A data: URL: the app's CSP allows data: images (not blob:).
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  const img = new Image();
  await new Promise<void>((ok, fail) => {
    img.onload = () => ok();
    img.onerror = () => fail(new Error("The view could not be drawn"));
    img.src = url;
  });
  return img;
}

/** The page as one canvas, at twice its size, or smaller where a canvas cannot hold that. */
async function canvasOf({ markup, width, height }: { markup: string; width: number; height: number }): Promise<HTMLCanvasElement> {
  const scale = Math.min(SCALE, MAX_SIDE / width, MAX_SIDE / height, Math.sqrt(MAX_AREA / (width * height)));
  if (scale < MIN_SCALE) throw new TooLarge("The view is too large to export as one picture: filter it or export a PDF");
  const img = await imageOf(markup);
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new TooLarge("The view is too large to export as one picture: filter it or export a PDF");
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0);
  return canvas;
}

function save(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Letter, landscape, in points; its margin and footer. */
const PAGE_W = 792;
const PAGE_H = 612;
const MARGIN = 24;
const PAGE_FOOT = 22;
/** A page's pixels per point. */
const PAGE_PX = 2;

/** Helvetica's widths (its AFM, per 1000 of the size) for the printable ASCII, then the WinAnsi
 * extras the footer may hold: a right-aligned line is measured, never estimated. */
const HELVETICA =
  "278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584"
    .split(",")
    .map(Number);
const HELVETICA_MORE: Record<string, number> = { "·": 278, "–": 556, "—": 1000, "…": 1000, "’": 222, "‘": 222, "“": 333, "”": 333 };
export function helveticaWidth(s: string, size: number): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    w += HELVETICA_MORE[ch] ?? (c >= 32 && c <= 126 ? HELVETICA[c - 32] : 556);
  }
  return (w * size) / 1000;
}

/** A PDF string's bytes (WinAnsi, Helvetica's encoding), with ( ) \ escaped. */
function pdfText(s: string): string {
  const win: Record<string, number> = { "’": 0x92, "‘": 0x91, "“": 0x93, "”": 0x94, "–": 0x96, "—": 0x97, "…": 0x85, "·": 0xb7 };
  let out = "";
  for (const ch of s) {
    const c = win[ch] ?? ch.codePointAt(0)!;
    const b = c < 256 ? String.fromCharCode(c) : "?";
    out += b === "(" || b === ")" || b === "\\" ? `\\${b}` : b;
  }
  return out;
}

/** A canvas's pixels as RGB rows, deflated (zlib, as FlateDecode reads them). */
async function flate(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const { data } = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
  const rgb = new Uint8Array(canvas.width * canvas.height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i];
    rgb[j + 1] = data[i + 1];
    rgb[j + 2] = data[i + 2];
  }
  const stream = new Blob([rgb]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** One PDF page: its picture (deflated RGB at w x h pixels) over the whole page, and its footer as text. */
interface PdfPage {
  image: Uint8Array;
  w: number;
  h: number;
  /** Footer texts: [x, y, size, words, align]. */
  texts: [number, number, number, string, "left" | "right"][];
}

/** E-2: a PDF of Letter landscape pages, each one picture (FlateDecode, never JPEG) and its footer in Helvetica. */
export function pdfOf(pages: PdfPage[]): Blob {
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
  const push = (p: Uint8Array | string) => {
    const b = typeof p === "string" ? bytes(p) : p;
    parts.push(b);
    length += b.length;
  };
  const obj = (n: number, body: string) => {
    offsets[n] = length;
    push(`${n} 0 obj\n${body}\nendobj\n`);
  };
  push("%PDF-1.4\n");
  // 1 catalog, 2 pages, 3 font; then each page's page, contents and image.
  const first = 4;
  const kids = pages.map((_, k) => `${first + k * 3} 0 R`).join(" ");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  obj(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  pages.forEach((pg, k) => {
    const n = first + k * 3;
    const words = pg.texts
      .map(([x, y, size, t, align]) => {
        // A right-aligned line ends at x, by Helvetica's own widths.
        const at = align === "right" ? x - helveticaWidth(t, size) : x;
        return `BT /F1 ${size} Tf 0.35 0.4 0.47 rg ${at.toFixed(1)} ${y} Td (${pdfText(t)}) Tj ET`;
      })
      .join("\n");
    const content = `q ${PAGE_W} 0 0 ${PAGE_H} 0 0 cm /Im0 Do Q\n${words}`;
    obj(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /XObject << /Im0 ${n + 2} 0 R >> /Font << /F1 3 0 R >> >> /Contents ${n + 1} 0 R >>`);
    obj(n + 1, `<< /Length ${bytes(content).length} >>\nstream\n${content}\nendstream`);
    offsets[n + 2] = length;
    push(`${n + 2} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pg.w} /Height ${pg.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${pg.image.length} >>\nstream\n`);
    push(pg.image);
    push("\nendstream\nendobj\n");
  });
  const count = first + pages.length * 3;
  const xref = length;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n++) table += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts as BlobPart[], { type: "application/pdf" });
}

/** Past this many pages a PDF is too long to read (or to make: the 500-item day scale is 432):
 * a filter, then. */
const MAX_PAGES = 200;

/** Never smaller than this many points a pixel: a wider picture goes on across pages. */
const MIN_PT = 0.45;

/** E-2: the framed picture cut into page-high bands (at its rows, where it can), each page
 * its header (the brand, title, filters and the picture's own header: the date axis) again
 * above its band, and a footer: the disclaimer, the day it was made and "Page 2 of 5". A
 * picture too wide to read on one page's width goes on across pages too, its names column
 * again at the left of each. */
async function pagesOf(page: { markup: string; width: number; height: number }, pic: Picture, head: ExportHead, today: string): Promise<PdfPage[]> {
  const img = await imageOf(page.markup);
  const pad = 16;
  const top = HEAD + (pic.head ?? 0);
  const left = Math.min(page.width / 2, pad + (pic.left ?? 0));
  // Points per CSS pixel: the picture's width across the page (never larger than 1:1 at 72 dpi).
  const across = PAGE_W - 2 * MARGIN;
  const k = Math.max(MIN_PT, Math.min(0.75, across / page.width));
  const room = (PAGE_H - 2 * MARGIN - PAGE_FOOT) / k - top;
  const bodyEnd = HEAD + pic.height;
  const rows: [number, number][] = [];
  if (room < 60) rows.push([top, bodyEnd]);
  else
    for (let y = top; y < bodyEnd - 0.5;) {
      let end = Math.min(bodyEnd, y + room);
      if (end < bodyEnd) {
        const at = (pic.breaks ?? []).map((b) => HEAD + b).filter((b) => b > y + room / 3 && b <= end).at(-1);
        if (at) end = at;
      }
      rows.push([y, end]);
      y = end;
    }
  // The columns: the whole width, or (too wide) the part right of the names column in page-wide slices.
  const cols: [number, number][] = [];
  if (page.width * k <= across + 0.5) cols.push([left, page.width]);
  else {
    const step = across / k - left;
    for (let x = left; x < page.width - pad - 0.5; x += step) cols.push([x, Math.min(page.width, x + step)]);
  }
  const out: PdfPage[] = [];
  const total = rows.length * cols.length;
  if (total > MAX_PAGES) throw new TooLarge(`The view would take more than ${MAX_PAGES} PDF pages: filter it to export it`);
  const pageWords = (n: number) => `Page ${n + 1} of ${total}`;
  for (const [c, [x0, x1]] of cols.entries())
    for (const [r, [y0, y1]] of rows.entries()) {
      const n = c * rows.length + r;
      const canvas = document.createElement("canvas");
      canvas.width = PAGE_W * PAGE_PX;
      canvas.height = PAGE_H * PAGE_PX;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const m = MARGIN * PAGE_PX;
      // A band taller than a page (a header that leaves no room) is drawn shrunk to fit it.
      const bandH = y1 - y0;
      const g = k * PAGE_PX * Math.min(1, (PAGE_H - 2 * MARGIN - PAGE_FOOT) / k / (top + bandH));
      const w = x1 - x0;
      // The header's left (brand, title, names column's head), the header over this column, the
      // names for this band, then the band.
      ctx.drawImage(img, 0, 0, left, top, m, m, left * g, top * g);
      ctx.drawImage(img, x0, 0, w, top, m + left * g, m, w * g, top * g);
      ctx.drawImage(img, 0, y0, left, bandH, m, m + top * g, left * g, bandH * g);
      ctx.drawImage(img, x0, y0, w, bandH, m + left * g, m + top * g, w * g, bandH * g);
      const toPage = (X: number, Y: number): [number, number] => [m + left * g + (X + pad - x0) * g, m + (Y + HEAD) * g];
      if (c > 0 && pic.axis) edgeOfAxis(ctx, pic.axis, x0 - pad, toPage, g);
      // A label the column's right edge cuts ("3" of "30") is left to the next page.
      if (c < cols.length - 1 && pic.axis) clearCut(ctx, pic.axis, x1 - pad, toPage);
      ctx.strokeStyle = "#d6e0ea";
      ctx.lineWidth = PAGE_PX;
      ctx.beginPath();
      ctx.moveTo(m, canvas.height - m - (PAGE_FOOT - 6) * PAGE_PX);
      ctx.lineTo(canvas.width - m, canvas.height - m - (PAGE_FOOT - 6) * PAGE_PX);
      ctx.stroke();
      out.push({
        image: await flate(canvas),
        w: canvas.width,
        h: canvas.height,
        texts: [
          [MARGIN, MARGIN + 2, 8, cut(head.brand?.disclaimer ?? "", 110), "left"],
          [PAGE_W - MARGIN - helveticaWidth(pageWords(n), 8) - 12, MARGIN + 2, 8, stamp(today, head.brand), "right"],
          [PAGE_W - MARGIN, MARGIN + 2, 8, pageWords(n), "right"],
        ],
      });
    }
  return out;
}

/** A page's column that starts mid-axis: the axis words its left edge cuts are cleared, and the
 * month and year it starts in are written there ("Mar 2027"), over the axis's top row. `at`
 * maps the picture's pixels to the page canvas's. */
function edgeOfAxis(ctx: CanvasRenderingContext2D, axis: NonNullable<Picture["axis"]>, x: number, at: (x: number, y: number) => [number, number], g: number) {
  const day = axis.days.filter((d) => d.x <= x + 0.5).at(-1)?.day;
  const label = day ? `${MONTH_WORDS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}` : "";
  if (!axis.words.length) return;
  const topY = Math.min(...axis.words.map((t) => t.y));
  const labelW = label ? widthOf(label, 10, 600) + 6 : 0;
  ctx.fillStyle = "#ffffff";
  const clear = (x1: number, y: number, size: number) => {
    const [l, t] = at(x, y - size);
    const [r, b] = at(x1, y + 3);
    ctx.fillRect(l, t, r - l, b - t);
  };
  for (const t of axis.words) {
    // The top row gives way to the label; any other row only where a word is cut.
    const end = Math.max(t.x0 < x && t.x1 > x ? t.x1 : x, t.y === topY && t.x0 < x + labelW ? Math.max(t.x1, x + labelW) : x);
    if (end > x) clear(end, t.y, t.size);
  }
  if (!label) return;
  clear(x + labelW, topY, 10);
  const [lx, ly] = at(x + 3, topY);
  ctx.fillStyle = "#3f4a5a";
  ctx.font = `600 ${10 * g}px sans-serif`;
  ctx.textAlign = "left";
  ctx.fillText(label, lx, ly);
}

/** Clears the part left of `x` of each axis word that `x` cuts. */
function clearCut(ctx: CanvasRenderingContext2D, axis: NonNullable<Picture["axis"]>, x: number, at: (x: number, y: number) => [number, number]) {
  ctx.fillStyle = "#ffffff";
  for (const t of axis.words.filter((t) => t.x0 < x && t.x1 > x)) {
    const [l, top] = at(t.x0 - 1, t.y - t.size);
    const [r, b] = at(x, t.y + 3);
    ctx.fillRect(l, top, r - l, b - top);
  }
}

/** The key-date markers a picture draws, by name (ah-prd-milestones-once review: the Timeline's export draws them from the goal lanes). */
function keyDatesIn(pic: Picture): string[] {
  const doc = new DOMParser().parseFromString(`<svg xmlns="${SVG_NS}">${pic.body}</svg>`, "image/svg+xml");
  return [...doc.querySelectorAll('[data-testid="key-date-marker"]')].map((g) => g.getAttribute("data-name") ?? "");
}

export async function exportView(kind: "png" | "pdf", pic: Picture, head: ExportHead, today: string, name: string) {
  const page = framed(pic, head, today);
  window.__poExports?.push({ kind, title: head.title, filters: head.filters, brand: head.brand?.name ?? null, logo: !!head.brand?.logo, width: page.width, height: page.height, keyDates: keyDatesIn(pic) });
  if (kind === "png") {
    const canvas = await canvasOf(page);
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/png"));
    if (!blob) throw new TooLarge("The view is too large to export as one picture: filter it or export a PDF");
    save(blob, `${name}.png`);
    return;
  }
  save(pdfOf(await pagesOf(page, pic, head, today)), `${name}.pdf`);
}
