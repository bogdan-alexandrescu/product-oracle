import Link from "next/link";
import { Fragment, type ReactNode } from "react";

import { CitationChip } from "@/components/CitationChip";
import { IGNORE_ATTR } from "@/lib/anchor";
import type { CitationOut } from "@/lib/api/client";
import type { Block, Inline } from "@/lib/markdown";
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

function label(nodes: Inline[]): string {
  return nodes.map((n) => (n.t === "text" || n.t === "code" ? n.v : n.t === "cite" ? "" : label(n.c))).join("");
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

function renderText(text: string, ctx: Ctx, key: string): ReactNode {
  const start = ctx.pos;
  const end = start + text.length;
  ctx.pos = end;
  const hits = ctx.highlights.filter((h) => h.start < end && h.end > start);
  if (!hits.length) return text;
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
      out.push(slice);
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

function renderInline(nodes: Inline[], ctx: Ctx, key: string): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}.${i}`;
    switch (n.t) {
      case "text":
        return <span key={k}>{renderText(n.v, ctx, k)}</span>;
      case "code":
        return <code key={k}>{renderText(n.v, ctx, k)}</code>;
      case "strong":
        return <strong key={k}>{renderInline(n.c, ctx, k)}</strong>;
      case "em":
        return <em key={k}>{renderInline(n.c, ctx, k)}</em>;
      case "link": {
        const doc = docLinkHref(n.href);
        if (doc) {
          return (
            <Link key={k} href={doc}>
              {renderInline(n.c, ctx, k)}
            </Link>
          );
        }
        if (!n.href.startsWith("#")) {
          return (
            <a key={k} href={n.href} target="_blank" rel="noopener noreferrer">
              {renderInline(n.c, ctx, k)}
            </a>
          );
        }
        const target = n.href.slice(1);
        if (!ctx.expand?.keys.has(target)) {
          return (
            <a key={k} href={sectionHash(target)}>
              {renderInline(n.c, ctx, k)}
            </a>
          );
        }
        ctx.found.push(target);
        const open = isOpen(ctx, target);
        const { toggle, origin } = ctx.expand;
        return (
          <span key={k} className="detail-link">
            {renderInline(n.c, ctx, k)}
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

export function MarkdownBody({
  blocks,
  highlights,
  activeId,
  citations,
  onHighlightClick,
  expand,
}: Omit<Ctx, "pos" | "found" | "shown"> & { blocks: Block[] }) {
  const ctx: Ctx = { pos: 0, highlights, activeId, citations, onHighlightClick, expand, found: [], shown: new Set() };
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
                <code>{renderText(b.v, ctx, k)}</code>
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
      })}
    </>
  );
}
