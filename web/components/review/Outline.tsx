"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { Button, FilterChips, Icon, MARK_LABEL } from "@/components/ds";
import { Kbd, SectionMark, sectionMark } from "@/components/review/parts";
import type { SectionOut } from "@/lib/api/client";
import { sectionHref } from "@/lib/section-link";
import { useViewportFit } from "@/lib/use-viewport-fit";

/*
 * PRD page navigation (I3, owner 2026-10-20): the outline rail left of the section card
 * (>= 1280 px), the section switcher above it (below 1280 px) and the Sections sheet on a
 * phone. All three list the same rows: a status mark that differs in shape and colour, the
 * name, and an open-feedback count; a filter box and All / To review / With feedback chips.
 */

export type OutlineChip = "all" | "review" | "feedback";

type OutlineNode = {
  s: SectionOut;
  depth: number;
  parent: string | null;
  /** Keys of this node and every node under it. */
  subtree: string[];
  hasChildren: boolean;
};

/**
 * The tree of sections by heading level. A lone top-level heading that opens the document
 * (its title) stays a row of its own, so its chapters are the roots rather than one fold.
 */
export function buildOutline(sections: SectionOut[]): OutlineNode[] {
  // reduce, not Math.min(...spread): no argument limit on a long document.
  const top = sections.reduce((m, s) => Math.min(m, s.level), Infinity);
  const titled = sections.length > 1 && sections[0].level === top && sections.filter((s) => s.level === top).length === 1;
  const nodes: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  sections.forEach((s, i) => {
    if (titled && i === 0) {
      nodes.push({ s, depth: 0, parent: null, subtree: [s.section_key], hasChildren: false });
      return;
    }
    while (stack.length && stack[stack.length - 1].s.level >= s.level) stack.pop();
    const node: OutlineNode = { s, depth: stack.length, parent: stack.at(-1)?.s.section_key ?? null, subtree: [s.section_key], hasChildren: false };
    for (const a of stack) a.subtree.push(s.section_key);
    if (stack.length) stack[stack.length - 1].hasChildren = true;
    stack.push(node);
    nodes.push(node);
  });
  return nodes;
}

function ancestorsOf(nodes: Map<string, OutlineNode>, key: string | null): Set<string> {
  const out = new Set<string>();
  let k = key ? nodes.get(key)?.parent ?? null : null;
  while (k) {
    out.add(k);
    k = nodes.get(k)?.parent ?? null;
  }
  return out;
}

/** The filter box and chips' state, one per list. */
export function useOutlineFilter() {
  const [query, setQuery] = useState("");
  const [chip, setChip] = useState<OutlineChip>("all");
  return { query, setQuery, chip, setChip };
}
export type OutlineFilterState = ReturnType<typeof useOutlineFilter>;

type ListProps = {
  doc: string;
  n: number;
  sections: SectionOut[];
  openKey: string | null;
  /** Open feedback per section key. */
  openCounts: ReadonlyMap<string, number>;
  /** The version's review is closed: every row shows a lock. */
  closed: boolean;
  onSelect: (key: string) => void;
  filter: OutlineFilterState;
};

/** Scrolls `el` into the scrolling `box` only (never the page), when it is not in full view. */
function revealIn(box: HTMLElement | null, el: HTMLElement | null) {
  if (!box || !el) return;
  const b = box.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (r.top < b.top) box.scrollTop -= b.top - r.top + 8;
  else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom + 8;
}

const plainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/** The filter box and the chips above a list. */
export function OutlineFilters({
  sections,
  openCounts,
  filter,
  inputRef,
  onArrowDown,
  onEnter,
  autoFocus,
  compact,
}: {
  sections: SectionOut[];
  openCounts: ReadonlyMap<string, number>;
  filter: OutlineFilterState;
  inputRef?: RefObject<HTMLInputElement | null>;
  /** ArrowDown in the box moves to the list. */
  onArrowDown?: () => void;
  /** Enter in the box opens the first match. */
  onEnter?: () => void;
  autoFocus?: boolean;
  compact?: boolean;
}) {
  const toReview = sections.filter((s) => !s.verdict).length;
  const withFeedback = sections.filter((s) => (openCounts.get(s.section_key) ?? 0) > 0).length;
  return (
    <div className={`flex flex-col gap-2 ${compact ? "" : "px-3"}`}>
      <label className="relative flex items-center">
        <span className="sr-only">Filter sections</span>
        <span aria-hidden className="pointer-events-none absolute left-2.5 text-text2">
          <Icon name="search" size={16} />
        </span>
        <input
          ref={inputRef}
          type="search"
          data-autofocus={autoFocus ? "" : undefined}
          autoFocus={autoFocus}
          value={filter.query}
          onChange={(e) => filter.setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              onArrowDown?.();
            } else if (e.key === "Enter") {
              e.preventDefault();
              onEnter?.();
            }
          }}
          placeholder="Filter sections"
          aria-keyshortcuts="/"
          data-testid="outline-filter"
          className="h-9 w-full rounded-lg border border-line-strong bg-surface pr-8 pl-8 text-sm text-text placeholder:text-text2 max-[639px]:h-11 max-[639px]:text-[15px]"
        />
        <span aria-hidden className="pointer-events-none absolute right-2 max-[639px]:hidden">
          <Kbd>/</Kbd>
        </span>
      </label>
      <FilterChips<OutlineChip>
        label="Show sections"
        testId="outline-chips"
        value={filter.chip}
        onChange={filter.setChip}
        items={[
          { value: "all", label: "All", count: sections.length, testId: "chip-all" },
          { value: "review", label: "To review", count: toReview, testId: "chip-review" },
          { value: "feedback", label: "With feedback", count: withFeedback, testId: "chip-feedback" },
        ]}
      />
    </div>
  );
}

/**
 * The rows. `tree`: chapters fold with a chevron (the current chapter is open; a folded one
 * shows reviewed/total). `flat`: every row, chapters bold and children indented, no folding.
 * Arrow keys move between rows, Enter opens one.
 */
