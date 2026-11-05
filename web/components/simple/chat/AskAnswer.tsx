"use client";

import Link from "next/link";
import { createContext, Fragment, useContext, useMemo, type ReactNode } from "react";

import { FeatureMarks, MarkFor, WithFeatureMarks, type FeatureState } from "@/components/current-state/CurrentState";
import { Icon } from "@/components/ds";
import { formatInZone, useCompanyZone } from "@/lib/dates";
import { isSafeHref, parseBlocks, type Block, type Inline } from "@/lib/markdown";
import { answerWords, noRawTokens } from "@/lib/raw-tokens";

/**
 * Oracle's answer in Simple's Ask panel, as the owner's pick C draws it (ask-panel fidelity,
 * 2026-10-28): its title, its lines, short labelled lists ("DONE WHEN", "TARGETS"…) and,
 * under them, where it comes from as links ("From the PRD · Roadmap", "Open M2 on the
 * roadmap"). The answer's text is the small markdown Oracle writes (lib/markdown); its
 * `[c:n]` markers are a small raised number just after the word before them, a link to the source
 * it cites (none when it has none to open): the cited sources are the links under it. A live
 * read's `[l:n]` (General chat, meeting notes) is a raised number after the context's ones,
 * named for the read; any other token is never shown (chat-citations: noRawTokens).
 */

/** "7:42 PM": a line's time in the company's time zone, with no zone after it. */
export function chatTime(iso: string, zone: string): string {
  return formatInZone(iso, zone, { hour: "numeric", minute: "2-digit" }).replace(/([AP]M)\s.*$/, "$1");
}

/** The author and time over a line: "Bogdan · 7:42 PM". */
export function Who({ name, at, zone, mine }: { name: string; at: string; zone: string; mine: boolean }) {
  return (
    <span className="mb-0.5 block text-[13px] leading-[18px] font-semibold" data-testid="chat-who">
      {name}{" "}
      <i className={`font-normal not-italic ${mine ? "opacity-80" : "text-text2"}`}>· {chatTime(at, zone)}</i>
    </span>
  );
}

/** A citation as an answer carries it (oracle.discussions.context: n, kind, title, url). */
export type AnswerCite = { n?: number; kind?: string; title?: string; url?: string | null; label?: string; ref?: string; source?: string; read_at?: string };

function plain(nodes: Inline[]): boolean {
  return nodes.every((n) => n.t === "cite" || (n.t === "text" && !n.v.trim()));
}

/** The answer's first block is its title: a heading, or a line that is all bold (its markers kept, for the pill of what it names). */
function titleOf(b: Block | undefined): { c: Inline[]; cites: string[] } | null {
  if (!b) return null;
  if (b.t === "h") return { c: b.c, cites: [] };
  if (b.t !== "p") return null;
  const strong = b.c.filter((n) => n.t === "strong");
  const cites = b.c.flatMap((n) => (n.t === "cite" ? [n.key] : []));
  return strong.length === 1 && plain(b.c.filter((n) => n.t !== "strong")) ? { c: (strong[0] as { c: Inline[] }).c, cites } : null;
}

/**
 * The features an answer names, by name: each feature's own title, and the title of the roadmap
 * item (or feature) a citation stands for. A name is matched whole and as written (never inside
 * a longer word); the longest name wins where two overlap.
 */
type Namer = { re: RegExp; byName: Map<string, FeatureState> };

