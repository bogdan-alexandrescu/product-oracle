"use client";

import { CitationChip } from "@/components/CitationChip";
import type { CitationOut } from "@/lib/api/client";

/** A discussion citation as an Oracle reply carries it. */
export type Cite = {
  n: number;
  kind: string;
  ref: string;
  title: string;
  url?: string | null;
  excerpt?: string | null;
  confidence?: number | null;
  low_confidence?: boolean;
};

/** A discussion citation as the document citation chip reads it. */
function chipCitation(c: Cite): CitationOut {
  const link = c.kind === "public_link" && !!c.url;
  return {
    id: `c${c.n}`,
    cite_key: `c:${c.n}`,
    source: link ? "web" : "oracle",
    ref: link ? c.url! : c.title,
    title: c.title,
    excerpt: c.excerpt ?? null,
    added: false,
    confidence: c.confidence ?? null,
    low_confidence: !!c.low_confidence,
  } as CitationOut;
}

/** A marker still being written at the end of a streaming reply ("[", "[c", "[c:1"). */
const PARTIAL_MARKER = /\[(c(:\d{0,4})?)?$/;

/**
 * Oracle's text with each `[c:n]` drawn as a citation chip. While it streams (`live`, #406) a
 * marker is held back until it is complete and its citation has arrived. With `loose`, a marker whose
 * citation is not known still shows as a numbered chip (a change's rationale); otherwise it
 * is dropped (a reply only cites what it carries).
 */
export function ReplyBody({
  text,
  citations,
  loose = false,
  live = false,
}: {
  text: string;
  citations: Cite[];
  loose?: boolean;
  live?: boolean;
}) {
  const parts = (live ? text.replace(PARTIAL_MARKER, "") : text).split(/(\[c:\d{1,4}\])/g);
  return (
    <>
      {parts.map((part, i) => {
        const n = /^\[c:(\d+)\]$/.exec(part)?.[1];
        if (!n) return <span key={i}>{part}</span>;
        const c = citations.find((x) => x.n === Number(n));
        if (c) return <CitationChip key={i} citeKey={`c-${n}`} citation={chipCitation(c)} number={c.n} />;
        return loose ? (
          <span key={i} className="cite-chip" data-testid={`cite-c-${n}`}>
            <span className="tnum text-text2">{n}</span>
          </span>
        ) : null;
      })}
    </>
  );
}
