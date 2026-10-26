"use client";

import { CitationChip } from "@/components/CitationChip";
import type { CitationOut } from "@/lib/api/client";
import { formatInZone, useCompanyZone } from "@/lib/dates";
import { isWebLink } from "@/lib/format";

/**
 * A discussion citation as an Oracle reply carries it: `[c:n]` (n) from Oracle's context, or
 * `[l:n]` (kind "live", ref "l:n", #710) from a live read of the asker's source, which
 * names its source, its call and when it was read.
 */
export type Cite = {
  n?: number;
  kind: string;
  ref: string;
  title: string;
  url?: string | null;
  excerpt?: string | null;
  confidence?: number | null;
  low_confidence?: boolean;
  source?: string;
  call?: string;
  read_at?: string;
  item_id?: string | null;
};

/** A discussion citation as the document citation chip reads it. */
function chipCitation(c: Cite): CitationOut {
  // A public link, or a web page a research run read (G2 §4, read:web): it opens the page.
  // Only an http(s) address opens (#606 re-review): never javascript:, data: or the like.
  const link = (c.kind === "public_link" || c.kind === "web") && isWebLink(c.url);
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

/** A marker still being written at the end of a streaming reply ("[", "[c", "[c:1", "[l:1"). */
const PARTIAL_MARKER = /\[([cl](:\d{0,4})?)?$/;

/**
 * A live read (#710): "Fireflies Archive · list_meetings · read 7:42 AM PDT", in the Company
 * time zone, with no link (what was read is not in Oracle).
 */
function LiveChip({ c }: { c: Cite }) {
  const zone = useCompanyZone();
  const at = c.read_at ? formatInZone(c.read_at, zone, { hour: "numeric", minute: "2-digit" }) : null;
  return (
    <span className="cite-chip" style={{ cursor: "default" }} data-testid="live-chip" title={c.item_id ? `Read live: ${c.item_id}` : "Read live"}>
      <span className="text-text2">{[c.source, c.call, at && `read ${at}`].filter(Boolean).join(" · ")}</span>
    </span>
  );
}

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
  const parts = (live ? text.replace(PARTIAL_MARKER, "") : text).split(/(\[[cl]:\d{1,4}\])/g);
  return (
    <>
      {parts.map((part, i) => {
        const ref = /^\[(l:\d+)\]$/.exec(part)?.[1];
        if (ref) {
          // A live read the reply does not carry is dropped, as the API drops it.
          const read = citations.find((x) => x.kind === "live" && x.ref === ref);
          return read ? <LiveChip key={i} c={read} /> : null;
        }
        const n = /^\[c:(\d+)\]$/.exec(part)?.[1];
        if (!n) return <span key={i}>{part}</span>;
        const c = citations.find((x) => x.kind !== "live" && x.n === Number(n));
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
