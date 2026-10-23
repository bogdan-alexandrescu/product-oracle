import Link from "next/link";
import { Fragment, type ReactNode } from "react";

import { CitationChip } from "@/components/CitationChip";
import { DateMarker } from "@/components/DateMarker";
import { withCodes } from "@/components/ds/CodeChip";
import { IGNORE_ATTR } from "@/lib/anchor";
import type { CitationOut, DateMarkOut } from "@/lib/api/client";
import type { CodeIndex } from "@/lib/code-index";
import { isSafeHref, storedImageSrc, type Block, type Inline } from "@/lib/markdown";
import { sectionHash, sectionHref } from "@/lib/section-link";

/** A highlighted span of a section's anchorable text. */
export type Highlight = { start: number; end: number; id: string; kind: "comment" | "pending" };

/**
 * O1f: in the brief, a link to a detail section (`[Save cart](#feature-save-cart)` in a
 * feature row or milestone) gets an Expand control that shows that section in place:
 * under its table row, list item or paragraph.
 */
export type ExpandCtx = {
  keys: Set<string>;
  /** Open detail section -> the brief section it is shown in (one place at a time). */
  open: Map<string, string>;
  /** The brief section being rendered. */
  origin: string;
  toggle: (key: string, origin: string) => void;
  render: (key: string) => ReactNode;
};

type Ctx = {
  pos: number;
  highlights: Highlight[];
  activeId: string | null;
  citations: Map<string, { citation: CitationOut; number: number }>;
  onHighlightClick?: (id: string) => void;
  expand?: ExpandCtx;
  /** Detail sections linked from the block being rendered, in order. */
  found: string[];
  /** Detail sections already shown in this body (a key linked twice shows once). */
  shown: Set<string>;
  /**
   * O4 'document dates': this section's dates that rest on no verified basis now. Each
   * gets its marker ("unverified", "date withdrawn") after it; the text is unchanged.
   */
  dateMarks?: DateMarkOut[];
  /**
   * #305: the codes this version names (built once per version). A known code in prose
   * gets the shared card; code spans, code blocks and link text are left as written.
   */
  codes?: CodeIndex;
  /** Inside link text: a code there is not drawn as a button. */
  inLink?: boolean;
};

const ignore = { [IGNORE_ATTR]: "" };

/**
 * O4b: a cross-document link to a version's section, as a roadmap draft links each item
 * to its PRD section: `/documents/<slug>/v/<n>#<section>`.
 */
