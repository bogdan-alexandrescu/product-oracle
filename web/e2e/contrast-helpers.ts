import { expect, type Locator } from "./test";

/** The colours one read saw: as CSS gave them and as painted sRGB (r, g, b, a in 0..255). */
type Read = { fgCss: string; bgCss: string; fg: number[]; bg: number[]; moving: boolean };

/** One read of an element's text colour and the first opaque background behind it. */
function readColours(el: Locator): Promise<Read> {
  return el.evaluate((node) => {
    // Any CSS colour (rgb, oklch, color-mix...) painted on a 1 px canvas and read back as sRGB;
    // a colour the browser cannot resolve yet reads as NaN.
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const paint = (c: string) => {
      if (!c || !CSS.supports("color", c)) return [NaN, NaN, NaN, NaN];
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data);
    };
    const fgCss = getComputedStyle(node).color;
    let bgCss = "rgb(255, 255, 255)";
    let bg = [255, 255, 255, 255];
    let moving = false;
    for (let n: Element | null = node; n; n = n.parentElement) {
      // A colour transition still running on the element or behind it is not a settled colour.
      if (n.getAnimations().some((a) => a.playState === "running" && a instanceof CSSTransition)) moving = true;
    }
    for (let n: Element | null = node; n; n = n.parentElement) {
      const css = getComputedStyle(n).backgroundColor;
      const c = paint(css);
      // Alpha above 0.9 counts as opaque, as before; a NaN read stops here so it shows.
      if (Number.isNaN(c[0]) || c[3] > 0.9 * 255) {
        bgCss = css;
        bg = c;
        break;
      }
    }
    return { fgCss, bgCss, fg: paint(fgCss), bg, moving };
  });
}

function ratio(fg: number[], bg: number[]): number {
  const lum = ([r, g, b]: number[]) => {
    const f = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

const finite = (c: number[]) => c.length >= 3 && c.slice(0, 3).every(Number.isFinite);
const same = (a: Read, b: Read) => a.fg.join() === b.fg.join() && a.bg.join() === b.bg.join();

/**
 * The WCAG contrast ratio of an element's text on its background, read once both colours have
 * settled: finite, no colour transition running, and the same on two reads in a row. Throws,
 * naming both colours, if they never settle within `timeout`; it never returns NaN.
 */
export async function contrast(el: Locator, timeout = 5_000): Promise<number> {
  let last: Read | undefined;
  let settled: Read | undefined;
  try {
    await expect(async () => {
      const now = await readColours(el);
      const prev = last;
      last = now;
      expect(finite(now.fg) && finite(now.bg) && !now.moving && !!prev && same(prev, now)).toBe(true);
      settled = now;
    }).toPass({ timeout, intervals: [50, 100, 200] });
  } catch {
    throw new Error(
      `The contrast never settled within ${timeout} ms: text colour "${last?.fgCss}" on background "${last?.bgCss}"` +
        ` (read as ${JSON.stringify(last?.fg)} on ${JSON.stringify(last?.bg)}${last?.moving ? ", a transition still running" : ""}).`,
    );
  }
  const r = ratio(settled!.fg, settled!.bg);
  if (!Number.isFinite(r)) throw new Error(`The contrast of "${settled!.fgCss}" on "${settled!.bgCss}" is not a number.`);
  return r;
}