export function OutlineList({
  doc,
  n,
  sections,
  openKey,
  openCounts,
  closed,
  onSelect,
  filter,
  mode,
  scrollRef,
  listRef,
  tall = false,
}: ListProps & {
  mode: "tree" | "flat";
  /** The scrolling box the current row is kept in view within. */
  scrollRef: RefObject<HTMLElement | null>;
  listRef?: RefObject<HTMLUListElement | null>;
  /** 44 px rows (phone). */
  tall?: boolean;
}) {
  const nodes = useMemo(() => buildOutline(sections), [sections]);
  const byKey = useMemo(() => new Map(nodes.map((nd) => [nd.s.section_key, nd])), [nodes]);
  const ownList = useRef<HTMLUListElement>(null);
  const ul = listRef ?? ownList;

  // Folding: the current chapter is open; the reader's own folds win until the current
  // section moves into a chapter they folded.
  const [folds, setFolds] = useState<Map<string, boolean>>(() => new Map());
  const [seenOpen, setSeenOpen] = useState(openKey);
  const current = useMemo(() => ancestorsOf(byKey, openKey), [byKey, openKey]);
  if (seenOpen !== openKey) {
    setSeenOpen(openKey);
    if ([...current].some((k) => folds.get(k) === false)) {
      setFolds((f) => {
        const next = new Map(f);
        for (const k of current) next.delete(k);
        return next;
      });
    }
  }
  const isOpen = (key: string) => folds.get(key) ?? current.has(key);
  const toggle = (key: string, open?: boolean) =>
    setFolds((f) => new Map(f).set(key, open ?? !isOpen(key)));

  const q = filter.query.trim().toLowerCase();
  const matches = (s: SectionOut) =>
    (!q || s.heading.toLowerCase().includes(q)) &&
    (filter.chip === "all" ||
      (filter.chip === "review" && !s.verdict) ||
      (filter.chip === "feedback" && (openCounts.get(s.section_key) ?? 0) > 0));
  const filtering = !!q || filter.chip !== "all";

  // Rows on screen: when filtering, the matches with their chapters (for context), all open.
  const rows = useMemo(() => {
    if (filtering) {
      const keep = new Set<string>();
      for (const nd of nodes) {
        if (!matches(nd.s)) continue;
        keep.add(nd.s.section_key);
        for (const a of ancestorsOf(byKey, nd.s.section_key)) keep.add(a);
      }
      return nodes.filter((nd) => keep.has(nd.s.section_key));
    }
    if (mode === "flat") return nodes;
    return nodes.filter((nd) => [...ancestorsOf(byKey, nd.s.section_key)].every(isOpen));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, byKey, filtering, q, filter.chip, openCounts, mode, folds, current]);

  // Keep the current row in view inside the list's own scroll (never scrolling the page).
  useLayoutEffect(() => {
    if (!openKey) return;
    revealIn(scrollRef.current, ul.current?.querySelector<HTMLElement>(`[data-outline-key="${CSS.escape(openKey)}"]`) ?? null);
  }, [openKey, rows, scrollRef, ul]);

  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const links = [...(ul.current?.querySelectorAll<HTMLElement>("a[data-outline-key]") ?? [])];
    const at = links.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    const go = (i: number) => {
      e.preventDefault();
      e.stopPropagation();
      links[Math.max(0, Math.min(links.length - 1, i))]?.focus();
    };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(links.length - 1);
    else if (mode === "tree" && !filtering && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      const key = links[at].dataset.outlineKey!;
      const nd = byKey.get(key);
      if (!nd) return;
      e.preventDefault();
      if (e.key === "ArrowRight" && nd.hasChildren) toggle(key, true);
      else if (e.key === "ArrowLeft" && nd.hasChildren && isOpen(key)) toggle(key, false);
      else if (e.key === "ArrowLeft" && nd.parent) ul.current?.querySelector<HTMLElement>(`a[data-outline-key="${CSS.escape(nd.parent)}"]`)?.focus();
    }
  };

  if (rows.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-sm text-text2" data-testid="outline-empty">
        No sections match
      </p>
    );
  }

  return (
    <ul ref={ul} aria-label="Sections" className="flex flex-col py-1" onKeyDown={onKey} data-testid="outline-list">
      {rows.map((nd) => {
        const s = nd.s;
        const key = s.section_key;
        const on = key === openKey;
        const folded = mode === "tree" && !filtering && nd.hasChildren && !isOpen(key);
        const count = folded
          ? nd.subtree.reduce((sum, k) => sum + (openCounts.get(k) ?? 0), 0)
          : openCounts.get(key) ?? 0;
        const reviewed = nd.subtree.filter((k) => byKey.get(k)?.s.verdict).length;
        const chapter = nd.hasChildren;
        const dimmed = filtering && !matches(s);
        const indent = mode === "tree" ? nd.depth * 14 : chapter ? 0 : Math.min(nd.depth, 3) * 14;
        const state = sectionMark(s.verdict?.verdict, closed, Boolean(s.verdict?.lapsed_at));
        return (
          <li
            key={s.id}
            className={`relative mx-1.5 flex items-center rounded-lg ${tall ? "min-h-11" : "min-h-8"} ${
              on ? "bg-accent-soft before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-[2px] before:bg-accent before:content-['']" : "hover:bg-surface2"
            }`}
            style={{ paddingLeft: indent }}
          >
            {mode === "tree" &&
              (chapter && !filtering ? (
                <button
                  type="button"
                  tabIndex={-1}
                  aria-expanded={!folded}
                  aria-label={`${folded ? "Unfold" : "Fold"} ${s.heading}`}
                  data-testid="outline-fold"
                  onClick={() => toggle(key)}
                  className="grid size-6 flex-none place-items-center rounded-md text-text2 hover:bg-surface2 hover:text-text"
                >
                  <Icon name={folded ? "chevron-right" : "chevron-down"} size={16} />
                </button>
              ) : (
                <span aria-hidden className="w-6 flex-none" />
              ))}
            <a
              href={sectionHref(doc, n, key)}
              data-outline-key={key}
              data-state={state}
              data-folded={folded || undefined}
              aria-current={on ? "true" : undefined}
              aria-label={`${s.heading}, ${MARK_LABEL[state]}${count ? `, ${count} open feedback` : ""}${folded ? `, ${reviewed} of ${nd.subtree.length} reviewed` : ""}`}
              title={s.heading}
              data-own-nav
              onClick={(e) => {
                if (!plainClick(e)) return;
                e.preventDefault();
                onSelect(key);
              }}
              className={`flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-lg pr-2 ${mode === "tree" ? "pl-1" : "pl-2.5"} text-sm ${
                tall ? "text-[15px]" : ""
              } ${chapter && mode === "flat" ? "font-bold" : chapter ? "font-semibold" : "font-medium"} ${
                on ? "text-text" : dimmed ? "text-text2" : "text-text"
              }`}
            >
              <SectionMark verdict={s.verdict?.verdict} closed={closed} lapsed={Boolean(s.verdict?.lapsed_at)} />
              <span className="min-w-0 flex-1 truncate" data-testid="outline-name">
                {s.heading}
              </span>
              {folded && (
                <span className="tnum flex-none font-mono text-[13px] text-text2" data-testid="outline-folded-count">
                  {reviewed}/{nd.subtree.length}
                </span>
              )}
              {count > 0 && (
                <span
                  data-testid="outline-count"
                  className="tnum grid h-5 min-w-5 flex-none place-items-center rounded-full bg-accent-soft px-1.5 text-[13px] leading-none font-bold text-accent-ink"
                >
                  {count}
                </span>
              )}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/** "N of M reviewed" and a bar. */
export function ReviewProgress({ reviewed, total, compact = false }: { reviewed: number; total: number; compact?: boolean }) {
  return (
    <div
      className={`flex min-w-0 flex-col gap-1 ${compact ? "w-24" : ""}`}
      data-testid="review-progress"
      title={compact ? `${reviewed} of ${total} reviewed` : undefined}
    >
      <span className="tnum text-[13px] leading-4 font-semibold text-text2">
        {compact ? (
          <>
            <b className="font-bold text-text">{reviewed}</b>/{total} <span className="sr-only">reviewed</span>
          </>
        ) : (
          <>
            <b className="font-bold text-text">{reviewed}</b> of {total} reviewed
          </>
        )}
      </span>
      <span
        role="progressbar"
        aria-label="Sections reviewed"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={reviewed}
        className="block h-1.5 overflow-hidden rounded-full bg-surface2"
      >
        <span className="block h-full rounded-full bg-pass" style={{ width: `${total ? (reviewed / total) * 100 : 0}%` }} />
      </span>
    </div>
  );
}

const COLLAPSE_KEY = "oracle-outline-collapsed";

/** The rail's collapsed state, remembered per user in localStorage. */
export function useRailCollapsed(userId: string | null): [boolean, (v: boolean) => void] {
  const key = `${COLLAPSE_KEY}:${userId ?? "anon"}`;
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCollapsed(localStorage.getItem(key) === "1");
    } catch {
      // Storage refused (private mode): the rail starts open.
    }
  }, [key]);
  const set = useCallback(
    (v: boolean) => {
      setCollapsed(v);
      try {
        if (v) localStorage.setItem(key, "1");
        else localStorage.removeItem(key);
      } catch {
        // Not remembered this time.
      }
    },
    [key],
  );
  return [collapsed, set];
}

/** The outline rail: sticky beside the section card with its own scroll (>= 1280 px). */
export function OutlineRail({
  filterRef,
  onCollapse,
  ...props
}: ListProps & { filterRef: RefObject<HTMLInputElement | null>; onCollapse: () => void }) {
  const scroll = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const nav = useRef<HTMLElement>(null);
  // Sticky under the header and never taller than the viewport below its top.
  useViewportFit(nav, "(min-width: 1280px)");
  const reviewed = props.sections.filter((s) => s.verdict).length;
  const firstRow = () => list.current?.querySelector<HTMLElement>("a[data-outline-key]");
  return (
    <nav
      ref={nav}
      aria-label="Outline"
      data-testid="outline-rail"
      className="sticky top-4 flex max-h-[calc(100dvh-2rem)] min-h-0 w-[280px] flex-col overflow-hidden rounded-panel border border-line bg-surface shadow-panel"
    >
      <div className="flex flex-none flex-col gap-2.5 border-b border-line pt-3 pb-3">
        <div className="flex items-center gap-2 px-3">
          <h2 className="font-display text-lg leading-6 font-bold tracking-heading">Outline</h2>
          <span className="flex-1" />
          <button
            type="button"
            onClick={onCollapse}
            aria-label="Hide outline"
            title="Hide outline"
            data-testid="outline-collapse"
            className="grid size-8 place-items-center rounded-lg text-text2 hover:bg-surface2 hover:text-text"
          >
            <Icon name="chevron-left" size={16} />
          </button>
        </div>
        <div className="px-3">
          <ReviewProgress reviewed={reviewed} total={props.sections.length} />
        </div>
        <OutlineFilters
          sections={props.sections}
          openCounts={props.openCounts}
          filter={props.filter}
          inputRef={filterRef}
          onArrowDown={() => firstRow()?.focus()}
          onEnter={() => firstRow()?.click()}
        />
      </div>
      <div ref={scroll} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain" data-testid="outline-scroll">
        <OutlineList {...props} mode="tree" scrollRef={scroll} listRef={list} />
      </div>
    </nav>
  );
}

/** The button that brings a hidden rail back. */
export function ShowOutlineButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Show outline"
      title="Show outline"
      data-testid="outline-expand"
      className="sticky top-4 grid size-10 place-items-center rounded-panel border border-line bg-surface text-text2 shadow-panel hover:text-text"
    >
      <Icon name="outline" size={20} />
    </button>
  );
}

