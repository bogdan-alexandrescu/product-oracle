"use client";

/**
 * PT1 a "Calm document": a PRD reads as one numbered document in a 720 px column on a white
 * sheet, with a contents rail on the left that stays in view, lights the section being read and
 * shows each section's review state as a dot. The review bar shows on the section being read;
 * every other section shows only its ⋯ menu. Numbers come from the heading levels, so every
 * PRD reads so as written.
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";

import type { SectionOut } from "@/lib/api/client";
import { sectionHref } from "@/lib/section-link";

import "./PrdLook.css";

/** What the look adds to one section as SectionView draws it. */
export type SectionLook = { num?: string; hideReview?: boolean };

/** A heading that carries its own number ("2.3 Evidence", "3. Users", "A.1 Seat"): that number and the rest. */
const OWN_NUMBER = /^((?:\d{1,2}|[A-Z](?=\.\d))(?:\.\d+)*)\.?\s+(\S.*)$/;
export function ownNumber(heading: string): { num: string; rest: string } | null {
  const m = OWN_NUMBER.exec(heading.trim());
  return m ? { num: m[1], rest: m[2] } : null;
}

/** Numbers as the reader reads them: 1, 2, 2.1, 2.1.1 …; level-1 sections (the title, "Full version") carry none. */
export function numbersOf(sections: SectionOut[]): Map<string, string> {
  const m = new Map<string, string>();
  const at: number[] = [];
  for (const s of sections) {
    if (s.level <= 1) continue;
    const depth = s.level - 1;
    at.length = Math.min(at.length, depth);
    while (at.length < depth - 1) at.push(1);
    at[depth - 1] = (at[depth - 1] ?? 0) + 1;
    m.set(s.section_key, ownNumber(s.heading)?.num ?? at.join("."));
  }
  return m;
}

const STATUS: Record<string, { label: string; kind: "pass" | "warn" | "crit" | "na" }> = {
  approved: { label: "Approved", kind: "pass" },
  changes_requested: { label: "Changes requested", kind: "warn" },
  rejected: { label: "Rejected", kind: "crit" },
  none: { label: "Not reviewed", kind: "na" },
};
const LAPSED = { label: "Approval lapsed", kind: "warn" } as const;
const statusOf = (s: SectionOut) => (s.verdict?.lapsed_at ? LAPSED : STATUS[s.verdict ? s.verdict.verdict : "none"]);

/** A plain click on a link: the page handles it (a modified click opens a tab as usual). */
const plainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

const SCROLL_KEYS = new Set(["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "]);

/** The section whose top has passed this line from the window's top is the one being read. */
const READ_LINE = 140;

