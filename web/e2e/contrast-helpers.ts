import { expect, type Locator } from "./test";

/** The colours one read saw: as CSS gave them and as painted sRGB (r, g, b, a in 0..255). */
type Read = { fgCss: string; bgCss: string; fg: number[]; bg: number[]; moving: string[]; forever: string[] };

/**
 * One read of an element's text colour and the first opaque background behind it. Waits at most
 * `timeout` for the element, so a missing one fails the read with its own error.
 */
function readColours(el: Locator, timeout: number): Promise<Read> {
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
    // A colour, background or opacity transition or keyframe animation still running on the
    // element or behind it is not a settled colour; other properties (a spinner's transform) are.
    const paints = (p: string) => /^(color|background|background-color|opacity|all)$/.test(p);
    const name = (n: Element) =>
      n.tagName.toLowerCase() + (n.id ? `#${n.id}` : "") + [...n.classList].map((c) => `.${c}`).join("");
    const moving: string[] = [];
    const forever: string[] = [];
    for (let n: Element | null = node; n; n = n.parentElement) {
      for (const a of n.getAnimations()) {
        if (a.playState !== "running") continue;
        if (a instanceof CSSTransition && paints(a.transitionProperty)) {
          moving.push(`the ${a.transitionProperty} transition on ${name(n)}`);
        } else if (a instanceof CSSAnimation) {
          const frames = (a.effect as KeyframeEffect | null)?.getKeyframes() ?? [];
          const props = frames.flatMap((f) => Object.keys(f)).map((k) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));
          if (!props.some(paints)) continue;
          const what = `the keyframe animation "${a.animationName}" on ${name(n)}`;
          moving.push(what);
          if (a.effect?.getComputedTiming().iterations === Infinity) forever.push(what);
        }
      }
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
    return { fgCss, bgCss, fg: paint(fgCss), bg, moving, forever };
  }, undefined, { timeout });
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
 * settled: finite, no colour, background or opacity transition or animation running, and the
 * same on two reads in a row. Throws if they never settle within `timeout`: naming an animation
 * that runs forever, else with the read's own error (a missing element) as the cause, else naming
 * both colours. It never returns NaN.
 */
export async function contrast(el: Locator, timeout = 5_000): Promise<number> {
  let last: Read | undefined;
  let failed: Error | undefined;
  let settled: Read | undefined;
  try {
    await expect(async () => {
      let now: Read;
      try {
        now = await readColours(el, Math.min(timeout, 1_000));
        failed = undefined;
      } catch (e) {
        failed = e instanceof Error ? e : new Error(String(e));
        throw e;
      }
      const prev = last;
      last = now;
      expect(finite(now.fg) && finite(now.bg) && !now.moving.length && !!prev && same(prev, now)).toBe(true);
      settled = now;
    }).toPass({ timeout, intervals: [50, 100, 200] });
  } catch (e) {
    if (failed) {
      throw new Error(`The contrast could not be read within ${timeout} ms: ${failed.message}`, { cause: failed });
    }
    if (last?.forever.length) {
      throw new Error(
        `The contrast cannot be read: ${last.forever.join(" and ")} runs forever, so the colours never settle.`,
        { cause: e },
      );
    }
    throw new Error(
      `The contrast never settled within ${timeout} ms: text colour "${last?.fgCss}" on background "${last?.bgCss}"` +
        ` (read as ${JSON.stringify(last?.fg)} on ${JSON.stringify(last?.bg)}` +
        `${last?.moving.length ? `, ${last.moving.join(" and ")} still running` : ""}).`,
      { cause: e },
    );
  }
  const r = ratio(settled!.fg, settled!.bg);
  if (!Number.isFinite(r)) throw new Error(`The contrast of "${settled!.fgCss}" on "${settled!.bgCss}" is not a number.`);
  return r;
}