/** The listbox popover: fixed, kept fully inside the viewport. */
function usePopoverBox(open: boolean, trigger: RefObject<HTMLElement | null>) {
  const [box, setBox] = useState<{ top?: number; bottom?: number; left: number; width: number; maxHeight: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const t = trigger.current?.getBoundingClientRect();
      if (!t) return;
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      const width = Math.min(440, vw - 24);
      const left = Math.max(12, Math.min(t.left, vw - width - 12));
      const below = vh - t.bottom - 18;
      const above = t.top - 18;
      if (below >= 280 || below >= above) setBox({ top: t.bottom + 6, left, width, maxHeight: Math.max(160, below) });
      else setBox({ bottom: vh - t.top + 6, left, width, maxHeight: above });
    };
    // Scrolling the popover's own list does not move its trigger: only other scrolls place it again.
    const onScroll = (e: Event) => {
      if (e.target instanceof Element && e.target.closest("[data-testid=switcher-popover]")) return;
      place();
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, trigger]);
  return box;
}

/**
 * Below 1280 px: [‹] [mark · name · i of M · ⌄] [›], progress and "Next to review". The ⌄
 * opens the same filter, chips and list (chapters bold, no folding). Escape, a click
 * outside, the trigger and a pick close it; focus returns to the trigger.
 */
