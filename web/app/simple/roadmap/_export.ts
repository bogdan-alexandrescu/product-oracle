/**
 * D20: the current roadmap view (its format and filters) as PNG and PDF, drawn in the
 * browser from what is on screen: the labels column and the chart's SVG, with the theme's
 * colours resolved, onto a canvas; the PDF is one page holding that picture.
 */

const SCALE = 2;

function resolveVars(root: Element, style: CSSStyleDeclaration) {
  const fix = (v: string) => v.replace(/var\((--[a-z0-9-]+)\)/g, (_, name: string) => style.getPropertyValue(name).trim() || "#000");
  for (const el of [root, ...root.querySelectorAll("*")]) {
    for (const a of ["fill", "stroke"]) {
      const v = el.getAttribute(a);
      if (v?.includes("var(")) el.setAttribute(a, fix(v));
    }
  }
}

/** One standalone SVG: a title line, the labels (as text) and the chart. */
function compose(svg: SVGSVGElement, labels: HTMLElement | null, title: string): { markup: string; width: number; height: number } {
  const style = getComputedStyle(document.documentElement);
  const labelW = labels?.offsetWidth ?? 0;
  const head = 36;
  const width = labelW + svg.width.baseVal.value;
  const height = head + svg.height.baseVal.value;
  const chart = svg.cloneNode(true) as SVGSVGElement;
  resolveVars(chart, style);
  chart.setAttribute("x", String(labelW));
  chart.setAttribute("y", String(head));
  const text = style.getPropertyValue("--text").trim() || "#000";
  const surface = style.getPropertyValue("--surface").trim() || "#fff";
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const rows: string[] = [];
  if (labels) {
    const top = labels.getBoundingClientRect().top;
    for (const el of labels.children) {
      const r = (el as HTMLElement).getBoundingClientRect();
      const t = (el as HTMLElement).innerText.split("\n")[0]?.trim();
      if (t) rows.push(`<text x="10" y="${head + r.top - top + r.height / 2 + 5}" font-size="13" font-family="sans-serif" fill="${text}">${esc(t.slice(0, 34))}</text>`);
    }
  }
  const markup =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect width="100%" height="100%" fill="${surface}"/>` +
    `<text x="10" y="24" font-size="16" font-weight="600" font-family="sans-serif" fill="${text}">${esc(title)}</text>` +
    rows.join("") +
    new XMLSerializer().serializeToString(chart) +
    `</svg>`;
  return { markup, width, height };
}

async function canvasOf(svg: SVGSVGElement, labels: HTMLElement | null, title: string): Promise<HTMLCanvasElement> {
  const { markup, width, height } = compose(svg, labels, title);
  // A data: URL: the app's CSP allows data: images (not blob:).
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  {
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

export async function exportView(kind: "png" | "pdf", svg: SVGSVGElement, labels: HTMLElement | null, title: string, name: string) {
  const canvas = await canvasOf(svg, labels, title);
  if (kind === "png") {
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/png"));
    if (blob) save(blob, `${name}.png`);
    return;
  }
  const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", 0.92));
  if (!blob) return;
  save(pdfOf(new Uint8Array(await blob.arrayBuffer()), canvas.width, canvas.height), `${name}.pdf`);
}
