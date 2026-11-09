import type { Locator } from "./test";

/** The colours one read saw: as CSS gave them and as painted sRGB (r, g, b, a in 0..255). */
type Read = { fgCss: string; bgCss: string; fg: number[]; bg: number[]; moving: string[] };

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
    // A colour, background or opacity transition or keyframe animation still running on the
    // element or behind it is not a settled colour; other properties (a spinner's transform) are.
    const paints = (p: string) => /^(color|background|background-color|opacity|all)$/.test(p);
    const name = (n: Element) =>
      n.tagName.toLowerCase() + (n.id ? `#${n.id}` : "") + [...n.classList].map((c) => `.${c}`).join("");
    // The time, at or after 0, an endless animation shows its from keyframe, or null if its cycle
    // has no length: such an animation is read there, as it rests, and then put back. Iteration k
    // starts at delay + k * cycle: on the from keyframe for every k when it runs normal, for even
    // k when alternate and odd k when alternate-reverse; reverse starts each on its to keyframe
    // and so reaches the from keyframe only as it ends, read a hundredth of a millisecond before.
    // The others are read a hundredth of a millisecond after their iteration starts: the browser
    // seeks in seconds, so a seek exactly onto the start can land at the end of the iteration
    // before, on its to keyframe. A steps(n, start) easing jumps a step as each iteration starts,
    // so it never shows its from keyframe: it is read on the step nearest it, one step in.
    const restAt = (a: CSSAnimation) => {
      const timing = a.effect?.getComputedTiming();
      const delay = Number(timing?.delay ?? 0);
      const cycle = Number(timing?.duration);
      if (!Number.isFinite(delay) || !Number.isFinite(cycle) || cycle <= 0) return null;
      const end = 0.01;
      let k = Math.max(0, Math.ceil(-delay / cycle));
      if (timing?.direction === "reverse") k = Math.max(1, Math.ceil((end - delay) / cycle));
      if (timing?.direction === "alternate" && k % 2 === 1) k++;
      if (timing?.direction === "alternate-reverse" && k % 2 === 0) k++;
      return delay + k * cycle + (timing?.direction === "reverse" ? -end : end);
    };
    const moving: string[] = [];
    const rested: { a: Animation; was: CSSNumberish | null }[] = [];
    try {
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
            if (a.effect?.getComputedTiming().iterations !== Infinity) {
              moving.push(what);
              continue;
            }
            // A zero-length cycle (its only endless kind with no rest) is still waiting out its
            // delay: it counts as running, as any other unsettled colour.
            const at = restAt(a);
            if (at === null) {
              moving.push(what);
            } else {
              rested.push({ a, was: a.currentTime });
              a.currentTime = at;
            }
          }
        }
      }
      const fgCss = getComputedStyle(node).color;
      let bgCss = "rgb(255, 255, 255)";
      let bg = [255, 255, 255, 255];
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
    } finally {
      for (const { a, was } of rested) a.currentTime = was;
    }
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
 * same on two reads in a row. An endless animation is read at rest, on its from keyframe, whatever
 * its direction. Every read and pause fits in the one `timeout`. Throws at once if the locator
 * matches more than one element; if the colours never settle within `timeout`, throws with the
 * read's own error (a missing element) as the cause, else naming both colours and what still runs.
 * It never returns NaN.
 */
export async function contrast(el: Locator, timeout = 5_000): Promise<number> {
  const deadline = Date.now() + timeout;
  const pauses = [50, 100, 200];
  let last: Read | undefined;
  let failed: Error | undefined;
  for (let i = 0; ; i++) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    let now: Read | undefined;
    try {
      now = await readColours(el, left);
      failed = undefined;
    } catch (e) {
      failed = e instanceof Error ? e : new Error(String(e));
      // Two or more matches will not become one by waiting: fail now, with that cause.
      if (/strict mode violation/i.test(failed.message)) {
        throw new Error(`The contrast cannot be read: ${failed.message}`, { cause: failed });
      }
    }
    if (now) {
      const prev = last;
      last = now;
      if (finite(now.fg) && finite(now.bg) && !now.moving.length && prev && same(prev, now)) {
        const r = ratio(now.fg, now.bg);
        if (!Number.isFinite(r)) throw new Error(`The contrast of "${now.fgCss}" on "${now.bgCss}" is not a number.`);
        return r;
      }
    }
    const pause = Math.min(pauses[Math.min(i, pauses.length - 1)], deadline - Date.now());
    if (pause <= 0) break;
    await new Promise((done) => setTimeout(done, pause));
  }
  if (failed) {
    throw new Error(`The contrast could not be read within ${timeout} ms: ${failed.message}`, { cause: failed });
  }
  throw new Error(
    `The contrast never settled within ${timeout} ms: text colour "${last?.fgCss}" on background "${last?.bgCss}"` +
      ` (read as ${JSON.stringify(last?.fg)} on ${JSON.stringify(last?.bg)}` +
      `${last?.moving.length ? `, ${last.moving.join(" and ")} still running` : ""}).`,
  );
}
