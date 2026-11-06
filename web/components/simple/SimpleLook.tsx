"use client";

/**
 * MOCK-HOOK (mk-prd-look PS1, mock-ups only, never merged): five ways a PRD reads on the Simple
 * side, behind ?ps1=a|b|c|d|e on /simple/one-pagers and /simple/one-pagers/<doc>. The one-pager
 * keeps every block, line, action and note; each look adds the PRD's own sections, read as
 * written (the version the one-pager reads), with each feature code opening the feature panel.
 * The whole file is mock-up code.
 *   a  Calm page: the one-pager, then the whole PRD in one calm column with a contents list.
 *   b  Cards: each block and each PRD section a card with a header bar.
 *   c  Summary first: a strip of the PRD's numbers, then the one-pager, then the PRD in parts, folded.
 *   d  Questions: each block asks its question; the PRD's sections behind it open under the answer.
 *   e  Printed pages: the one-pager and the PRD as printed sheets on a desk, the PDF's look.
 */
import { useSearchParams } from "next/navigation";
import { Fragment, useMemo, useState, type ReactNode } from "react";

import { numbersOf } from "@/components/PrdLook";
import { useOpenFeature } from "@/components/simple/OpenFeature";
import { api, unwrap, type Schemas, type SectionOut } from "@/lib/api/client";
import { buildCodeIndex, splitCodes, type CodeIndex } from "@/lib/code-index";
import { parseBlocks, type Inline } from "@/lib/markdown";
import { useQuery } from "@/lib/use-query";

import "./SimpleLook.css"; // MOCK-HOOK

export type Ps1 = "a" | "b" | "c" | "d" | "e"; // MOCK-HOOK

/** MOCK-HOOK: the look from the address (?ps1=a…e), null without one. */
export function usePs1(): Ps1 | null {
  const v = useSearchParams().get("ps1"); // MOCK-HOOK
  return v && v.length === 1 && "abcde".includes(v) ? (v as Ps1) : null; // MOCK-HOOK
}

/** MOCK-HOOK: a link inside Simple that keeps the look. */
export const withPs1 = (href: string, look: Ps1 | null) => (look ? `${href}${href.includes("?") ? "&" : "?"}ps1=${look}` : href); // MOCK-HOOK

type View = Schemas["OnePagerOut"];
type Block = View["blocks"][number];
type Doc = { id: string; slug: string };

/** MOCK-HOOK (d): each block's question. */
const QUESTION: Record<string, string> = {
  problem: "What problem are we solving, and for whom?",
  bets: "What will we build?",
  outcomes: "How will we know it worked?",
  not_doing: "What are we not doing?",
  risks: "What could go wrong?",
  timeline: "When does it ship?",
};
export const ps1Title = (look: Ps1 | null, b: Block) => (look === "d" ? (QUESTION[b.key] ?? b.title) : b.title); // MOCK-HOOK

/** MOCK-HOOK: the parts of a PRD (c, e), by section key; a key no part names follows the one before it. */
type Part = "why" | "what" | "when" | "risks" | "sources";
const PART_NAME: Record<Part, string> = { why: "Why", what: "What we build", when: "When it ships", risks: "Risks and decisions", sources: "Sources" };
const PART_OF: Record<string, Part> = {
  summary: "why", "goal-trace": "why", problem: "why", "problem-alignment": "why", audience: "why", "why-now": "why", success: "why",
  "brief-items": "what", "non-goals": "what", "solution-alignment": "what", approach: "what", features: "what", flows: "what", requirements: "what", "edge-cases": "what", "feature-detail": "what",
  "brief-roadmap": "when", milestones: "when", launch: "when", recap: "when",
  "top-risks": "risks", decisions: "risks", risks: "risks",
  sources: "sources", "sources-list": "sources", "sources-data": "sources", "sources-evidence": "sources",
};
const partOf = (key: string): Part | null => PART_OF[key] ?? (key.startsWith("feature-") ? "what" : key.startsWith("milestone-") ? "when" : null);

/** MOCK-HOOK (d): the PRD sections each block's question also reads (beside the ones its lines come from). */
const ASKS: Record<string, string[]> = {
  problem: ["problem", "audience", "why-now"],
  bets: ["brief-items", "features", "requirements"],
  outcomes: ["success", "goal-trace"],
  not_doing: ["non-goals"],
  risks: ["risks", "top-risks", "decisions"],
  timeline: ["milestones", "brief-roadmap", "launch"],
};

