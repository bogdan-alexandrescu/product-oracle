"use client";

/**
 * PS1 a "Calm page": the one-pager keeps every block, line and action, and the whole PRD it is
 * built from reads under it in one calm column, numbered as the Detailed side numbers it (PT1's
 * numbersOf), with a contents list beside it. A feature code opens the feature panel.
 */
import { Fragment, useEffect, useMemo, useRef, type ReactNode } from "react";

import { withDays } from "@/components/MarkdownBody";
import { numbersOf, ownNumber } from "@/components/PrdLook";
import { NotInGt } from "@/components/simple/FeatureName";
import { useOpenFeature } from "@/components/simple/OpenFeature";
import { api, unwrap, type Schemas, type SectionOut } from "@/lib/api/client";
import { buildCodeIndex, lookupCode, nameCodes, splitCodes, type CodeIndex } from "@/lib/code-index";
import { parseBlocks, type Inline } from "@/lib/markdown";
import { stripRawTokens } from "@/lib/raw-tokens";
import { useQuery } from "@/lib/use-query";

import "./SimplePrd.css";

type View = Schemas["OnePagerOut"];
type Doc = { id: string; slug: string };

const plainHeading = (h: string) => stripRawTokens(h.replace(/\*\*/g, ""));
/** A heading beside its number: a number it carries itself is shown once. */
const titleOf = (h: string) => { const t = plainHeading(h); return ownNumber(t)?.rest ?? t; };
const hasWords = (s: SectionOut) => /[\p{L}\p{N}]/u.test(s.body_md ?? "");

/** A table row that gives a code and its name ("| F-26 | Calendar invites |") names that code, as the one-pager reads it. */
function withTableNames(index: CodeIndex, sections: SectionOut[]): CodeIndex {
  for (const s of sections)
    for (const line of (s.body_md ?? "").split("\n")) {
      const cells = line.trim().startsWith("|") ? line.split("|").map((c) => c.replace(/\*\*/g, "").trim()) : [];
      const [code, name] = [cells[1], cells[2]];
      if (!code || !name || !/^[A-Z]{1,3}-\d+$/.test(code) || !/^\p{Lu}/u.test(name) || index.has(code)) continue;
      index.set(code, { code, kind: code.startsWith("F") ? "Feature" : code.startsWith("M") ? "Milestone" : "Section", name, sectionKey: s.section_key, from: "this PRD" });
    }
  return index;
}

/** The PRD version the one-pager reads, every section (GET /v1/documents/{doc}/versions/{n}). */
export function usePrdSections(doc: string | null, n: number) {
  const q = useQuery(`simple-prd|${doc}|${n}`, () =>
    doc ? unwrap(api.GET("/v1/documents/{doc}/versions/{n}", { params: { path: { doc, n } } })).catch(() => null) : Promise.resolve(null),
  );
  const sections = useMemo(() => (q.data?.sections ?? []) as SectionOut[], [q.data]);
  const codes = useMemo(() => withTableNames(buildCodeIndex(sections.map((s) => ({ section_key: s.section_key, heading: s.heading, body_md: s.body_md }))), sections), [sections]);
  const nums = useMemo(() => numbersOf(sections), [sections]);
  return { sections, codes, nums, loading: q.loading };
}

export type PrdSections = ReturnType<typeof usePrdSections>;

/** A feature code: a button that opens the feature panel, its name in its label. */
function FeatureCode({ code, name, prd, children }: { code: string; name: string; prd: Doc; children?: ReactNode }) {
  const open = useOpenFeature();
  if (!open) return <>{children ?? code}</>;
  return (
    <button type="button" className="simple-prd-code" title={`${code} ${name}`} aria-label={`Open ${code} ${name}`} onClick={() => open({ code, name, prd })}>
      {children ?? code}
    </button>
  );
}

const LEAD = /^([A-Z]{1,3}-\d+)\s+(?=\S)/;

