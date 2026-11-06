"use client";

/**
 * MOCK-HOOK (mk-prd-look, mock-ups only, never merged): five ways a PRD reads, section to
 * section, behind ?pt1=a|b|c|d|e on the PRD page, with the state switches &toc=1 (contents
 * open), &sec=<key> (landed on a section), &edit=1 (that section's Edit open). The whole file
 * is mock-up code.
 *   a  Calm document: one 720 px column, numbered sections, a sticky contents rail.
 *   b  Section cards: each section a card with a header bar (number, owner, status, change).
 *   c  Summary first: a summary panel, then the sections in parts, long ones folded.
 *   d  Margin spec: a left margin with each section's number, owner, status and links.
 *   e  Printed report: a page-wide sheet in a serif face, big openers, the PDF's look.
 */
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Chip, Icon } from "@/components/ds";
import { MarkdownBody } from "@/components/MarkdownBody";
import { peopleByIds, type Person } from "@/components/PersonPicker";
import type { CitationOut, SectionOut } from "@/lib/api/client";
import type { CodeIndex } from "@/lib/code-index";
import { parseBlocks, type Block } from "@/lib/markdown";
import { useQuery } from "@/lib/use-query";

import "./PrdLook.css"; // MOCK-HOOK

export type Look = "a" | "b" | "c" | "d" | "e"; // MOCK-HOOK

/** MOCK-HOOK: the variant and its state switches from the address. */
export function usePt1() {
  const q = useSearchParams(); // MOCK-HOOK
  const v = q.get("pt1"); // MOCK-HOOK
  return {
    look: (v && "abcde".includes(v) && v.length === 1 ? v : null) as Look | null, // MOCK-HOOK
    toc: q.get("toc") === "1", // MOCK-HOOK
    sec: q.get("sec"), // MOCK-HOOK
    edit: q.get("edit") === "1", // MOCK-HOOK
  };
}

type State = { owner_id?: string | null; status?: string; revision_since_version?: number };
type Part = "why" | "what" | "when" | "risks" | "sources";
const PART_NAME: Record<Part, string> = { why: "Why", what: "What we build", when: "When it ships", risks: "Risks and decisions", sources: "Sources" };
const PART_ORDER: Part[] = ["why", "what", "when", "risks", "sources"];
const PART_OF: Record<string, Part> = {
  summary: "why", "goal-trace": "why", problem: "why", "problem-alignment": "why", audience: "why", "why-now": "why", success: "why",
  "brief-items": "what", "non-goals": "what", "solution-alignment": "what", approach: "what", features: "what", flows: "what", requirements: "what", "edge-cases": "what", "feature-detail": "what",
  "brief-roadmap": "when", milestones: "when", launch: "when", recap: "when",
  "top-risks": "risks", decisions: "risks", risks: "risks",
  sources: "sources", "sources-list": "sources", "sources-data": "sources", "sources-evidence": "sources",
};
const partOf = (key: string): Part | null =>
  PART_OF[key] ?? (key.startsWith("feature-") ? "what" : key.startsWith("milestone-") ? "when" : key.startsWith("sources-") ? "sources" : null);

const STATUS: Record<string, { label: string; kind: "pass" | "warn" | "crit" | "na" }> = {
  approved: { label: "Approved", kind: "pass" },
  changes_requested: { label: "Changes requested", kind: "warn" }, // the review bar's own word
  rejected: { label: "Rejected", kind: "crit" },
  none: { label: "Not reviewed", kind: "na" },
};
const statusOf = (s: SectionOut) => STATUS[s.verdict && !s.verdict.lapsed_at ? s.verdict.verdict : "none"];
const DATE = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2}(?:, \d{4})?/;

/** Numbers as the reader reads them: 1, 2, 2.1 …; level-1 sections (the title, "Full version") carry none. */
export function numbersOf(sections: SectionOut[]): Map<string, string> {
  const m = new Map<string, string>();
  let major = 0;
  let minor = 0;
  for (const s of sections) {
    if (s.level <= 1) continue;
    if (s.level === 2) {
      major += 1;
      minor = 0;
      m.set(s.section_key, `${major}`);
    } else {
      minor += 1;
      m.set(s.section_key, `${major}.${minor}`);
    }
  }
  return m;
}

