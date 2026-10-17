import type { ReactNode } from "react";

import { CitationChip } from "@/components/CitationChip";
import type { CitationOut } from "@/lib/api/client";
import type { Block, Inline } from "@/lib/markdown";

/** A highlighted span of a section's anchorable text. */
export type Highlight = { start: number; end: number; id: string; kind: "comment" | "pending" };

type Ctx = {
  pos: number;
  highlights: Highlight[];
  activeId: string | null;
  citations: Map<string, { citation: CitationOut; number: number }>;
  onHighlightClick?: (id: string) => void;
};

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
      case "link":
        return (
          <a key={k} href={n.href} target="_blank" rel="noopener noreferrer">
            {renderInline(n.c, ctx, k)}
          </a>
        );
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
export function MarkdownBody({
  blocks,
  highlights,
  activeId,
  citations,
  onHighlightClick,
}: Omit<Ctx, "pos"> & { blocks: Block[] }) {
  const ctx: Ctx = { pos: 0, highlights, activeId, citations, onHighlightClick };
  return (
    <>
      {blocks.map((b, i) => {
        const k = String(i);
        switch (b.t) {
          case "p":
            return <p key={k}>{renderInline(b.c, ctx, k)}</p>;
          case "h":
            return <h4 key={k}>{renderInline(b.c, ctx, k)}</h4>;
          case "quote":
            return <blockquote key={k}>{renderInline(b.c, ctx, k)}</blockquote>;
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
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it, ctx, `${k}.${j}`)}</li>
                ))}
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
                    {b.rows.map((r, j) => (
                      <tr key={j}>
                        {r.map((c, x) => (
                          <td key={x}>{renderInline(c, ctx, `${k}.${j}.${x}`)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </>
  );
}
