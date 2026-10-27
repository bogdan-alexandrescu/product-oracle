/**
 * D20: the current roadmap view (its format and filters) as PNG and PDF, drawn in the
 * browser from what is on screen: the timeline, Gantt and waterfall from the labels column
 * and the chart's SVG, the board from its columns; framed with the company's branding (its
 * logo, name and accent, the public disclaimer) and a line naming the filters, with the
 * theme's colours resolved, onto a canvas; the PDF is one page holding that picture.
 */
import type { BoardColumn } from "./_board";
import { shortDay } from "./_lib";

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
interface Picture {
  body: string;
  width: number;
  height: number;
}

declare global {
  interface Window {
    /** A spec sets it to an array to read what each export drew (its header and size). */
    __poExports?: { kind: "png" | "pdf"; title: string; filters: string; brand: string | null; logo: boolean; width: number; height: number }[];
  }
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** The labels (as text) and a copy of the chart's SVG beside them. */
export function chartPicture(svg: SVGSVGElement, labels: HTMLElement | null): Picture {
  const labelW = labels?.offsetWidth ?? 0;
  const chart = svg.cloneNode(true) as SVGSVGElement;
  chart.setAttribute("x", String(labelW));
  chart.setAttribute("y", "0");
  const rows: string[] = [];
  if (labels) {
    const top = labels.getBoundingClientRect().top;
    for (const el of labels.children) {
      const r = (el as HTMLElement).getBoundingClientRect();
      const t = (el as HTMLElement).innerText.split("\n")[0]?.trim();
      if (t) rows.push(`<text x="10" y="${r.top - top + r.height / 2 + 5}" font-size="13" fill="var(--text)">${esc(cut(t, 34))}</text>`);
    }
  }
  return { body: rows.join("") + new XMLSerializer().serializeToString(chart), width: labelW + svg.width.baseVal.value, height: svg.height.baseVal.value };
}

/** The board's columns, each group and card as boxes and text. */
export function boardPicture(cols: BoardColumn[]): Picture {
  const colW = 300;
  const gap = 12;
  const out: string[] = [];
  let height = 0;
  cols.forEach((c, n) => {
    const x = n * (colW + gap);
    const parts: string[] = [];
    let y = 34;
    parts.push(`<text x="${x + 10}" y="22" font-size="16" font-weight="600" fill="var(--text)">${esc(c.label)}</text>`);
    parts.push(`<text x="${x + colW - 10}" y="22" font-size="12" text-anchor="end" fill="var(--text2)">${esc(`${shortDay(c.window.start)} – ${shortDay(c.window.end)}`)}</text>`);
    const cardOf = (i: BoardColumn["below"][number]) => {
      const est = i.estimated && !i.draft;
      const red = i.flags.some((f) => f.state === "red");
      const fill = i.status === "cut" ? "var(--na-bg)" : est ? "url(#export-hatch)" : "var(--surface)";
      const stroke = red ? "var(--crit)" : "var(--line)";
      parts.push(`<rect x="${x + 8}" y="${y}" width="${colW - 16}" height="44" rx="8" fill="${fill}" stroke="${stroke}"${i.draft ? ' stroke-dasharray="5 3"' : ""}/>`);
      parts.push(`<text x="${x + 16}" y="${y + 18}" font-size="13" font-weight="500" fill="var(--text)"${i.status === "cut" ? ' text-decoration="line-through"' : ""}>${esc(cut(i.title, 38))}</text>`);
      const meta = `${shortDay(i.start.date)} – ${shortDay(i.end.date)}${est ? " · estimated" : ""}${i.draft ? " · draft" : ""}`;
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

/** One standalone SVG: the branded header (logo, company, title, filters), the picture and
 * the footer (the public disclaimer, the day, Oracle's mark), with the theme's colours. */
export function framed(pic: Picture, head: ExportHead, today: string): { markup: string; width: number; height: number } {
  const style = getComputedStyle(document.documentElement);
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
    `<text x="${pad}" y="${height - 13}" font-size="11" fill="var(--text2)">${esc(cut(b?.disclaimer ?? "", 120))}</text>` +
    `<text x="${width - pad}" y="${height - 13}" font-size="11" text-anchor="end" fill="var(--text2)">${esc(`${shortDay(today)}${b?.mark ? " · Made with Product Oracle" : ""}`)}</text>` +
    `</svg>`;
  return { markup: markup.replace(/var\((--[a-z0-9-]+)\)/g, (_, name: string) => style.getPropertyValue(name).trim() || "#000"), width, height };
}

async function canvasOf({ markup, width, height }: { markup: string; width: number; height: number }): Promise<HTMLCanvasElement> {
  // A data: URL: the app's CSP allows data: images (not blob:).
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  const img = new Image();
  await new Promise<void>((ok, fail) => {
    img.onload = () => ok();
    img.onerror = () => fail(new Error("The view could not be drawn"));
    img.src = url;
  });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * SCALE);
  canvas.height = Math.ceil(height * SCALE);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(SCALE, SCALE);
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

/** A one-page PDF holding one JPEG (DCTDecode), the page sized to the picture. */
export function pdfOf(jpeg: Uint8Array, w: number, h: number): Blob {
  const enc = new TextEncoder();
  const parts: (Uint8Array | string)[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (p: Uint8Array | string) => {
    parts.push(p);
    length += typeof p === "string" ? enc.encode(p).length : p.length;
  };
  // Points: fit the picture's CSS pixels onto the page at 72 per inch (0.75 pt per px).
  const pw = Math.round((w / SCALE) * 0.75);
  const ph = Math.round((h / SCALE) * 0.75);
  const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
  push("%PDF-1.4\n");
  const obj = (n: number, body: string) => {
    offsets[n] = length;
    push(`${n} 0 obj\n${body}\nendobj\n`);
  };
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  offsets[4] = length;
  push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
  push(jpeg);
  push("\nendstream\nendobj\n");
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  const xref = length;
  let table = `xref\n0 6\n0000000000 65535 f \n`;
  for (let n = 1; n <= 5; n++) table += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts as BlobPart[], { type: "application/pdf" });
}

export async function exportView(kind: "png" | "pdf", pic: Picture, head: ExportHead, today: string, name: string) {
  const page = framed(pic, head, today);
  window.__poExports?.push({ kind, title: head.title, filters: head.filters, brand: head.brand?.name ?? null, logo: !!head.brand?.logo, width: page.width, height: page.height });
  const canvas = await canvasOf(page);
  if (kind === "png") {
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/png"));
    if (blob) save(blob, `${name}.png`);
    return;
  }
  const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", 0.92));
  if (!blob) return;
  save(pdfOf(new Uint8Array(await blob.arrayBuffer()), canvas.width, canvas.height), `${name}.pdf`);
}