/** How a block's words are drawn: who is named, and the features already marked by name in it. */
type Ctx = { namer: Namer | null; named: Set<string> };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function namerOf(marks: Map<string, FeatureState> | null, cites: AnswerCite[]): Namer | null {
  if (!marks) return null;
  const byName = new Map<string, FeatureState>();
  for (const f of marks.values()) if (f.title.trim().length >= 3 && !byName.has(f.title.trim())) byName.set(f.title.trim(), f);
  for (const c of cites) {
    const f = featureOf(marks, c);
    const title = String(c.title ?? "").trim();
    const name = title.includes(": ") ? title.slice(title.indexOf(": ") + 2).trim() : title;
    if (f && name.length >= 3 && !byName.has(name)) byName.set(name, f);
  }
  if (!byName.size) return null;
  const alts = [...byName.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join("|");
  return { re: new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts})(?![\\p{L}\\p{N}])`, "gu"), byName };
}

/** Whether a spot in the words is inside quotes: a person's own words said back ("“Cut Welcome video”") carry no pill. */
function quoted(v: string, at: number): boolean {
  const before = v.slice(0, at);
  const count = (re: RegExp) => before.match(re)?.length ?? 0;
  return count(/“/g) > count(/”/g) || count(/"/g) % 2 === 1;
}

/** The names in some words that carry a pill: outside quotes. */
const namesIn = (v: string, namer: Namer) => [...v.matchAll(namer.re)].filter((m) => !quoted(v, m.index!));

/** The features named in a block's words (not in code or a link's words). */
function namedIn(nodes: Inline[], namer: Namer | null, into = new Set<string>()): Set<string> {
  if (!namer) return into;
  for (const n of nodes) {
    if (n.t === "text") for (const m of namesIn(noRawTokens(n.v), namer)) into.add(namer.byName.get(m[0])!.feature_id);
    else if (n.t === "strong" || n.t === "em") namedIn(n.c, namer, into);
  }
  return into;
}

/** A block's drawing context: its features named in words carry their pill there, not after a marker. */
const ctxOf = (nodes: Inline[], namer: Namer | null): Ctx => ({ namer, named: namedIn(nodes, namer) });

/** A feature's pill, right after its name in the answer's words. */
function NameMark({ f }: { f: FeatureState }) {
  return (
    <span className="ml-1.5 inline-flex align-middle empty:hidden" data-testid="answer-mark">
      <MarkFor featureId={f.feature_id} />
    </span>
  );
}

/** Words with each feature's name followed by its pill. */
function withMarks(v: string, namer: Namer | null): ReactNode {
  if (!namer) return v;
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of namesIn(v, namer)) {
    const end = m.index! + m[0].length;
    out.push(v.slice(at, end), <NameMark key={m.index!} f={namer.byName.get(m[0])!} />);
    at = end;
  }
  if (!out.length) return v;
  out.push(v.slice(at));
  return out;
}

function inline(nodes: Inline[], ctx: Ctx): ReactNode {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text": {
        // qa-simple-home-17: no space left between a word and its marker ("only [c:1]." reads "only¹.").
        const v = noRawTokens(nodes[i + 1]?.t === "cite" ? n.v.replace(/\s+$/, "") : n.v);
        return <Fragment key={i}>{withMarks(v, ctx.namer)}</Fragment>;
      }
      case "cite":
        return <Cite key={i} id={n.key} named={ctx.named} />;
      case "code":
        return <code key={i}>{n.v}</code>;
      case "strong":
        return (
          <b key={i} className="font-[650]">
            {inline(n.c, ctx)}
          </b>
        );
      case "em":
        return <em key={i}>{inline(n.c, ctx)}</em>;
      case "link":
        // A link's words carry no pill: a pill is a button, never inside a link.
        return isSafeHref(n.href) ? (
          <a key={i} href={n.href} className="font-semibold text-accent-ink underline">
            {inline(n.c, { ...ctx, namer: null })}
          </a>
        ) : (
          <Fragment key={i}>{inline(n.c, { ...ctx, namer: null })}</Fragment>
        );
      default:
        return null;
    }
  });
}

/** The answer's citations, for its markers. */
const Cites = createContext<AnswerCite[]>([]);

/** chat-citations: a footnote's own raised number, set off from the word and the number before it. */
const SUP = "ml-[3px] text-[11px] leading-none font-semibold";

/**
 * qa4-simple-home-3: a marker is a link to its own source, named for a screen reader ("Source 1:
 * Open Goal on the roadmap"); a marker with no source to open shows no number at all. A live
 * read (`l.n`) is numbered after the context's citations and named for the read; it has no
 * page in Oracle to open.
 */
function Cite({ id, named }: { id: string; named: Set<string> }) {
  const cites = useContext(Cites);
  const zone = useCompanyZone();
  const read = /^l\.(\d{1,4})$/.exec(id)?.[1];
  if (read) {
    const c = cites.find((x) => x.kind === "live" && x.ref === `l:${read}`);
    if (!c) return null;
    const after = Math.max(0, ...cites.map((x) => (x.kind !== "live" && typeof x.n === "number" ? x.n : 0)));
    const num = after + Number(read);
    const words = [c.source || "Meeting notes", c.read_at && `read ${chatTime(c.read_at, zone)}`].filter(Boolean).join(" · ");
    return (
      <sup className={SUP}>
        <span data-testid="answer-cite" data-n={num} aria-label={`Source ${num}: ${words}`} title={words} className="text-accent-ink">
          {num}
        </span>
      </sup>
    );
  }
  if (!/^\d{1,4}$/.test(id)) return null;
  const num = id;
  const c = cites.find((x) => x.kind !== "live" && String(x.n) === num);
  const s = c ? source(c) : null;
  if (!s?.url) return null;
  return (
    <>
      <sup className={SUP}>
        <Link href={s.url} data-testid="answer-cite" data-n={num} aria-label={`Source ${num}: ${s.words}`} title={s.words} className="text-accent-ink hover:underline">
          {num}
        </Link>
      </sup>
      <CiteMark id={id} named={named} />
    </>
  );
}

/**
 * A feature (or the roadmap item standing for one) a marker cites: its Current-state pill, after
 * the marker, unless the block names it in words (its pill is right after its name there).
 */
function CiteMark({ id, named }: { id: string; named: Set<string> }) {
  const marks = useContext(FeatureMarks);
  const c = useContext(Cites).find((x) => x.kind !== "live" && String(x.n) === id);
  const mark = c && markOf(c);
  const f = c && marks ? featureOf(marks, c) : undefined;
  if (!mark || (f && named.has(f.feature_id))) return null;
  return (
    <span className="ml-1.5 inline-flex align-middle empty:hidden" data-testid="answer-mark">
      <MarkFor {...mark} />
    </span>
  );
}

/** The feature a citation names, by its id (a baseline feature) or its roadmap item's id. */
function markOf(c: AnswerCite): { featureId?: string; itemId?: string } | null {
  if (!c.ref) return null;
  if (c.kind === "roadmap_item") return { itemId: c.ref };
  if (c.kind === "entity" && String(c.title ?? "").startsWith("Feature: ")) return { featureId: c.ref };
  return null;
}

/** The feature's state a citation stands for, from the read marks. */
function featureOf(marks: Map<string, FeatureState>, c: AnswerCite): FeatureState | undefined {
  const m = c.kind !== "live" ? markOf(c) : null;
  return m?.featureId ? marks.get(m.featureId) : m?.itemId ? marks.get(`item:${m.itemId}`) : undefined;
}

/**
 * The answer's text as the pick draws it: title, lines, labels over short lists. Every feature
 * it names carries its Current-state pill right after its name (cs2-b, the owner's later pick),
 * in the title and in its lines; a cited feature not named in words carries it after its marker.
 */
export function AnswerText({ text, live = false, cites = [] }: { text: string; live?: boolean; cites?: AnswerCite[] }) {
  // The states are read for every answer: any line may name a feature.
  return (
    <Cites.Provider value={cites}>
      <WithFeatureMarks>
        <AnswerBody text={text} live={live} cites={cites} />
      </WithFeatureMarks>
    </Cites.Provider>
  );
}

function AnswerBody({ text, live, cites }: { text: string; live: boolean; cites: AnswerCite[] }) {
  const marks = useContext(FeatureMarks);
  const namer = useMemo(() => namerOf(marks, cites), [marks, cites]);
  const blocks = parseBlocks(answerWords(text, live));
  const title = titleOf(blocks[0]);
  const rest = title ? blocks.slice(1) : blocks;
  const out: ReactNode[] = [];
  if (title) {
    const ctx = ctxOf(title.c, namer);
    out.push(
      <p key="t" className="text-base leading-[22px] font-[650]" data-testid="answer-title">
        {inline(title.c, ctx)}
        {title.cites.map((id) => (
          <CiteMark key={id} id={id} named={ctx.named} />
        ))}
      </p>,
    );
  }
  rest.forEach((b, i) => {
    // As the pick spaces them: a line after a line (or the title, or a label) 6 px down; after a list, none.
    const prev = i === 0 ? (title ? "p" : null) : rest[i - 1].t;
    const after = prev === "p" || prev === "h";
    if (b.t === "h")
      out.push(
        <p key={i} className="mt-2 text-xs leading-4 font-semibold tracking-[.06em] text-text2 uppercase" data-testid="answer-label">
          {inline(b.c, ctxOf(b.c, null))}
        </p>,
      );
    else if (b.t === "ul" || b.t === "ol") {
      const List = b.t;
      out.push(
        <List key={i} className={`mt-0.5 pl-[18px] ${b.t === "ul" ? "list-disc" : "list-decimal"}`}>
          {b.items.map((it, j) => (
            <li key={j} className="my-px">
              {inline(it, ctxOf(it, namer))}
            </li>
          ))}
        </List>,
      );
    } else if (b.t === "pre")
      out.push(
        <pre key={i} className={`${after ? "mt-1.5" : ""} font-sans whitespace-pre-wrap`}>
          {b.v}
        </pre>
      );
    else if (b.t === "table")
      out.push(
        <ul key={i} className="mt-0.5 list-disc pl-[18px]">
          {b.rows.map((r, j) => {
            const ctx = ctxOf(r.flat(), namer);
            return (
              <li key={j} className="my-px">
                {r.map((c, k) => (
                  <Fragment key={k}>
                    {k > 0 && " · "}
                    {inline(c, ctx)}
                  </Fragment>
                ))}
              </li>
            );
          })}
        </ul>,
      );
    else {
      const c = "c" in b ? b.c : [];
      out.push(
        <p key={i} className={`${after ? "mt-1.5" : ""} whitespace-pre-wrap`}>
          {inline(c, ctxOf(c, namer))}
        </p>,
      );
    }
  });
  return <div data-testid="chat-message-body">{out}</div>;
}

/** One source under an answer: an icon, its words, a link when it has one. */
function source(c: AnswerCite): { key: string; icon: "prds" | "roadmap" | "flag" | "link"; words: string; url: string | null } | null {
  const title = String(c.title ?? c.label ?? "").trim();
  if (!title) return null;
  const after = (s: string) => s.slice(s.indexOf(": ") + 2);
  const url = c.url && isSafeHref(c.url) ? c.url : null;
  switch (c.kind) {
    case "simple_source":
      return { key: title, icon: title.startsWith("From the roadmap") ? "roadmap" : "prds", words: title, url };
    case "section":
    case "document":
      return { key: title, icon: "prds", words: `From the PRD · ${title.includes(": ") ? after(title) : title}`, url };
    case "roadmap_item":
    case "milestone":
      return { key: title, icon: "roadmap", words: `Open ${title.includes(": ") ? after(title) : title} on the roadmap`, url };
    case "decision":
      return { key: title, icon: "flag", words: `Open ${title}`, url };
    case "live":
      return null;
    default:
      return { key: title, icon: "link", words: title, url };
  }
}

/** Where the answer comes from, under it: one link per source (PRD first, then the roadmap). */
export function AnswerSources({ cites }: { cites: AnswerCite[] }) {
  const seen = new Set<string>();
  const rank = { prds: 0, roadmap: 1, flag: 2, link: 3 } as const;
  const list = cites
    .map(source)
    .filter((s): s is NonNullable<ReturnType<typeof source>> => !!s && !seen.has(s.words) && !!seen.add(s.words))
    .sort((a, b) => rank[a.icon] - rank[b.icon]);
  if (list.length === 0) return null;
  return (
    <p className="mt-2.5 flex flex-wrap gap-x-3.5 gap-y-1" data-testid="answer-sources">
      {list.map((s) => {
        const inner = (
          <>
            <Icon name={s.icon} size={16} stroke={2} className="size-3.5" />
            {s.words}
          </>
        );
        const cls = "inline-flex items-center gap-1.5 text-[13px] leading-[18px] font-semibold text-accent-ink";
        return s.url ? (
          <Link key={s.key} href={s.url} className={`${cls} hover:underline`} data-testid="answer-source">
            {inner}
          </Link>
        ) : (
          <span key={s.key} className={cls} data-testid="answer-source">
            {inner}
          </span>
        );
      })}
    </p>
  );
}