const DOC_LINK = /^\/documents\/([A-Za-z0-9][\w.-]*)\/v\/(\d+)(?:#([A-Za-z0-9][\w.:-]*))?$/;

/** The app's path for a cross-document link: the version view, at the section. */
function docLinkHref(href: string): string | null {
  const m = DOC_LINK.exec(href);
  return m ? sectionHref(m[1], Number(m[2]), m[3]) : null;
}

/** The host of an http(s) URL, or null (a remote image is shown as a link, never loaded). */
function remoteHost(src: string): string | null {
  if (/[\\\u0000-\x20\u007f-\u009f]/.test(src)) return null;
  try {
    const u = new URL(src);
    return u.protocol === "https:" || u.protocol === "http:" ? u.hostname : null;
  } catch {
    return null;
  }
}

function label(nodes: Inline[]): string {
  return nodes
    .map((n) => (n.t === "text" || n.t === "code" ? n.v : n.t === "cite" || n.t === "img" ? "" : label(n.c)))
    .join("");
}

/** The detail sections opened from the links of the block just rendered. */
function opened(ctx: Ctx): string[] {
  const keys = ctx.found.filter((k) => isOpen(ctx, k) && !ctx.shown.has(k));
  keys.forEach((k) => ctx.shown.add(k));
  ctx.found = [];
  return keys;
}

function isOpen(ctx: Ctx, key: string): boolean {
  return !!ctx.expand && ctx.expand.open.get(key) === ctx.expand.origin;
}

function renderText(text: string, ctx: Ctx, key: string, prose = false): ReactNode {
  const start = ctx.pos;
  const end = start + text.length;
  ctx.pos = end;
  const codes = prose && !ctx.inLink ? ctx.codes : undefined;
  const hits = ctx.highlights.filter((h) => h.start < end && h.end > start);
  if (!hits.length) return withCodes(text, codes, key);
  const cuts = new Set([start, end]);
  for (const h of hits) {
    if (h.start > start) cuts.add(h.start);
    if (h.end < end) cuts.add(h.end);
  }
  const points = [...cuts].sort((a, b) => a - b);
  const out: ReactNode[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const slice = text.slice(a - start, b - start);
    const covering = hits.filter((h) => h.start <= a && h.end >= b);
    if (!covering.length) {
      out.push(<Fragment key={`${key}-${i}`}>{withCodes(slice, codes, `${key}-${i}`)}</Fragment>);
      continue;
    }
    const pending = covering.some((h) => h.kind === "pending");
    const ids = covering.filter((h) => h.kind === "comment").map((h) => h.id);
    const active = ctx.activeId != null && ids.includes(ctx.activeId);
    out.push(
      <mark
        key={`${key}-${i}`}
        data-comment-ids={ids.join(" ") || undefined}
        className={pending ? "hl-pending" : active ? "hl-comment hl-active" : "hl-comment"}
        onClick={ids.length && ctx.onHighlightClick ? () => ctx.onHighlightClick!(ids[0]) : undefined}
      >
        {slice}
      </mark>,
    );
  }
  return out;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// F3: the marker opens a popover (./DateMarker).
export { DateMarker };

/**
 * Text (prose, a code span or a code block) with the marker after each flagged date (O4
 * 'document dates'). A date the text writes across emphasis or an entity is not in one
 * text node: SectionView lists those under the heading instead (`unplacedMarks`).
 */
function renderMarkedText(text: string, ctx: Ctx, key: string, prose = false): ReactNode {
  const marks = (ctx.dateMarks ?? []).filter((m) => m.label && m.where !== "heading" && text.includes(m.text));
  if (!marks.length) return renderText(text, ctx, key, prose);
  const byText = new Map(marks.map((m) => [m.text, m]));
  const re = new RegExp(`(${[...byText.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join("|")})`);
  return text.split(re).map((piece, i) => {
    if (!piece) return null;
    const mark = i % 2 === 1 ? byText.get(piece) : undefined;
    return (
      <Fragment key={`${key}~${i}`}>
        {renderText(piece, ctx, `${key}~${i}`, prose)}
        {mark && <DateMarker mark={mark} />}
      </Fragment>
    );
  });
}

function renderInline(nodes: Inline[], ctx: Ctx, key: string): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}.${i}`;
    switch (n.t) {
      case "text":
        return <span key={k}>{renderMarkedText(n.v, ctx, k, true)}</span>;
      case "code":
        return <code key={k}>{renderMarkedText(n.v, ctx, k)}</code>;
      case "strong":
        return <strong key={k}>{renderInline(n.c, ctx, k)}</strong>;
      case "em":
        return <em key={k}>{renderInline(n.c, ctx, k)}</em>;
      case "link": {
        // Only http, https, mailto and relative or anchor links render as links.
        if (!isSafeHref(n.href)) return <Fragment key={k}>{renderInline(n.c, ctx, k)}</Fragment>;
        const outer = ctx.inLink;
        ctx.inLink = true;
        const kids = renderInline(n.c, ctx, k);
        ctx.inLink = outer;
        const doc = docLinkHref(n.href);
        if (doc) {
          return (
            <Link key={k} href={doc}>
              {kids}
            </Link>
          );
        }
        if (!n.href.startsWith("#")) {
          return (
            <a key={k} href={n.href} target="_blank" rel="noopener noreferrer">
              {kids}
            </a>
          );
        }
        const target = n.href.slice(1);
        if (!ctx.expand?.keys.has(target)) {
          return (
            <a key={k} href={sectionHash(target)}>
              {kids}
            </a>
          );
        }
        ctx.found.push(target);
        const open = isOpen(ctx, target);
        const { toggle, origin } = ctx.expand;
        return (
          <span key={k} className="detail-link">
            {kids}
            <button
              {...ignore}
              type="button"
              className="expand-btn"
              aria-expanded={open}
              aria-controls={open ? `x-${target}` : undefined}
              aria-label={`${open ? "Collapse" : "Expand"} ${label(n.c)}`}
              onClick={() => toggle(target, origin)}
            >
              {open ? "Collapse" : "Expand"}
            </button>
          </span>
        );
      }
      case "img": {
        // Owner decision (2026-10-20): an image loads only when Oracle stores it (a path
        // of this app under /uploads/, storedImageSrc). A remote image is a link showing
        // its alt text and host, never an <img>: a reviewer's browser contacts no outside
        // host; anything else shows its alt text. The alt text is not anchorable text (the
        // API checks a spec's labels the same way: an image is no visible text).
        const stored = storedImageSrc(n.src);
        if (stored) {
          // eslint-disable-next-line @next/next/no-img-element
          return <img key={k} src={stored} alt={n.alt} loading="lazy" className="max-w-full" />;
        }
        const host = remoteHost(n.src);
        if (!host) {
          return n.alt ? (
            <span key={k} {...ignore} data-image-alt="">
              {n.alt}
            </span>
          ) : null;
        }
        return (
          <a key={k} {...ignore} href={n.src} target="_blank" rel="noopener noreferrer" data-remote-image="">
            {n.alt ? `${n.alt} (${host})` : host}
          </a>
        );
      }
      case "cite": {
        const c = ctx.citations.get(n.key);
        return <CitationChip key={k} citeKey={n.key} citation={c?.citation} number={c?.number} />;
      }
    }
  });
}

/**
 * Renders a parsed section body. Highlights are positioned by offset into the
 * anchorable text, so the output's text nodes (outside citation chips) are exactly
 * `blocksText(blocks)`.
 */
function Detail({ keys, expand }: { keys: string[]; expand?: ExpandCtx }) {
  if (!keys.length || !expand) return null;
  return (
    <>
      {keys.map((key) => (
        <div key={key} id={`x-${key}`} {...ignore} className="detail-inline" data-testid="detail-inline" data-detail={key}>
          {expand.render(key)}
        </div>
      ))}
    </>
  );
}

/** The text nodes a body renders (prose, code spans, code blocks), where a date marker can go. */
function leaves(blocks: Block[]): string[] {
  const out: string[] = [];
  const walk = (nodes: Inline[]) => {
    for (const n of nodes) {
      if (n.t === "text" || n.t === "code") out.push(n.v);
      else if (n.t !== "cite" && n.t !== "img") walk(n.c);
    }
  };
  for (const b of blocks) {
    if (b.t === "pre") out.push(b.v);
    else if (b.t === "table") [b.head, ...b.rows].flat().forEach(walk);
    else if (b.t === "ul" || b.t === "ol") b.items.forEach(walk);
    else if (b.t === "p" || b.t === "h" || b.t === "quote") walk(b.c);
  }
  return out;
}

/**
 * The body's flagged dates that no single text node shows as written (a date across
 * emphasis, an entity, or rendered differently here than in the export): listed by the
 * section so no marker is lost.
 */
export function unplacedMarks(blocks: Block[], marks: DateMarkOut[] | undefined): DateMarkOut[] {
  const flagged = (marks ?? []).filter((m) => m.label && m.where !== "heading" && m.where !== "title");
  if (!flagged.length) return [];
  const texts = leaves(blocks);
  return flagged.filter((m) => !texts.some((t) => t.includes(m.text)));
}

export function MarkdownBody({
  blocks,
  highlights,
  activeId,
  citations,
  onHighlightClick,
  expand,
  markers,
  dateMarks,
  codes,
}: Omit<Ctx, "pos" | "found" | "shown" | "inLink"> & {
  blocks: Block[];
  /** Shown before the block at each index (not part of the anchorable text). */
  markers?: Map<number, ReactNode>;
}) {
  const ctx: Ctx = {
    pos: 0,
    highlights,
    activeId,
    citations,
    onHighlightClick,
    expand,
    found: [],
    shown: new Set(),
    dateMarks,
    codes,
  };
  // Renders a block, then the detail its links opened.
  const withDetail = (k: string, node: ReactNode) => {
    const keys = opened(ctx);
    return keys.length ? (
      <Fragment key={k}>
        {node}
        <Detail keys={keys} expand={expand} />
      </Fragment>
    ) : (
      node
    );
  };
  return (
    <>
      {blocks.map((b, i) => {
        const k = String(i);
        const marker = markers?.get(i);
        return marker ? (
          <Fragment key={`m-${k}`}>
            {marker}
            {block(b, k)}
          </Fragment>
        ) : (
          block(b, k)
        );
      })}
    </>
  );

  function block(b: Block, k: string): ReactNode {
    switch (b.t) {
      case "p":
        return withDetail(k, <p key={k}>{renderInline(b.c, ctx, k)}</p>);
      case "h":
        return <h4 key={k}>{renderInline(b.c, ctx, k)}</h4>;
      case "quote":
        return withDetail(k, <blockquote key={k}>{renderInline(b.c, ctx, k)}</blockquote>);
      case "pre":
        return (
          <pre key={k}>
            <code>{renderMarkedText(b.v, ctx, k)}</code>
          </pre>
        );
      case "ul":
      case "ol": {
        const List = b.t;
        return (
          <List key={k}>
            {b.items.map((it, j) => {
              const content = renderInline(it, ctx, `${k}.${j}`);
              return (
                <li key={j}>
                  {content}
                  <Detail keys={opened(ctx)} expand={expand} />
                </li>
              );
            })}
          </List>
        );
      }
      case "table":
        return (
          <div key={k} className="table-wrap">
            <table>
              <thead>
                <tr>
                  {b.head.map((c, j) => (
                    <th key={j}>{renderInline(c, ctx, `${k}.h${j}`)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) => {
                  const cells = r.map((c, x) => <td key={x}>{renderInline(c, ctx, `${k}.${j}.${x}`)}</td>);
                  const keys = opened(ctx);
                  return (
                    <Fragment key={j}>
                      <tr>{cells}</tr>
                      {keys.length > 0 && (
                        <tr {...ignore} className="detail-row">
                          <td colSpan={Math.max(b.head.length, r.length)}>
                            <Detail keys={keys} expand={expand} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
    }
  }
}