/** A line that starts with a feature code the PRD names: the code as its own button, in its own column. */
export function LeadCode({ text, codes, prd }: { text: string; codes: CodeIndex; prd: Doc }) {
  const m = LEAD.exec(text);
  const entry = m ? lookupCode(m[1], codes) : undefined;
  if (!m || entry?.kind !== "Feature") return null;
  return <FeatureCode code={entry.code} name={entry.name} prd={prd} />;
}
/** The line's words without the code LeadCode shows. */
export function leadRest(text: string, codes: CodeIndex): string {
  const m = LEAD.exec(text);
  // A space kept before the words: the line's text still reads "F-26 Calendar invites …" as one.
  return m && lookupCode(m[1], codes)?.kind === "Feature" ? ` ${text.slice(m[0].length)}` : text;
}

/** Markdown text as Simple reads it: a code with its name, a feature code opens the panel, no citation tokens. */
function Text({ c, codes, prd, named = false }: { c: Inline[]; codes: CodeIndex; prd: Doc; named?: boolean }) {
  return (
    <>
      {c.map((n, i) => {
        if (n.t === "text")
          return (
            <Fragment key={i}>
              {/* OP9: a day in the prose reads month first ("needed by Nov 1, 2026"), as MarkdownBody reads it. */}
              {withDays(stripRawTokens(named ? n.v : nameCodes(n.v, codes, null)), codes, `t${i}`, (words, _, k) =>
                splitCodes(words, codes).map((p, j) =>
                  typeof p === "string" ? p : p.entry.kind === "Feature" ? <FeatureCode key={`${k}-${j}`} code={p.entry.code} name={p.entry.name} prd={prd}>{p.text}</FeatureCode> : <span key={`${k}-${j}`} title={`${p.entry.code} ${p.entry.name}`}>{p.text}</span>,
                ),
              )}
            </Fragment>
          );
        if (n.t === "code") return <code key={i}>{n.v}</code>;
        if (n.t === "strong") return <strong key={i}><Text c={n.c} codes={codes} prd={prd} /></strong>;
        if (n.t === "em") return <em key={i}><Text c={n.c} codes={codes} prd={prd} /></em>;
        if (n.t === "link") {
          if (n.href.startsWith("#")) return <a key={i} href={`#prd-sec-${n.href.slice(1)}`} className="simple-prd-link"><Text c={n.c} codes={codes} prd={prd} /></a>;
          return <a key={i} href={n.href} target="_blank" rel="noopener noreferrer" className="simple-prd-link"><Text c={n.c} codes={codes} prd={prd} /></a>;
        }
        return null; // a citation token or an image: not shown in Simple
      })}
    </>
  );
}

const cellText = (c: Inline[]) => c.map((x) => (x.t === "text" || x.t === "code" ? x.v : "")).join("").trim();
/** A cell that is a code alone, in a row whose other cell gives its name ("| F-26 | Calendar invites |"): named already. */
function namedInRow(cell: Inline[], row: Inline[][], codes: CodeIndex): boolean {
  const name = lookupCode(cellText(cell), codes)?.name;
  return !!name && row.some((x) => x !== cell && cellText(x) === name);
}

/** A cell's words, inside its links and bold too. */
const plainOf = (c: Inline[]): string => c.map((x) => (x.t === "text" || x.t === "code" ? x.v : x.t === "strong" || x.t === "em" || x.t === "link" ? plainOf(x.c) : "")).join("");
/** A feature code leading a cell or heading ("F-26 Calendar invites", "F-26"). */
const LEADS_CODE = /^[A-Z]{1,3}-\d+[a-z]?(?![\w-])/;
/** OP10: a table's feature column ("| Milestone | Feature |"), by its heading; -1 when none. */
const featureColumn = (head: Inline[][]) => head.findIndex((h) => /^features?$/i.test(plainOf(h).trim()));
/** OP10: a feature named with no code anywhere in its row is not in the Ground Truth. */
const uncoded = (cell: Inline[], row: Inline[][]) => !!plainOf(cell).trim() && !row.some((c) => LEADS_CODE.test(plainOf(c).trim()));

