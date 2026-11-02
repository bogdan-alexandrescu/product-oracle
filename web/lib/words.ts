"use client";

import { useEffect, useState } from "react";

/**
 * Whole words in narrow table columns (priorities-words): a name wraps between its words, and a
 * word wider than its column is hyphenated ("instrumen-tation") rather than cut bare
 * ("instrumentatio / n"). Widths are measured in the page's own fonts, so a column is sized
 * from the names it shows rather than a guess.
 */

const SOFT_HYPHEN = "­";

let ctx: CanvasRenderingContext2D | null | undefined;
const families = new Map<string, string>();

/** The resolved font family a class gives ("font-mono"), read once from a probe element. */
function family(className: string): string | null {
  if (typeof document === "undefined" || !document.body) return null;
  const hit = families.get(className);
  if (hit) return hit;
  const probe = document.createElement("span");
  probe.className = className;
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  document.body.appendChild(probe);
  const f = getComputedStyle(probe).fontFamily;
  probe.remove();
  families.set(className, f);
  return f;
}

/** A text's width in px at a weight and size in the family a class gives; null before the page is in a browser. */
export function textWidth(text: string, weight: number, size: number, className = "font-sans"): number | null {
  const f = family(className);
  if (!f) return null;
  if (ctx === undefined) ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return null;
  ctx.font = `${weight} ${size}px ${f}`;
  return ctx.measureText(text).width;
}

/** The words of a name, split where a line may break. */
export const wordsOf = (text: string) => text.split(/\s+/).filter(Boolean);

const VOWEL = /[aeiouy]/i;
const LETTER = /\p{L}/u;

/**
 * Soft hyphens at a word's likely syllable breaks: before a consonant that starts a syllable
 * (in-stru-men-ta-tion), at least three letters from either end. The browser shows a hyphen
 * only where it breaks the line there.
 */
export function hyphenate(word: string): string {
  const c = [...word];
  const letters = c.map((x) => LETTER.test(x));
  const vowel = c.map((x, i) => letters[i] && VOWEL.test(x));
  const cons = c.map((_, i) => letters[i] && !vowel[i]);
  const before = (i: number) => letters.slice(0, i).filter(Boolean).length;
  const after = (i: number) => letters.slice(i).filter(Boolean).length;
  let out = "";
  for (let i = 0; i < c.length; i++) {
    // A consonant followed by a vowel starts a syllable after a vowel (V|CV) or after a
    // consonant that itself follows a vowel (VC|CV).
    const starts = cons[i] && vowel[i + 1] && (vowel[i - 1] || (cons[i - 1] && vowel[i - 2]));
    if (i > 0 && starts && before(i) >= 3 && after(i) >= 3) out += SOFT_HYPHEN;
    out += c[i];
  }
  return out;
}

/** The text with each word wider than `room` px hyphenated; unchanged before it can be measured. */
export function fitWords(text: string, room: number, weight: number, size: number): string {
  return text
    .split(/(\s+)/)
    .map((w) => {
      if (!w.trim()) return w;
      const width = textWidth(w, weight, size);
      return width != null && width > room ? hyphenate(w) : w;
    })
    .join("");
}

/**
 * Above 0 once the fonts the table measures in have loaded (Inter Tight, DM Mono), and higher
 * after each later font load, so widths measured before are measured again in the fonts' own.
 */
export function useFontsReady(): number {
  const [ready, setReady] = useState(0);
  useEffect(() => {
    let live = true;
    const bump = () => {
      if (live) setReady((n) => n + 1);
    };
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    const sans = family("font-sans");
    const mono = family("font-mono");
    const loads: Promise<unknown>[] = fonts ? [fonts.ready] : [];
    if (fonts && sans) loads.push(fonts.load(`500 15px ${sans}`), fonts.load(`400 13px ${sans}`));
    if (fonts && mono) loads.push(fonts.load(`500 13px ${mono}`));
    void Promise.all(loads).catch(() => undefined).then(bump);
    fonts?.addEventListener("loadingdone", bump);
    return () => {
      live = false;
      fonts?.removeEventListener("loadingdone", bump);
    };
  }, []);
  return ready;
}

/** An element's content width in px, kept as it resizes; null until it is laid out. Pass the ref to the element. */
export function useWidth(): [(el: HTMLElement | null) => void, number | null] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width];
}