/** MOCK-HOOK: the PRD version the one-pager reads, every section (GET /v1/documents/{doc}/versions/{n}). */
function usePrd(v: View) {
  const q = useQuery(`ps1-prd|${v.document.slug}|${v.version}`, () => unwrap(api.GET("/v1/documents/{doc}/versions/{n}", { params: { path: { doc: v.document.slug, n: v.version } } })).catch(() => null)); // MOCK-HOOK
  const sections = useMemo(() => (q.data?.sections ?? []) as SectionOut[], [q.data]); // MOCK-HOOK
  const codes = useMemo(() => buildCodeIndex(sections.map((s) => ({ section_key: s.section_key, heading: s.heading, body_md: s.body_md }))), [sections]); // MOCK-HOOK
  const nums = useMemo(() => numbersOf(sections), [sections]); // MOCK-HOOK
  return { sections, codes, nums, loading: q.loading }; // MOCK-HOOK
}

/** MOCK-HOOK: a feature code, a button that opens the feature panel (its name in the label). */
function FeatureCode({ code, name, prd, children }: { code: string; name: string; prd: Doc; children?: ReactNode }) {
  const open = useOpenFeature(); // MOCK-HOOK
  if (!open) return <>{children ?? code}</>; // MOCK-HOOK
  return (
    <button type="button" className="ps1-code" title={`${code} ${name}`} aria-label={`Open ${code} ${name}`} onClick={() => open({ code, name, prd })}>
      {children ?? code}
    </button>
  );
}

/** MOCK-HOOK: a line's leading feature code as its own button (the line's words stay the line's). */
export function Ps1Lead({ look, text, prd }: { look: Ps1 | null; text: string; prd: Doc }) {
  const m = look ? /^([A-Z]{1,3}-\d+)\s+(.+)$/.exec(text) : null; // MOCK-HOOK
  if (!m) return null; // MOCK-HOOK
  return <FeatureCode code={m[1]} name={m[2]} prd={prd} />; // MOCK-HOOK
}
/** MOCK-HOOK: a line's words without the code its Ps1Lead shows. */
export const ps1Rest = (look: Ps1 | null, shown: ReactNode): ReactNode => (look && typeof shown === "string" ? shown.replace(/^[A-Z]{1,3}-\d+\s+(?=\S)/, "") : shown); // MOCK-HOOK

/** MOCK-HOOK: Markdown text as Simple reads it: feature codes open the panel, no citation tokens, links in the page. */
function Text({ c, codes, prd }: { c: Inline[]; codes: CodeIndex; prd: Doc }) {
  return (
    <>
      {c.map((n, i) => {
        if (n.t === "text")
          return (
            <Fragment key={i}>
              {splitCodes(n.v, codes).map((p, j) => (typeof p === "string" ? p : p.entry.kind === "Feature" ? <FeatureCode key={j} code={p.entry.code} name={p.entry.name} prd={prd}>{p.text}</FeatureCode> : <span key={j} title={`${p.entry.code} ${p.entry.name}`}>{p.text}</span>))}
            </Fragment>
          );
        if (n.t === "code") return <code key={i}>{n.v}</code>;
        if (n.t === "strong") return <strong key={i}><Text c={n.c} codes={codes} prd={prd} /></strong>;
        if (n.t === "em") return <em key={i}><Text c={n.c} codes={codes} prd={prd} /></em>;
        if (n.t === "link") {
          const words = n.c.map((x) => (x.t === "text" ? x.v : "")).join("");
          const f = /^([A-Z]{1,3}-\d+)\s+(.+)$/.exec(words);
          if (f && codes.get(f[1])?.kind === "Feature") return <FeatureCode key={i} code={f[1]} name={f[2]} prd={prd}>{words}</FeatureCode>;
          if (n.href.startsWith("#")) return <a key={i} href={`#ps1-sec-${n.href.slice(1)}`} className="ps1-link"><Text c={n.c} codes={codes} prd={prd} /></a>;
          return <a key={i} href={n.href} target="_blank" rel="noopener noreferrer" className="ps1-link"><Text c={n.c} codes={codes} prd={prd} /></a>;
        }
        return null; // a citation token or an image: not shown in Simple
      })}
    </>
  );
}

