"use client";

import Link from "next/link";
import { Fragment, type ReactNode } from "react";

import { Icon } from "@/components/ds";
import { formatInZone } from "@/lib/dates";
import { isSafeHref, parseBlocks, type Block, type Inline } from "@/lib/markdown";

/**
 * Oracle's answer in Simple's Ask panel, as the owner's pick C draws it (ask-panel fidelity,
 * 2026-10-28): its title, its lines, short labelled lists ("DONE WHEN", "TARGETS"…) and,
 * under them, where it comes from as links ("From the PRD · Roadmap", "Open M2 on the
 * roadmap"). The answer's text is the small markdown Oracle writes (lib/markdown); its
 * `[c:n]` markers are not drawn in the text: the cited sources are the links under it.
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
export type AnswerCite = { n?: number; kind?: string; title?: string; url?: string | null; label?: string };

/** A marker still being written at the end of a streaming answer ("[", "[c", "[c:1"). */
const PARTIAL = /\[([cl](:\d{0,4})?)?$/;

function plain(nodes: Inline[]): boolean {
  return nodes.every((n) => n.t === "cite" || (n.t === "text" && !n.v.trim()));
}

/** The answer's first block is its title: a heading, or a line that is all bold. */
function titleOf(b: Block | undefined): Inline[] | null {
  if (!b) return null;
  if (b.t === "h") return b.c;
  if (b.t !== "p") return null;
  const strong = b.c.filter((n) => n.t === "strong");
  return strong.length === 1 && plain(b.c.filter((n) => n.t !== "strong")) ? (strong[0] as { c: Inline[] }).c : null;
}

function inline(nodes: Inline[]): ReactNode {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text":
        return <Fragment key={i}>{n.v}</Fragment>;
      case "code":
        return <code key={i}>{n.v}</code>;
      case "strong":
        return (
          <b key={i} className="font-[650]">
            {inline(n.c)}
          </b>
        );
      case "em":
        return <em key={i}>{inline(n.c)}</em>;
      case "link":
        return isSafeHref(n.href) ? (
          <a key={i} href={n.href} className="font-semibold text-accent-ink underline">
            {inline(n.c)}
          </a>
        ) : (
          <Fragment key={i}>{inline(n.c)}</Fragment>
        );
      default:
        return null;
    }
  });
}

/** The answer's text as the pick draws it: title, lines, labels over short lists. */
export function AnswerText({ text, live = false }: { text: string; live?: boolean }) {
  const blocks = parseBlocks(live ? text.replace(PARTIAL, "") : text);
  const title = titleOf(blocks[0]);
  const rest = title ? blocks.slice(1) : blocks;
  const out: ReactNode[] = [];
  if (title)
    out.push(
      <p key="t" className="text-base leading-[22px] font-[650]" data-testid="answer-title">
        {inline(title)}
      </p>,
    );
  rest.forEach((b, i) => {
    // As the pick spaces them: a line after a line (or the title, or a label) 6 px down; after a list, none.
    const prev = i === 0 ? (title ? "p" : null) : rest[i - 1].t;
    const after = prev === "p" || prev === "h";
    if (b.t === "h")
      out.push(
        <p key={i} className="mt-2 text-xs leading-4 font-semibold tracking-[.06em] text-text2 uppercase" data-testid="answer-label">
          {inline(b.c)}
        </p>,
      );
    else if (b.t === "ul" || b.t === "ol") {
      const List = b.t;
      out.push(
        <List key={i} className={`mt-0.5 pl-[18px] ${b.t === "ul" ? "list-disc" : "list-decimal"}`}>
          {b.items.map((it, j) => (
            <li key={j} className="my-px">
              {inline(it)}
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
          {b.rows.map((r, j) => (
            <li key={j} className="my-px">
              {r.map((c, k) => (
                <Fragment key={k}>
                  {k > 0 && " · "}
                  {inline(c)}
                </Fragment>
              ))}
            </li>
          ))}
        </ul>,
      );
    else
      out.push(
        <p key={i} className={`${after ? "mt-1.5" : ""} whitespace-pre-wrap`}>
          {inline("c" in b ? b.c : [])}
        </p>,
      );
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
