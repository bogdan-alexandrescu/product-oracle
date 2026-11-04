/**
 * Raw tokens in generated text (raw-tokens-everywhere): a writer cites with "[c:id]", "[l:n]"
 * and "[s:id]"; none of them is words a person reads. The API's counterpart is
 * api/oracle/raw_tokens.py. Text with footnote links of its own (a PRD section's Markdown,
 * lib/markdown.ts) turns its "[c:id]" into those; everything else drops them here.
 */
import type { Schemas } from "@/lib/api/client";

/**
 * chat-citations: the last line of defence for an answer's words. Every `[kind:id]` token
 * left in them ("[l:2]", "[c:c4]", "[s:12]") is taken out, with the space before it; only a
 * footnote the Ask panel draws (`[c:n]`, or `[c:l.n]` for a live read) stays. A markdown
 * link ("[words](/path)") is untouched.
 */
const RAW_TOKEN = /[ \t]*\[(?!c:(?:l\.)?\d{1,4}\])[a-z]{1,3}:[^\]\s[]{0,40}\](?!\()/gi;

export function noRawTokens(text: string): string {
  return text.replace(RAW_TOKEN, "");
}

/** Code in an answer, kept as written: a fenced block (to its closing fence or the end) or a `span`. */
const CODE = /(```[\s\S]*?(?:```|$)|`[^`\n]+`)/;

/** A token still being written at the end of a streaming answer ("[", "[c:1", "[s:1", "[c:l."). */
const PARTIAL = /\[(?:[a-z]{1,3}(?::[^\]\s[]{0,40})?)?$/i;

/**
 * An answer's words for the Ask panel: each live read's `[l:n]` as its footnote (`[c:l.n]`) and
 * no raw token left, outside code only; while it streams (`live`), a token not yet whole is held back.
 */
export function answerWords(text: string, live = false): string {
  return (live ? text.replace(PARTIAL, "") : text)
    .split(CODE)
    .map((part, i) => (i % 2 ? part : noRawTokens(part.replace(/\[l:(\d{1,4})\]/g, "[c:l.$1]"))))
    .join("");
}
/** One marker with the space before it ("appears [c:c1]." → "appears."). A match starts only at
 * the head of a space run, so a long run is scanned once. */
const MARKER = /(?<![ \t])[ \t]*\[[cls]:[^[\]\n]*\]/g;
/** What a nested or unclosed marker leaves: its opener. */
const OPENER = /\[[cls]:/g;

/** Whether `text` carries a raw marker a person would see. */
export function hasRawTokens(text: string | null | undefined): boolean {
  return !!text && /\[[cls]:/.test(text);
}

/** `text` without raw markers; a nested one ("[c:[c:x]]") leaves nothing. */
export function stripRawTokens(text: string): string {
  let out = text;
  for (let i = 0; i < 4; i++) {
    const next = out.replace(MARKER, "");
    if (next === out) break;
    out = next;
  }
  return out.replace(OPENER, "");
}

const opt = (s: string | null | undefined) => (s == null ? s : stripRawTokens(s));

type Flow = Schemas["SimpleFlow"];

/** A drawing's words (its title, steps, storyboard cards, screen and notes) as people read them. */
export function cleanFlow<T extends Flow | null | undefined>(flow: T): T {
  if (!flow) return flow;
  return {
    ...flow,
    title: stripRawTokens(flow.title),
    steps: flow.steps.map(stripRawTokens),
    goal: opt(flow.goal),
    screen: { ...flow.screen, title: stripRawTokens(flow.screen.title), regions: flow.screen.regions.map(stripRawTokens) },
    nodes: flow.nodes?.map((s) => ({ ...s, label: stripRawTokens(s.label), actor: opt(s.actor), yes: opt(s.yes), no: opt(s.no) })),
    svg: opt(flow.svg),
    wireframe: opt(flow.wireframe),
    annotations: flow.annotations?.map((a) => ({ ...a, note: stripRawTokens(a.note) })),
  };
}