/** MOCK-HOOK: a section's body: paragraphs, lists, quotes and tables (a table scrolls across in its own box). */
function Body({ md, codes, prd }: { md: string; codes: CodeIndex; prd: Doc }) {
  const blocks = useMemo(() => parseBlocks(md), [md]); // MOCK-HOOK
  return (
    <div className="ps1-body">
      {blocks.map((b, i) => {
        if (b.t === "p") return <p key={i}><Text c={b.c} codes={codes} prd={prd} /></p>;
        if (b.t === "h") return <p key={i} className="ps1-subhead"><Text c={b.c} codes={codes} prd={prd} /></p>;
        if (b.t === "quote") return <blockquote key={i}><Text c={b.c} codes={codes} prd={prd} /></blockquote>;
        if (b.t === "pre") return <pre key={i}>{b.v}</pre>;
        if (b.t !== "table") {
          const items = b.items.map((it, j) => <li key={j}><Text c={it} codes={codes} prd={prd} /></li>);
          return b.t === "ul" ? <ul key={i}>{items}</ul> : <ol key={i}>{items}</ol>;
        }
        return (
          <div key={i} className="ps1-table" role="region" aria-label="Table" tabIndex={0}>
            <table>
              <thead><tr>{b.head.map((h, j) => <th key={j}><Text c={h} codes={codes} prd={prd} /></th>)}</tr></thead>
              <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}><Text c={c} codes={codes} prd={prd} /></td>)}</tr>)}</tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

const hasWords = (s: SectionOut) => /[\p{L}\p{N}]/u.test(s.body_md ?? "");
const plainHeading = (h: string) => h.replace(/\*\*/g, "");

/** MOCK-HOOK: one PRD section in the look's frame. */
function Sec({ s, num, codes, prd, look, fold }: { s: SectionOut; num?: string; codes: CodeIndex; prd: Doc; look: Ps1; fold?: boolean }) {
  const [whole, setWhole] = useState(false); // MOCK-HOOK
  const long = fold && (s.body_md ?? "").length > 420; // MOCK-HOOK
  const H = s.level <= 2 ? "h3" : "h4";
  return (
    <section id={`ps1-sec-${s.section_key}`} data-ps1-sec={s.section_key} data-level={s.level} className="ps1-sec" data-folded={long && !whole ? "" : undefined}>
      <header className="ps1-sec-head">
        <H className="ps1-sec-title">
          {num && look !== "b" && <span className="ps1-num">{num}</span>}
          {plainHeading(s.heading)}
        </H>
        {look === "b" && num && <span className="ps1-card-num">Section {num}</span>}
      </header>
      {hasWords(s) && <div className="ps1-sec-text"><Body md={s.body_md} codes={codes} prd={prd} /></div>}
      {long && (
        <button type="button" className="ps1-more" aria-expanded={whole} onClick={() => setWhole((x) => !x)}>
          {whole ? "Show less" : `Read all of ${plainHeading(s.heading)}`}
        </button>
      )}
    </section>
  );
}

/** MOCK-HOOK (c): the PRD's numbers over the page: its outcomes, bets, risks and next date, each a link to its block. */
export function Ps1Summary({ v }: { v: View }) {
  const metrics = v.blocks.find((b) => b.key === "outcomes")?.lines.filter((l) => l.metric).slice(0, 2) ?? []; // MOCK-HOOK
  const count = (k: string) => v.blocks.find((b) => b.key === k)?.lines.length ?? 0; // MOCK-HOOK
  const next = [...v.timeline].filter((t) => t.end).sort((a, b) => String(a.end).localeCompare(String(b.end)))[0]; // MOCK-HOOK
  const md = (iso?: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : ""); // MOCK-HOOK
  return (
    <div className="ps1-summary simple-noprint" role="list" aria-label="This PRD in numbers">
      {metrics.map((l) => (
        <a role="listitem" key={l.id} href="#ps1-b-outcomes" className="ps1-tile">
          <span className="ps1-tile-big">{l.metric!.from} → {l.metric!.to}</span>
          <span className="ps1-tile-label">{l.metric!.name}</span>
        </a>
      ))}
      <a role="listitem" href="#ps1-b-bets" className="ps1-tile"><span className="ps1-tile-big">{count("bets")}</span><span className="ps1-tile-label">Bets we will build</span></a>
      <a role="listitem" href="#ps1-b-risks" className="ps1-tile"><span className="ps1-tile-big">{count("risks")}</span><span className="ps1-tile-label">Risks and open decisions</span></a>
      {next && (
        <a role="listitem" href="#ps1-b-timeline" className="ps1-tile"><span className="ps1-tile-big">{md(next.end)}</span><span className="ps1-tile-label">First delivery: {next.title}</span></a>
      )}
    </div>
  );
}

/** MOCK-HOOK (d): under an answer, the PRD's sections it rests on, folded until asked. */
export function Ps1FromPrd({ v, block }: { v: View; block: Block }) {
  const { sections, codes } = usePrd(v); // MOCK-HOOK
  const [open, setOpen] = useState(false); // MOCK-HOOK
  const keys = [...new Set([...block.lines.flatMap((l) => l.source_keys), ...(ASKS[block.key] ?? [])])]; // MOCK-HOOK
  const secs = keys.map((k) => sections.find((s) => s.section_key === k)).filter((s): s is SectionOut => !!s && hasWords(s)); // MOCK-HOOK
  if (!secs.length) return null; // MOCK-HOOK
  return (
    <div className="ps1-from simple-noprint" data-ps1-from={block.key}>
      <button type="button" className="ps1-from-toggle" aria-expanded={open} onClick={() => setOpen((x) => !x)}>
        {open ? "Hide the PRD's words" : `Read it in the PRD: ${secs.map((s) => plainHeading(s.heading)).join(", ")}`}
      </button>
      {open && secs.map((s) => <Sec key={s.section_key} s={s} codes={codes} prd={v.document} look="d" />)}
    </div>
  );
}

/** MOCK-HOOK: the questions list (d) or the contents (a), each a link in the page. */
export function Ps1Nav({ v, look }: { v: View; look: Ps1 }) {
  const { sections, nums } = usePrd(v); // MOCK-HOOK
  if (look === "d")
    return (
      <nav className="ps1-nav simple-noprint" aria-label="Questions">
        <p className="ps1-nav-title">Questions</p>
        {v.blocks.map((b) => <a key={b.key} href={`#ps1-b-${b.key}`}>{QUESTION[b.key] ?? b.title}</a>)}
        <a href="#ps1-rest">What else is in the PRD?</a>
      </nav>
    );
  return (
    <nav className="ps1-nav simple-noprint" aria-label="Contents">
      <p className="ps1-nav-title">On one page</p>
      {v.blocks.map((b) => <a key={b.key} href={`#ps1-b-${b.key}`}>{b.title}</a>)}
      <p className="ps1-nav-title">The whole PRD</p>
      {sections.filter((s) => s.level === 2).map((s) => (
        <a key={s.section_key} href={`#ps1-sec-${s.section_key}`} title={plainHeading(s.heading)}><span className="ps1-num">{nums.get(s.section_key)}</span>{plainHeading(s.heading)}</a>
      ))}
    </nav>
  );
}

/** MOCK-HOOK: the whole PRD under the one-pager, in the look's frame (d: only what no question reads). */
export function Ps1Reader({ v, look }: { v: View; look: Ps1 }) {
  const { sections, codes, nums, loading } = usePrd(v); // MOCK-HOOK
  if (loading && !sections.length) return null; // MOCK-HOOK
  const read = sections.filter((s) => s.level >= 2 || hasWords(s)).filter((s) => s.section_key !== "title"); // MOCK-HOOK
  if (look === "d") {
    const asked = new Set([...v.blocks.flatMap((b) => b.lines.flatMap((l) => l.source_keys)), ...Object.values(ASKS).flat()]); // MOCK-HOOK
    const rest = read.filter((s) => s.level >= 2 && !asked.has(s.section_key) && hasWords(s)); // MOCK-HOOK
    return (
      <div id="ps1-rest" className="ps1-reader" data-ps1-reader="d">
        <h2 className="ps1-reader-title">What else is in the PRD?</h2>
        <ul className="ps1-rest-list">
          {rest.map((s) => (
            <li key={s.section_key}>
              <details>
                <summary>{plainHeading(s.heading)}</summary>
                <Sec s={s} codes={codes} prd={v.document} look="d" />
              </details>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (look === "c" || look === "e") {
    // In parts: Why, What we build, When it ships, Risks and decisions, Sources (a key no part names follows the one before it).
    const parts: { part: Part; secs: SectionOut[] }[] = [];
    let at: Part = "why";
    for (const s of read) {
      if (s.level <= 1) continue;
      at = partOf(s.section_key) ?? at;
      const last = parts.at(-1);
      if (last?.part === at) last.secs.push(s);
      else parts.push({ part: at, secs: [s] });
    }
    return (
      <div className="ps1-reader" data-ps1-reader={look}>
        {look === "c" && <h2 className="ps1-reader-title">The whole PRD, in parts</h2>}
        {parts.map((p, i) => (
          <div key={i} className="ps1-part" data-part={p.part}>
            <h2 className="ps1-part-title">{look === "e" && <span className="ps1-page">Page {i + 2}</span>}{PART_NAME[p.part]}</h2>
            {p.secs.map((s) => <Sec key={s.section_key} s={s} num={nums.get(s.section_key)} codes={codes} prd={v.document} look={look} fold={look === "c"} />)}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="ps1-reader" data-ps1-reader={look}>
      <h2 className="ps1-reader-title">The whole PRD</h2>
      {read.filter((s) => s.level >= 2).map((s) => <Sec key={s.section_key} s={s} num={nums.get(s.section_key)} codes={codes} prd={v.document} look={look} />)}
    </div>
  );
}