function usePeople(ids: (string | null | undefined)[]): Map<string, Person> {
  const key = [...new Set(ids.filter(Boolean))].sort().join(",");
  const q = useQuery(`people-ids|${key}`, () => peopleByIds(key ? key.split(",") : []), { keepPrevious: true });
  return q.data ?? new Map();
}

export function PrdLook({
  look,
  sections,
  states,
  codes,
  citations,
  render,
  side,
  current,
  onCurrent,
  toc,
  sec,
  edit,
  versionAt,
}: {
  look: Look;
  sections: SectionOut[];
  states: Map<string, State>;
  codes: CodeIndex;
  citations: Map<string, { citation: CitationOut; number: number }>;
  /** One section as the page renders it (SectionView with its actions), with the look's extras. */
  render: (s: SectionOut, extra: { num?: string; meta?: ReactNode; hideReview?: boolean; tool?: "edit" }) => ReactNode;
  /** The review panel (feedback on the current section, sources, history). */
  side: ReactNode;
  current: string | null;
  onCurrent: (key: string) => void;
  toc: boolean;
  sec: string | null;
  edit: boolean;
  versionAt?: string | null;
}) {
  const nums = useMemo(() => numbersOf(sections), [sections]);
  const people = usePeople([...states.values()].map((s) => s.owner_id));
  const [tocOpen, setTocOpen] = useState(toc);
  const [filter, setFilter] = useState("");
  const [unfolded, setUnfolded] = useState<Set<string>>(() => new Set(sec ? [sec] : []));
  const rootRef = useRef<HTMLDivElement>(null);

  // Land on ?sec once the sections are drawn; then the section read at the top is the current one.
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current || !sections.length) return;
    landed.current = true;
    if (sec && sections.some((s) => s.section_key === sec)) {
      onCurrent(sec);
      requestAnimationFrame(() => document.getElementById(`s-${sec}`)?.closest("[data-pt1-sec]")?.scrollIntoView({ block: "start" }));
    }
  }, [sections, sec, onCurrent]);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onScroll = () => {
      const els = [...root.querySelectorAll<HTMLElement>("[data-pt1-sec]")];
      const line = 140;
      let at: string | null = null;
      for (const el of els) if (el.getBoundingClientRect().top <= line) at = el.dataset.pt1Sec ?? at;
      if (at && at !== current) onCurrent(at);
    };
    const t = window.setTimeout(() => window.addEventListener("scroll", onScroll, { passive: true }), 800);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("scroll", onScroll);
    };
  }, [current, onCurrent]);

  const go = (key: string) => {
    setTocOpen(false);
    setUnfolded((u) => new Set(u).add(key));
    onCurrent(key);
    requestAnimationFrame(() => document.getElementById(`s-${key}`)?.closest("[data-pt1-sec]")?.scrollIntoView({ block: "start" }));
  };

  const ownerName = (key: string) => {
    const id = states.get(key)?.owner_id;
    return id ? (people.get(id)?.name ?? "…") : null;
  };
  const changedIn = (key: string) => states.get(key)?.revision_since_version;

  const meta = (s: SectionOut): ReactNode => {
    const st = statusOf(s);
    const owner = ownerName(s.section_key);
    const v = changedIn(s.section_key);
    if (look === "b")
      return (
        <span className="pt1-bar">
          <span>{owner ? `Owner ${owner}` : "No owner"}</span>
          <Chip kind={st.kind} dot>
            {st.label}
          </Chip>
          {v && <span className="text-text2">Changed in v{v}</span>}
        </span>
      );
    if (look === "d") {
      const codesHere = [...codes.values()].filter((e) => e.sectionKey === s.section_key && e.kind === "Feature");
      const cites = s.citation_keys?.length ?? 0;
      return (
        <span className="pt1-margin">
          <span className="pt1-m-owner">{owner ?? "No owner"}</span>
          <Chip kind={st.kind} dot>
            {st.label}
          </Chip>
          {v && <span className="pt1-m-line">Changed in v{v}</span>}
          {codesHere.length > 0 && <span className="pt1-m-line">Defines {codesHere.map((e) => e.code).join(", ")}</span>}
          {cites > 0 && <span className="pt1-m-line">{cites === 1 ? "1 source" : `${cites} sources`}</span>}
        </span>
      );
    }
    if (look === "c")
      return (
        <span className="pt1-cline">
          <Chip kind={st.kind} dot>
            {st.label}
          </Chip>
          {owner && <span>{owner}</span>}
        </span>
      );
    return null;
  };

  const shown = look === "c" ? sections.filter((s) => s.level > 1) : sections;
  const lead = sections[0]?.level === 1 ? sections[0] : null;

  const one = (s: SectionOut) => {
    const isCurrent = s.section_key === current;
    const long = (s.body_text?.length ?? 0) > 900;
    const folded = look === "c" && long && !unfolded.has(s.section_key);
    if (s.level <= 1 && look !== "c" && s !== lead)
      return (
        <div key={s.id} data-pt1-sec={s.section_key} className="pt1-divider" id={`s-${s.section_key}`}>
          <span>{s.heading}</span>
        </div>
      );
    return (
      <div key={s.id} data-pt1-sec={s.section_key} data-current={isCurrent ? "" : undefined} data-folded={folded ? "" : undefined} className="pt1-sec">
        {render(s, {
          num: nums.get(s.section_key),
          meta: s.level > 1 ? meta(s) : undefined,
          hideReview: look === "b" ? false : !isCurrent,
          tool: edit && s.section_key === sec ? "edit" : undefined, // from the first draw: SectionView reads it once
        })}
        {folded && (
          <button type="button" className="pt1-unfold" onClick={() => setUnfolded((u) => new Set(u).add(s.section_key))}>
            Show all of {s.heading}
          </button>
        )}
      </div>
    );
  };

  const contents = (
    <Contents
      look={look}
      sections={sections}
      nums={nums}
      current={current}
      open={tocOpen}
      filter={filter}
      setFilter={setFilter}
      onPick={go}
      onClose={() => setTocOpen(false)}
      statusOf={statusOf}
    />
  );
  const curSection = sections.find((s) => s.section_key === current);
  const strip = (
    <div className="pt1-strip">
      <button type="button" className="pt1-strip-btn" aria-expanded={tocOpen} onClick={() => setTocOpen((o) => !o)} data-testid="pt1-contents">
        <span className="pt1-strip-label">{look === "e" ? "Contents" : "Sections"}</span>
        {curSection && (
          <span className="pt1-strip-cur">
            {nums.get(curSection.section_key) && <b className="tnum">{nums.get(curSection.section_key)}</b>} {curSection.heading}
          </span>
        )}
        <span aria-hidden className="pt1-caret">
          <Icon name={tocOpen ? "chevron-up" : "chevron-down"} size={18} />
        </span>
      </button>
      {tocOpen && contents}
    </div>
  );

  let body: ReactNode;
  if (look === "c") {
    const grouped = new Map<Part, SectionOut[]>(PART_ORDER.map((p) => [p, []]));
    let last: Part = "why";
    for (const s of shown) {
      const p: Part = partOf(s.section_key) ?? last;
      last = p;
      grouped.get(p)!.push(s);
    }
    body = (
      <>
        <Summary sections={sections} codes={codes} citations={citations} nums={nums} onGo={go} lead={lead} versionAt={versionAt} />
        {PART_ORDER.filter((p) => grouped.get(p)!.length).map((p, i) => (
          <div key={p} className="pt1-part">
            <h2 className="pt1-part-head">
              <span className="pt1-part-n">Part {i + 1}</span> {PART_NAME[p]}
              <span className="pt1-part-count">{grouped.get(p)!.length} sections</span>
            </h2>
            <div className="pt1-doc">{grouped.get(p)!.map(one)}</div>
          </div>
        ))}
      </>
    );
  } else body = <div className="pt1-doc">{shown.map(one)}</div>;

  return (
    <div ref={rootRef} data-pt1={look} className="pt1-root">
      {(look === "a" || look === "d") && <aside className="pt1-rail">{contents}</aside>}
      <div className="pt1-main">
        {(look === "b" || look === "c" || look === "e") && strip}
        {look === "e" ? <div className="pt1-paper">{body}</div> : body}
      </div>
      <aside className="pt1-side">{side}</aside>
    </div>
  );
}