export function PrdLook({
  doc,
  n,
  view,
  sections,
  nodes,
  children,
  current,
  onRead,
  onPick,
}: {
  doc: string;
  n: number;
  /** Brief or Full: which sections are shown. */
  view: string;
  sections: SectionOut[];
  /** Each section as the page draws it (SectionView with every action and its SectionLook), in order. */
  nodes: ReactNode[];
  /** The review panel. */
  children: ReactNode;
  /** The section being read. */
  current: string | null;
  /** The reader scrolled to a section. */
  onRead: (key: string) => void;
  /** The reader picked a section in the contents. */
  onPick: (key: string) => void;
}) {
  const nums = useMemo(() => numbersOf(sections), [sections]);
  const rootRef = useRef<HTMLDivElement>(null);
  // The section the reader scrolled to: no jump. Any other change (a pick, a link, Go to) scrolls there.
  const read = useRef<string | null>(null);
  const quiet = useRef(0);

  useEffect(() => {
    if (!current || current === read.current) return;
    read.current = current;
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-prd-sec="${CSS.escape(current)}"]`);
    if (!el) return;
    // The first section needs no jump on arrival.
    if (el === rootRef.current?.querySelector("[data-prd-sec]") && window.scrollY === 0) return;
    // Until this jump settles, scrolling does not move the lit section (the last ones cannot reach the top).
    quiet.current = performance.now() + 700;
    el.scrollIntoView({ block: "start" });
  }, [current, sections]);

  useEffect(() => {
    let frame = 0;
    // Only the reader's own scrolling moves the lit section, never a page that grows or shifts as it loads.
    let movedAt = 0;
    const moved = () => (movedAt = performance.now());
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (SCROLL_KEYS.has(e.key) && !t?.closest("input, textarea, select, [contenteditable]")) moved();
    };
    // A press on the page's scrollbar lands on the root element.
    const onPress = (e: PointerEvent) => e.target === document.documentElement && moved();
    const onScroll = () => {
      if (performance.now() - movedAt > 1500) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const root = rootRef.current;
        if (!root || root.offsetParent === null || performance.now() < quiet.current) return;
        let at: string | null = null;
        for (const el of root.querySelectorAll<HTMLElement>("[data-prd-sec]")) {
          if (el.getBoundingClientRect().top <= READ_LINE) at = el.dataset.prdSec ?? at;
          else break;
        }
        at ??= root.querySelector<HTMLElement>("[data-prd-sec]")?.dataset.prdSec ?? null;
        // The last sections never reach the line: one picked below it stays lit while its top is in the upper half.
        const kept = read.current ? root.querySelector<HTMLElement>(`[data-prd-sec="${CSS.escape(read.current)}"]`) : null;
        const keptTop = kept?.getBoundingClientRect().top ?? -1;
        if (keptTop > READ_LINE && keptTop < window.innerHeight / 2) return;
        if (at && at !== read.current) {
          read.current = at;
          onRead(at);
        }
      });
    };
    window.addEventListener("wheel", moved, { passive: true });
    window.addEventListener("touchmove", moved, { passive: true });
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPress);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("wheel", moved);
      window.removeEventListener("touchmove", moved);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPress);
      window.removeEventListener("scroll", onScroll);
    };
  }, [onRead]);

  const lead = sections[0]?.level === 1 ? sections[0] : null;

  return (
    <div ref={rootRef} className="prd-look" data-testid="prd-look">
      <aside className="prd-rail">
        <Contents doc={doc} n={n} sections={sections} nums={nums} current={current} onPick={onPick} lead={lead} />
      </aside>
      <div className="prd-main">
        <article aria-label="Document" className="prd-doc" data-testid="document-sections" data-view={view} data-open={current ?? undefined}>
          {sections.map((s, i) => {
            const isCurrent = s.section_key === current;
            if (s.level <= 1 && s !== lead)
              return (
                <div key={s.id} data-prd-sec={s.section_key} className="prd-divider" id={`s-${s.section_key}`}>
                  <span>{s.heading}</span>
                </div>
              );
            return (
              <div key={s.id} data-prd-sec={s.section_key} data-current={isCurrent ? "" : undefined} className="prd-sec">
                {nodes[i]}
              </div>
            );
          })}
        </article>
      </div>
      <aside className="prd-side" data-testid="review-panel-column">
        {children}
      </aside>
    </div>
  );
}

function Contents({
  doc,
  n,
  sections,
  nums,
  current,
  onPick,
  lead,
}: {
  doc: string;
  n: number;
  sections: SectionOut[];
  nums: Map<string, string>;
  current: string | null;
  onPick: (key: string) => void;
  lead: SectionOut | null;
}) {
  const listRef = useRef<HTMLOListElement>(null);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  // The current section's part stays open; opened, the contents show every section.
  const topOf = useMemo(() => {
    const m = new Map<string, string>();
    let top = "";
    for (const s of sections) {
      if (s.level <= 2) top = s.section_key;
      m.set(s.section_key, top);
    }
    return m;
  }, [sections]);
  const q = filter.trim().toLowerCase();
  const rows = sections.filter((s) => {
    if (q) return s.heading.toLowerCase().includes(q);
    if (s.level <= 1) return s === lead || !nums.get(s.section_key);
    return open || s.level <= 2 || topOf.get(s.section_key) === (current ? topOf.get(current) : "");
  });
  useEffect(() => {
    listRef.current?.querySelector("[aria-current]")?.scrollIntoView({ block: "nearest" });
  }, [current, open]);
  const close = () => {
    setOpen(false);
    setFilter("");
  };
  return (
    <nav aria-label="Contents" className="prd-toc" data-testid="prd-contents">
      {open ? (
        <div className="prd-toc-head">
          <input
            autoFocus
            className="prd-toc-filter"
            placeholder="Find a section"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && close()}
            aria-label="Find a section"
          />
          <span className="prd-toc-count tnum">{sections.length} sections</span>
        </div>
      ) : (
        <button type="button" className="prd-toc-title" onClick={() => setOpen(true)} aria-label="Contents: find a section" title="Find a section">
          Contents
        </button>
      )}
      <ol ref={listRef} className="prd-toc-list">
        {rows.map((s) => {
          const status = statusOf(s);
          const own = ownNumber(s.heading);
          return (
            <li key={s.id} data-level={s.level}>
              <a
                href={sectionHref(doc, n, s.section_key)}
                data-outline-key={s.section_key}
                aria-current={s.section_key === current ? "location" : undefined}
                onClick={(e) => {
                  if (!plainClick(e)) return;
                  e.preventDefault();
                  close();
                  onPick(s.section_key);
                }}
                className="prd-toc-row"
                title={s.heading}
              >
                <span className="prd-toc-n tnum">{nums.get(s.section_key) ?? ""}</span>
                <span className="prd-toc-h">{own && nums.get(s.section_key) === own.num ? own.rest : s.heading}</span>
                {s.level > 1 && <span className={`prd-dot prd-dot-${status.kind}`} title={status.label} aria-label={status.label} role="img" />}
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