/** A section's body: paragraphs, lists, quotes and tables (a table scrolls across in its own box). */
function Body({ md, codes, prd }: { md: string; codes: CodeIndex; prd: Doc }) {
  const blocks = useMemo(() => parseBlocks(md), [md]);
  return (
    <div className="simple-prd-body" data-section-body>
      {blocks.map((b, i) => {
        if (b.t === "p") return <p key={i}><Text c={b.c} codes={codes} prd={prd} /></p>;
        if (b.t === "h") return <p key={i} className="simple-prd-subhead"><Text c={b.c} codes={codes} prd={prd} /></p>;
        if (b.t === "quote") return <blockquote key={i}><Text c={b.c} codes={codes} prd={prd} /></blockquote>;
        if (b.t === "pre") return <pre key={i}>{b.v}</pre>;
        if (b.t !== "table") {
          const items = b.items.map((it, j) => <li key={j}><Text c={it} codes={codes} prd={prd} /></li>);
          return b.t === "ul" ? <ul key={i}>{items}</ul> : <ol key={i}>{items}</ol>;
        }
        const fcol = featureColumn(b.head);
        return (
          <div key={i} className="simple-prd-table" role="region" aria-label="Table" tabIndex={0}>
            <table>
              <thead><tr>{b.head.map((h, j) => <th key={j}><Text c={h} codes={codes} prd={prd} /></th>)}</tr></thead>
              <tbody>
                {b.rows.map((r, j) => (
                  <tr key={j}>
                    {r.map((c, k) => (
                      <td key={k}>
                        <Text c={c} codes={codes} prd={prd} named={namedInRow(c, r, codes)} />
                        {k === fcol && uncoded(c, r) && <NotInGt />}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

/** The contents beside the page: the one-pager's blocks, then the whole PRD's sections, each a link in the page. */
export function PrdContents({ prd, blocks }: { prd: PrdSections; blocks: View["blocks"] }) {
  const { sections, nums } = prd;
  const top = sections.filter((s) => s.level === 2);
  const ref = useRef<HTMLElement>(null);
  // The jump offset follows the sticky row's real height, which grows as its tabs wrap.
  useEffect(() => {
    const nav = ref.current;
    const host = nav?.parentElement;
    if (!nav || !host) return;
    const set = () => host.style.setProperty("--prd-nav-h", `${Math.ceil(nav.getBoundingClientRect().height)}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(nav);
    return () => { ro.disconnect(); host.style.removeProperty("--prd-nav-h"); };
  }, []);
  return (
    <nav ref={ref} className="simple-prd-nav simple-noprint" aria-label="Contents">
      <p className="simple-prd-nav-title">On one page</p>
      {blocks.map((b) => <a key={b.key} href={`#op-${b.key}`}>{b.title}</a>)}
      {top.length > 0 && <p className="simple-prd-nav-title">The whole PRD</p>}
      {top.map((s) => (
        <a key={s.section_key} href={`#prd-sec-${s.section_key}`} title={plainHeading(s.heading)}>
          <span className="simple-prd-num">{nums.get(s.section_key)}</span><span className="sr-only"> </span>
          {titleOf(s.heading)}
        </a>
      ))}
    </nav>
  );
}

/** The whole PRD under the one-pager: each section numbered, read as written. */
export function PrdWhole({ prd, doc }: { prd: PrdSections; doc: Doc }) {
  const { sections, codes, nums } = prd;
  const read = sections.filter((s) => s.level >= 2);
  if (!read.length) return null;
  return (
    <div className="simple-prd-whole simple-noprint" data-testid="prd-whole">
      <h2 className="simple-prd-whole-title">The whole PRD</h2>
      {read.map((s) => {
        const H = s.level <= 2 ? "h3" : "h4";
        return (
          <section key={s.section_key} id={`prd-sec-${s.section_key}`} data-prd-sec={s.section_key} data-level={s.level} className="simple-prd-sec">
            <H className="simple-prd-sec-title" data-user-content>
              {nums.get(s.section_key) && <><span className="simple-prd-num">{nums.get(s.section_key)}</span><span className="sr-only"> </span></>}
              {titleOf(s.heading)}
              {/* OP10: a feature's own section (9.1 Save cart) whose heading gives no code is flagged. */}
              {s.level >= 3 && /^feature-/.test(s.section_key) && !LEADS_CODE.test(titleOf(s.heading).trim()) && <NotInGt />}
            </H>
            {hasWords(s) && <Body md={s.body_md} codes={codes} prd={doc} />}
          </section>
        );
      })}
    </div>
  );
}