function Contents({
  look,
  sections,
  nums,
  current,
  open,
  filter,
  setFilter,
  onPick,
  onClose,
  statusOf: st,
}: {
  look: Look;
  sections: SectionOut[];
  nums: Map<string, string>;
  current: string | null;
  open: boolean;
  filter: string;
  setFilter: (v: string) => void;
  onPick: (key: string) => void;
  onClose: () => void;
  statusOf: (s: SectionOut) => { label: string; kind: string };
}) {
  const listRef = useRef<HTMLOListElement>(null);
  // The current section's parent stays open in the rail; Contents open shows every section.
  const parentOf = useMemo(() => {
    const m = new Map<string, string>();
    let top = "";
    for (const s of sections) {
      if (s.level <= 2) top = s.section_key;
      m.set(s.section_key, top);
    }
    return m;
  }, [sections]);
  const rail = look === "a" || look === "d";
  const all = !rail || open;
  const q = filter.trim().toLowerCase();
  const rows = sections.filter((s) => {
    if (s.level <= 1 && !nums.get(s.section_key) && s !== sections[0]) return !q && all;
    if (q) return s.heading.toLowerCase().includes(q);
    if (all) return true;
    return s.level <= 2 || parentOf.get(s.section_key) === (current ? parentOf.get(current) : "");
  });
  useEffect(() => {
    listRef.current?.querySelector("[aria-current]")?.scrollIntoView({ block: "nearest" });
  }, [current, open]);
  return (
    <nav aria-label="Contents" className={`pt1-toc${open ? " pt1-toc-open" : ""}`} data-testid="pt1-toc">
      {(open || !rail) && (
        <div className="pt1-toc-head">
          <input
            className="pt1-toc-filter"
            placeholder="Find a section"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Find a section"
          />
          <span className="pt1-toc-count tnum">{sections.filter((s) => s.level > 1).length} sections</span>
          {!rail && (
            <button type="button" className="pt1-toc-close" onClick={onClose} aria-label="Close contents">
              ×
            </button>
          )}
        </div>
      )}
      {rail && !open && <p className="pt1-toc-title">Contents</p>}
      <ol ref={listRef} className="pt1-toc-list">
        {rows.map((s) => {
          const status = st(s);
          const isCur = s.section_key === current;
          return (
            <li key={s.id} data-level={s.level}>
              <button type="button" aria-current={isCur ? "location" : undefined} onClick={() => onPick(s.section_key)} className="pt1-toc-row">
                <span className="pt1-toc-n tnum">{nums.get(s.section_key) ?? ""}</span>
                <span className="pt1-toc-h">{s.heading}</span>
                {s.level > 1 && <span className={`pt1-dot pt1-dot-${status.kind}`} title={status.label} aria-label={status.label} />}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** c: the facts the PRD already holds, lifted to the top: goal and target, dates, features, decisions, questions. */
function Summary({
  sections,
  codes,
  citations,
  nums,
  onGo,
  lead,
  versionAt,
}: {
  sections: SectionOut[];
  codes: CodeIndex;
  citations: Map<string, { citation: CitationOut; number: number }>;
  nums: Map<string, string>;
  onGo: (key: string) => void;
  lead: SectionOut | null;
  versionAt?: string | null;
}) {
  const by = (k: string) => sections.find((s) => s.section_key === k);
  const goal = by("goal-trace") ?? by("summary");
  const goalBlocks = useMemo<Block[]>(() => {
    const b = goal ? parseBlocks(goal.body_md) : [];
    const list = b.find((x) => x.t === "ul" || x.t === "ol");
    if (list && (list.t === "ul" || list.t === "ol")) return [{ ...list, items: list.items.slice(0, 2) }];
    return b.slice(0, 1);
  }, [goal]);
  const dates = sections
    .filter((s) => s.section_key.startsWith("milestone-"))
    .map((s) => ({ key: s.section_key, name: s.heading, date: s.body_text.match(DATE)?.[0] ?? "Not dated" }));
  const entries = [...codes.values()].filter((e) => e.from === "this PRD" || e.sectionKey);
  const features = entries.filter((e) => e.kind === "Feature");
  const decisions = entries.filter((e) => e.kind === "Decision");
  const questions = entries.filter((e) => e.kind === "Open question");
  const reviewed = sections.filter((s) => s.level > 1 && s.verdict?.verdict === "approved").length;
  const total = sections.length; // the review panel's count: every section
  const asked = sections.filter((s) => s.verdict?.verdict === "changes_requested");
  return (
    <section className="pt1-summary" aria-label="Summary" data-pt1-sec={lead?.section_key ?? "summary-panel"}>
      {lead && <p className="pt1-sum-lead">{lead.body_text}</p>}
      <div className="pt1-sum-grid">
        <div className="pt1-sum-box pt1-sum-goal">
          <h3>Goal, measure and target</h3>
          <div className="doc-body">
            <MarkdownBody blocks={goalBlocks} highlights={[]} activeId={null} citations={citations} onHighlightClick={() => {}} codes={codes} />
          </div>
          {goal && (
            <button type="button" className="pt1-sum-link" onClick={() => onGo(goal.section_key)}>
              {nums.get(goal.section_key)} {goal.heading}
            </button>
          )}
        </div>
        <div className="pt1-sum-box">
          <h3>Dates</h3>
          {dates.length ? (
            <ol className="pt1-sum-list">
              {dates.map((d) => (
                <li key={d.key}>
                  <button type="button" onClick={() => onGo(d.key)}>
                    <b>{d.date}</b> {d.name}
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-text2">No milestones</p>
          )}
          {versionAt && <p className="pt1-sum-small">This version: {versionAt}</p>}
        </div>
        <div className="pt1-sum-box">
          <h3>Review</h3>
          <p>
            <b className="tnum">{reviewed}</b> of {total} sections approved
          </p>
          {asked.map((s) => (
            <button key={s.id} type="button" className="pt1-sum-link pt1-sum-warn" onClick={() => onGo(s.section_key)}>
              Changes requested: {nums.get(s.section_key)} {s.heading}
            </button>
          ))}
        </div>
        <div className="pt1-sum-box pt1-sum-wide">
          <h3>
            Features <span className="tnum text-text2">{features.length}</span>
          </h3>
          <ul className="pt1-sum-chips">
            {features.map((f) => (
              <li key={f.code}>
                <button type="button" onClick={() => f.sectionKey && onGo(f.sectionKey)} title={`${f.code} ${f.name}`}>
                  <span className="pt1-chip-code">{f.code}</span> {f.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="pt1-sum-box">
          <h3>
            Decisions <span className="tnum text-text2">{decisions.length}</span>
          </h3>
          <ul className="pt1-sum-list">
            {decisions.slice(0, 4).map((d) => (
              <li key={d.code}>
                <button type="button" onClick={() => d.sectionKey && onGo(d.sectionKey)}>
                  <b>{d.code}</b> {d.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="pt1-sum-box">
          <h3>
            Open questions <span className="tnum text-text2">{questions.length}</span>
          </h3>
          <ul className="pt1-sum-list">
            {questions.slice(0, 4).map((d) => (
              <li key={d.code}>
                <button type="button" onClick={() => d.sectionKey && onGo(d.sectionKey)}>
                  <b>{d.code}</b> {d.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