export function SectionSwitcher({
  open,
  setOpen,
  prev,
  next,
  nextToReview,
  leading,
  ...props
}: ListProps & {
  /** Before the arrows: the button that brings back a hidden rail. */
  leading?: ReactNode;
  open: boolean;
  setOpen: (v: boolean) => void;
  prev: SectionOut | null;
  next: SectionOut | null;
  nextToReview: SectionOut | null;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const box = usePopoverBox(open, trigger);
  const current = props.sections.find((s) => s.section_key === props.openKey) ?? null;
  const index = current ? props.sections.indexOf(current) + 1 : 0;
  const reviewed = props.sections.filter((s) => s.verdict).length;

  const close = useCallback(
    (refocus = true) => {
      setOpen(false);
      if (refocus) trigger.current?.focus();
    },
    [setOpen],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (pop.current?.contains(t) || trigger.current?.contains(t)) return;
      // Focus goes back to the trigger unless the click lands on something focusable.
      const focusable = (t as Element).closest?.("a, button, input, select, textarea, [tabindex]");
      close(!focusable);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [open, close]);

  const firstRow = () => list.current?.querySelector<HTMLElement>("a[data-outline-key]");
  const step = (s: SectionOut | null, dir: "prev" | "next") =>
    s ? (
      <a
        href={sectionHref(props.doc, props.n, s.section_key)}
        rel={dir}
        aria-label={`${dir === "prev" ? "Previous" : "Next"} section: ${s.heading}`}
        title={s.heading}
        data-own-nav
        onClick={(e) => {
          if (!plainClick(e)) return;
          e.preventDefault();
          props.onSelect(s.section_key);
        }}
        className="grid size-9 flex-none place-items-center rounded-lg text-text2 hover:bg-surface2 hover:text-text"
      >
        <Icon name={dir === "prev" ? "chevron-left" : "chevron-right"} size={20} />
      </a>
    ) : (
      <span aria-hidden className="grid size-9 flex-none place-items-center text-line-strong">
        <Icon name={dir === "prev" ? "chevron-left" : "chevron-right"} size={20} />
      </span>
    );

  return (
    <div
      data-testid="section-switcher"
      className="relative flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-panel border border-line bg-surface p-1.5 pr-3 shadow-panel"
    >
      <div className="flex min-w-0 flex-1 basis-80 items-center gap-1">
        {leading}
        {step(prev, "prev")}
        <button
          ref={trigger}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={current ? `Section ${index} of ${props.sections.length}: ${current.heading}. Choose a section` : "Choose a section"}
          data-testid="switcher-trigger"
          onClick={() => (open ? close() : setOpen(true))}
          className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line-strong px-2.5 text-left hover:bg-surface2"
        >
          {current && <SectionMark verdict={current.verdict?.verdict} closed={props.closed} lapsed={Boolean(current.verdict?.lapsed_at)} />}
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text" title={current?.heading}>
            {current?.heading ?? "Sections"}
          </span>
          <span className="tnum flex-none text-[13px] font-semibold text-text2" data-testid="switcher-index">
            {index} of {props.sections.length}
          </span>
          <Icon name="chevron-down" size={16} className="text-text2" />
        </button>
        {step(next, "next")}
      </div>
      <div className="flex flex-none items-center gap-3">
        <ReviewProgress reviewed={reviewed} total={props.sections.length} compact />
        <Button
          disabled={!nextToReview}
          onClick={() => nextToReview && props.onSelect(nextToReview.section_key)}
          aria-label={nextToReview ? `Next to review: ${nextToReview.heading}` : "Nothing left to review"}
          data-testid="next-to-review"
        >
          Next to review
          <Icon name="chevron-right" size={16} />
        </Button>
      </div>

      {open && box && (
        <div
          ref={pop}
          role="dialog"
          aria-label="Choose a section"
          data-testid="switcher-popover"
          className="fixed z-50 flex min-h-0 flex-col overflow-hidden rounded-panel border border-line bg-surface text-text shadow-tip"
          style={{ top: box.top, bottom: box.bottom, left: box.left, width: box.width, maxHeight: box.maxHeight }}
        >
          <div className="flex-none border-b border-line py-3">
            <OutlineFilters
              sections={props.sections}
              openCounts={props.openCounts}
              filter={props.filter}
              autoFocus
              onArrowDown={() => firstRow()?.focus()}
              onEnter={() => firstRow()?.click()}
            />
          </div>
          <div ref={scroll} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <OutlineList
              {...props}
              mode="flat"
              scrollRef={scroll}
              listRef={list}
              onSelect={(k) => {
                props.onSelect(k);
                close();
              }}
            />
          </div>
          <p className="flex-none border-t border-line px-3 py-2 text-[13px] text-text2" data-testid="switcher-hints">
            ↑↓ move · ↵ open · j k next/previous
          </p>
        </div>
      )}
    </div>
  );
}

/** The phone's Sections sheet body: the filter, chips and the list with 44 px rows. */
export function SectionsSheetBody(props: ListProps & { header?: ReactNode }) {
  const scroll = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const firstRow = () => list.current?.querySelector<HTMLElement>("a[data-outline-key]");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none flex-col gap-2.5 border-b border-line py-3">
        {props.header && <div className="px-3">{props.header}</div>}
        <OutlineFilters
          sections={props.sections}
          openCounts={props.openCounts}
          filter={props.filter}
          onArrowDown={() => firstRow()?.focus()}
          onEnter={() => firstRow()?.click()}
        />
      </div>
      <div ref={scroll} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain" data-testid="sheet-sections-scroll">
        <OutlineList {...props} mode="flat" tall scrollRef={scroll} listRef={list} />
      </div>
    </div>
  );
}
