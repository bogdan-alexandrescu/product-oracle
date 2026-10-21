"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

import { BuildRoadmapButton, SourceLink } from "@/components/BuildRoadmap";
import { CommentPopover, SelectionButton, type PageRect } from "@/components/CommentPopover";
import { DocStatusChip } from "@/app/documents/_components/DocStatusChip";
import { DocCrumb } from "@/components/DocToolbar";
import { Button, Chip, Empty, Icon, InfoTip, LinkButton, Page, PageHeader, SegmentedControl, Sheet } from "@/components/ds";
import type { GoTo } from "@/components/FeedbackPanel";
import { DEFAULT_FILTERS, type FeedbackFilters, type PlacedComment } from "@/components/review/FeedbackList";
import {
  OutlineRail,
  ReviewProgress,
  SectionSwitcher,
  SectionsSheetBody,
  useOutlineFilter,
  useRailCollapsed,
} from "@/components/review/Outline";
import { Kbd } from "@/components/review/parts";
import { ReviewPanel, type PanelTab } from "@/components/review/ReviewPanel";
import { RoleNote } from "@/components/RoleNote";
import { DateMarker, type ExpandCtx, type Highlight } from "@/components/MarkdownBody";
import { SectionView } from "@/components/SectionView";
import { BuildDraftButton } from "@/components/NextDraft";
import { ApproveButton, ExportButtons } from "@/components/VersionActions";
import { VersionSwitcher } from "@/components/VersionSwitcher";
import { ErrorNote, Loading } from "@/components/ui";
import { resolveSelector, selectorFromRange, type TextQuoteSelector } from "@/lib/anchor";
import { api, unwrap, type CitationOut, type DateMarkOut, type SectionOut, type Verdict } from "@/lib/api/client";
import { feedbackEntries, openBySection } from "@/lib/feedback";
import { formatDate } from "@/lib/format";
import { blocksText, parseBlocks } from "@/lib/markdown";
import { hasRole, useMe } from "@/lib/me";
import { useDocumentView, type DocumentView } from "@/lib/preferences";
import { keyFromHash, sectionHref } from "@/lib/section-link";
import { useQuery } from "@/lib/use-query";
import { useViewportFit } from "@/lib/use-viewport-fit";

type Selection = { sectionKey: string; anchor: TextQuoteSelector; rect: PageRect };

const SECTION_LINK = /\]\(#([A-Za-z0-9][\w.:-]*)\)/g;

/** The section and the deeper sections that follow it. */
function subtree(sections: SectionOut[], key: string): SectionOut[] {
  const i = sections.findIndex((s) => s.section_key === key);
  if (i < 0) return [];
  const out = [sections[i]];
  for (const s of sections.slice(i + 1)) {
    if (s.level <= sections[i].level) break;
    out.push(s);
  }
  return out;
}

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
}

/** A plain click on a link: the page handles it (a modified click opens a tab as usual). */
function plainClick(e: MouseEvent) {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

/** Reads the current text selection when it lies inside a single section body. */
function readSelection(): Selection | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const el = (n: Node) => (n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement);
  const body = el(range.startContainer)?.closest<HTMLElement>("[data-section-body]");
  if (!body || body !== el(range.endContainer)?.closest("[data-section-body]")) return null;
  const anchor = selectorFromRange(body, range);
  if (!anchor) return null;
  const r = range.getBoundingClientRect();
  return {
    sectionKey: body.dataset.sectionBody!,
    anchor,
    rect: { top: r.top + window.scrollY, bottom: r.bottom + window.scrollY, left: r.left + window.scrollX },
  };
}

/**
 * A version under review, ONE SECTION AT A TIME (I3, 2026-10-19), with the navigation the
 * owner picked on 2026-10-20: an outline rail left of the section (>= 1280 px), a section
 * switcher above it below that, a Sections / Review bar with sheets on a phone, and a
 * three-tab review panel (Feedback, Sources, History). The open section is kept in the URL
 * hash (#key; the older #s-key also opens it).
 */
export function VersionView({ doc, n }: { doc: string; n: number }) {
  const router = useRouter();
  const { me, role } = useMe();
  // Viewers read; commenters also comment; approvers also set verdicts and approve.
  const canComment = hasRole(role, "commenter");
  const canDecide = hasRole(role, "approver");
  const docQ = useQuery(`doc|${doc}`, () => unwrap(api.GET("/v1/documents/{doc}", { params: { path: { doc } } })));
  const verQ = useQuery(`ver|${doc}|${n}`, () =>
    unwrap(api.GET("/v1/documents/{doc}/versions/{n}", { params: { path: { doc, n } } })),
  );
  // Commenters can cite public links on baseline items from any section.
  const graphQ = useQuery(`baseline-graph|${canComment}`, () =>
    canComment ? unwrap(api.GET("/v1/baseline/graph")) : Promise.resolve(null),
  );
  const commentsQ = useQuery(`comments|${doc}|${n}`, () =>
    unwrap(api.GET("/v1/documents/{doc}/versions/{n}/comments", { params: { path: { doc, n } } })),
  );
  const [refreshKey, setRefreshKey] = useState(0);
  // Every feedback item on the document: the panel's list and every open-feedback count.
  const feedbackQ = useQuery(
    `feedback|${doc}|${refreshKey}`,
    () => unwrap(api.GET("/v1/documents/{doc}/feedback", { params: { path: { doc } } })),
    { keepPrevious: true },
  );

  const [selection, setSelection] = useState<Selection | null>(null);
  const [composing, setComposing] = useState<Selection | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tab, setTab] = useState<PanelTab>("feedback");
  const [filters, setFilters] = useState<FeedbackFilters>(DEFAULT_FILTERS);
  // A link with ?feedback=open (the Inbox's): the Feedback tab on every section's open items,
  // the first one brought into view, once (ffb19 lane).
  const [feedbackFocus, setFeedbackFocus] = useState(false);
  const arrivedAtFeedback = useRef(false);
  // Navigation: the switcher's popover, the phone's sheets, the rail's collapsed state.
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [sheet, setSheet] = useState<"sections" | "review" | null>(null);
  const [railCollapsed, setRailCollapsed] = useRailCollapsed(me?.user_id ?? me?.token_id ?? null);
  const railFilter = useOutlineFilter();
  const switcherFilter = useOutlineFilter();
  const sheetFilter = useOutlineFilter();
  const railFilterRef = useRef<HTMLInputElement>(null);
  const inspectorRef = useRef<HTMLDivElement>(null);
  // The panel beside the section sticks and fits the viewport: its foot is always on screen.
  useViewportFit(inspectorRef, "(min-width: 1101px)");
  // O1f: the brief or the whole version; the choice is remembered per user. A comment
  // on a section the brief does not show switches this page to the full document only.
  const [savedView, saveView] = useDocumentView();
  const [viewOverride, setViewOverride] = useState<DocumentView | null>(null);
  // The open section, as the URL hash names it (#problem). Null: the first unreviewed one.
  const [hash, setHash] = useState<string | null>(null);
  // A link to a detail section (a roadmap's link to a PRD feature) opens this version on
  // the full document, until the reader picks a view.
  const [hashLink, setHashLink] = useState<{ n: number; hash: string } | null>(null);
  // The link this arrival has scrolled to: once per arrival, not on every view change.
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    const h = window.location.hash || null;
    scrolledTo.current = null;
    const params = new URLSearchParams(window.location.search);
    // ?feedback=open or ?feedback=staged (the Inbox's link for a document whose items are all staged).
    const feedbackParam = params.get("feedback");
    const toFeedback = feedbackParam === "open" || feedbackParam === "staged";
    arrivedAtFeedback.current = toFeedback;
    // ?tab=reports: where applying a next draft lands, on the version's History (C1e);
    // ?tab=history: the overview's link to Oracle's work on this version (D15).
    const toHistory = params.get("tab") === "reports" || params.get("tab") === "history";
    // Next writes an in-app navigation's URL, #hash included, only once the new page has
    // committed, so the hash cannot be read while rendering: read it here. This also runs
    // when Next shows a kept route again.
    /* eslint-disable react-hooks/set-state-in-effect */
    setHash(h);
    setHashLink(h ? { n, hash: h } : null);
    if (toFeedback) {
      setTab("feedback");
      setFilters({ ...DEFAULT_FILTERS, state: feedbackParam === "staged" ? "staged" : "open", scope: "all" });
      setFeedbackFocus(true);
      // On a phone the panel lives in the Review sheet.
      if (window.matchMedia("(max-width: 639px)").matches) setSheet("review");
    } else if (toHistory) {
      setTab("history");
      // On a phone History lives in the Review sheet.
      if (params.get("tab") === "history" && window.matchMedia("(max-width: 639px)").matches) setSheet("review");
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [doc, n]);
  // Back and forward between sections, and plain #links (a warning's section).
  useEffect(() => {
    const onNav = () => {
      if (window.location.pathname !== `/documents/${doc}/v/${n}`) return;
      const h = window.location.hash || null;
      setHash(h);
      setHashLink(h ? { n, hash: h } : null);
    };
    window.addEventListener("popstate", onNav);
    window.addEventListener("hashchange", onNav);
    return () => {
      window.removeEventListener("popstate", onNav);
      window.removeEventListener("hashchange", onNav);
    };
  }, [doc, n]);
  // Open detail section -> the brief section showing it.
  const [opened, setOpened] = useState<Map<string, string>>(() => new Map());
  const [scrollTarget, setScrollTarget] = useState<{ id: string; key: string } | null>(null);
  // Queries are scoped to this view: Next keeps recently visited routes mounted (hidden).
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  const version = verQ.data;
  const document_ = docQ.data;
  const versions = useMemo(() => document_?.versions ?? [], [document_]);
  const readOnly = !!version?.approved_at;
  const latest = versions.at(-1)?.number;
  const refine = useMemo(() => ({ doc, n }), [doc, n]);

  const sections = useMemo(() => version?.sections ?? [], [version]);
  const allKeys = useMemo(() => new Set(sections.map((s) => s.section_key)), [sections]);
  const briefSections = useMemo(() => sections.filter((s) => s.layer === "brief"), [sections]);
  const hasBrief = briefSections.length > 0;
  const linkKey = hashLink?.n === n ? keyFromHash(hashLink.hash, allKeys) : null;
  const linkedDetail = !!linkKey && !briefSections.some((s) => s.section_key === linkKey);
  const view: DocumentView = hasBrief ? (viewOverride ?? (linkedDetail ? "full" : savedView)) : "full";
  // Brief / Full says which sections exist; the strip and the arrows step through these.
  const shownSections = view === "brief" ? briefSections : sections;
  const hashKey = keyFromHash(hash, allKeys);
  const openSection =
    shownSections.find((s) => s.section_key === hashKey) ?? shownSections.find((s) => !s.verdict) ?? shownSections[0];
  const openKey = openSection?.section_key ?? null;
  const openIdx = openSection ? shownSections.indexOf(openSection) : -1;
  const prevSection = openIdx > 0 ? shownSections[openIdx - 1] : null;
  const nextSection = openIdx >= 0 ? shownSections[openIdx + 1] ?? null : null;
  // The next section without a verdict after the open one, wrapping round.
  const nextToReview =
    [...shownSections.slice(openIdx + 1), ...shownSections.slice(0, Math.max(0, openIdx))].find((s) => !s.verdict) ?? null;

  // Detail sections a brief section links to: each feature row and milestone expands.
  const expandable = useMemo(() => {
    const detail = new Set(sections.filter((s) => s.layer !== "brief").map((s) => s.section_key));
    const keys = new Set<string>();
    for (const s of briefSections) for (const m of s.body_md.matchAll(SECTION_LINK)) if (detail.has(m[1])) keys.add(m[1]);
    return keys;
  }, [sections, briefSections]);

  // The open section and the detail expanded inside it: what "This section" shows.
  const scopeKeys = useMemo(() => {
    if (!openKey) return null;
    const keys = new Set([openKey]);
    if (view === "brief") {
      for (const [k, origin] of opened) if (origin === openKey) for (const d of subtree(sections, k)) keys.add(d.section_key);
    }
    return keys;
  }, [openKey, view, opened, sections]);

  /** Opens a section: a new history entry, so back and forward step through sections. */
  const select = useCallback((key: string) => {
    setHash(`#${key}`);
    if (decodeURIComponent(window.location.hash.slice(1)) !== key) window.history.pushState(null, "", `#${key}`);
  }, []);

  const switchView = useCallback(
    (v: DocumentView) => {
      setViewOverride(null);
      setHashLink(null);
      saveView(v);
    },
    [saveView],
  );

  const toggleOpen = useCallback((key: string, origin: string) => {
    setOpened((prev) => {
      const next = new Map(prev);
      if (next.get(key) === origin) next.delete(key);
      else next.set(key, origin);
      return next;
    });
  }, []);

  const reviewInFull = useCallback(
    (key: string) => {
      setViewOverride("full");
      select(key);
    },
    [select],
  );

  // A new open section: bring the panel's top into view when it is above the screen (the
  // arrows at its foot). The outline keeps its current row in view itself.
  const shownKey = useRef<string | null>(null);
  useEffect(() => {
    if (!openKey) return;
    const before = shownKey.current;
    shownKey.current = openKey;
    const panel = panelRef.current;
    if (before && before !== openKey && panel && panel.getBoundingClientRect().top < 0) {
      panel.scrollIntoView({ block: "start" });
    }
  }, [openKey]);

  // Scroll to a comment once the section it is on has rendered (after a switch or Expand).
  useEffect(() => {
    if (!scrollTarget) return;
    const root = rootRef.current;
    const mark = root?.querySelector(`[data-comment-ids~="${scrollTarget.id}"]`);
    const el = mark ?? root?.querySelector(`#s-${CSS.escape(scrollTarget.key)}`);
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      setScrollTarget(null);
    }
  }, [scrollTarget, view, opened, version, openKey]);

  const parsed = useMemo(() => {
    const m = new Map<string, { blocks: ReturnType<typeof parseBlocks>; text: string }>();
    for (const s of version?.sections ?? []) {
      const blocks = parseBlocks(s.body_md);
      m.set(s.section_key, { blocks, text: blocksText(blocks) });
    }
    return m;
  }, [version]);

  const citations = useMemo(() => {
    const m = new Map<string, { citation: CitationOut; number: number }>();
    // E1: Oracle's sources first, then the ones an edit added (listed apart, numbered on).
    const ordered = [...(version?.citations.filter((c) => !c.added) ?? []), ...(version?.citations.filter((c) => c.added) ?? [])];
    ordered.forEach((c, i) => m.set(c.cite_key, { citation: c, number: i + 1 }));
    return m;
  }, [version]);

  const placed = useMemo(() => {
    if (!version || !commentsQ.data) return [];
    const order = new Map(version.sections.map((s) => [s.section_key, s]));
    return commentsQ.data
      .map((c) => {
        const text = parsed.get(c.section_key)?.text ?? "";
        const range = c.anchor ? resolveSelector(text, c.anchor) : null;
        return {
          ...c,
          heading: order.get(c.section_key)?.heading ?? c.section_key,
          anchored: !!range,
          range,
          ordinal: order.get(c.section_key)?.ordinal ?? 1e9,
        };
      })
      .sort((a, b) => a.ordinal - b.ordinal || (a.range?.start ?? 0) - (b.range?.start ?? 0));
  }, [version, commentsQ.data, parsed]);

  const highlights = useMemo(() => {
    const m = new Map<string, Highlight[]>();
    const add = (key: string, h: Highlight) => m.set(key, [...(m.get(key) ?? []), h]);
    for (const c of placed) {
      if (c.range && !c.resolved_at) add(c.section_key, { ...c.range, id: c.id, kind: "comment" });
    }
    if (composing) {
      const r = resolveSelector(parsed.get(composing.sectionKey)?.text ?? "", composing.anchor);
      if (r) add(composing.sectionKey, { ...r, id: "pending", kind: "pending" });
    }
    return m;
  }, [placed, composing, parsed]);

  // Track the text selection (mouse or keyboard) while no composer is open.
  useEffect(() => {
    if (composing || readOnly || !canComment) return;
    let frame = 0;
    const onChange = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setSelection(readSelection()));
    };
    document.addEventListener("selectionchange", onChange);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", onChange);
    };
  }, [composing, readOnly, canComment]);

  const openComposer = useCallback(() => {
    if (!selection) return;
    setComposing(selection);
    setSelection(null);
  }, [selection]);

  const closeComposer = useCallback(() => {
    setComposing(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  // A comment's quote opens its section (and the feature or milestone holding it in the
  // brief, else the full document), then scrolls to the quote.
  const scrollToComment = useCallback(
    (c: PlacedComment) => {
      setActiveId(c.id);
      const root = rootRef.current;
      const key = c.section_key;
      const mark = root?.querySelector(`[data-comment-ids~="${c.id}"]`);
      if (mark) {
        mark.scrollIntoView({ block: "center", behavior: "smooth" });
        return;
      }
      if (scopeKeys?.has(key)) {
        root?.querySelector(`#s-${CSS.escape(key)}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
        return;
      }
      if (shownSections.some((s) => s.section_key === key)) {
        select(key);
      } else {
        const holder = view === "brief" ? [...expandable].find((k) => subtree(sections, k).some((s) => s.section_key === key)) : undefined;
        const origin = holder && briefSections.find((s) => s.body_md.includes(`](#${holder})`));
        if (holder && origin) {
          setOpened((prev) => new Map(prev).set(holder, origin.section_key));
          select(origin.section_key);
        } else {
          setViewOverride("full");
          select(key);
        }
      }
      setScrollTarget({ id: c.id, key });
    },
    [scopeKeys, shownSections, select, view, expandable, sections, briefSections],
  );

  const onHighlightClick = useCallback((id: string) => {
    setActiveId(id);
    setTab("feedback");
  }, []);

  const bump = () => setRefreshKey((k) => k + 1);

  const onVerdict = useCallback(
    async (key: string, verdict: Verdict, note: string) => {
      await unwrap(
        api.PUT("/v1/documents/{doc}/versions/{n}/sections/{key}/review", {
          params: { path: { doc, n, key } },
          body: { verdict, note: note || null },
        }),
      );
      // Stay on the section just reviewed (without a hash, the first unreviewed one opens).
      setHash(`#${key}`);
      await Promise.all([verQ.reload(), docQ.reload()]);
      bump();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, n],
  );

  async function submitComment(body: string) {
    if (!composing) return;
    const c = await unwrap(
      api.POST("/v1/documents/{doc}/versions/{n}/comments", {
        params: { path: { doc, n } },
        body: { section_key: composing.sectionKey, anchor: composing.anchor, body },
      }),
    );
    await commentsQ.reload();
    closeComposer();
    setActiveId(c.id);
    setTab("feedback");
    setFilters((f) => ({ ...f, state: "open" }));
    bump();
    docQ.reload();
  }

  async function reply(id: string, body: string) {
    await unwrap(api.POST("/v1/comments/{comment_id}/replies", { params: { path: { comment_id: id } }, body: { body } }));
    await commentsQ.reload();
  }

  async function resolve(id: string, resolved: boolean) {
    await unwrap(api.PATCH("/v1/comments/{comment_id}", { params: { path: { comment_id: id } }, body: { resolved } }));
    await Promise.all([commentsQ.reload(), feedbackQ.reload()]);
  }

  /** "/": the outline's filter where the rail shows, else the switcher's, else the phone's Sections sheet. */
  const focusFilter = useCallback(() => {
    const rail = railFilterRef.current;
    if (rail?.checkVisibility()) {
      rail.focus();
      rail.select();
    } else if (window.matchMedia("(min-width: 640px)").matches) {
      setSwitcherOpen(true);
    } else {
      setSheet("sections");
    }
  }, []);

  // Keyboard: [ ] (or j k, Shift + arrows) step sections, { } versions, c comments on the
  // selection, v brief / full.
  useEffect(() => {
    const step = (d: 1 | -1) => {
      const target = shownSections[openIdx + d];
      if (target) select(target.section_key);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      // Not inside a dialog (the sheets, the build sheet, the switcher): its keys are its own.
      if ((e.target as HTMLElement | null)?.closest?.("[role=dialog]")) return;
      if (e.key === "/") {
        e.preventDefault();
        focusFilter();
      } else if (e.key === "[" || e.key === "]" || e.key === "j" || e.key === "k") {
        step(e.key === "]" || e.key === "j" ? 1 : -1);
      } else if (e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        // Not while extending a text selection, nor inside a control that uses the arrows.
        if (window.getSelection()?.isCollapsed === false) return;
        if ((e.target as HTMLElement | null)?.closest?.("[role=tablist], [role=group]")) return;
        e.preventDefault();
        step(e.key === "ArrowRight" ? 1 : -1);
      } else if (e.key === "v" && hasBrief) {
        switchView(view === "brief" ? "full" : "brief");
      } else if (e.key === "c" && selection) {
        e.preventDefault();
        openComposer();
      } else if ((e.key === "{" || e.key === "}") && versions.length) {
        const i = versions.findIndex((v) => v.number === n);
        const target = versions[i + (e.key === "}" ? 1 : -1)];
        if (target) router.push(`/documents/${doc}/v/${target.number}`);
      } else if (e.key === "Escape") {
        setSelection(null);
        setActiveId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, openComposer, versions, n, doc, router, hasBrief, view, switchView, shownSections, openIdx, select, focusFilter]);

  // Every in-page link to a section of this version (feedback, reports, banners, the
  // document's own #links) opens it here: one handler for both #key and #s-key.
  const onLinkCapture = (e: MouseEvent<HTMLDivElement>) => {
    if (!plainClick(e) || e.defaultPrevented) return;
    const a = (e.target as Element).closest?.("a[href]") as HTMLAnchorElement | null;
    // Links that open their section themselves (the outline, the arrows) are left to it.
    if (!a || a.hasAttribute("data-own-nav") || a.target === "_blank" || a.origin !== window.location.origin || !a.hash) return;
    if (a.pathname !== window.location.pathname) return;
    const key = keyFromHash(a.hash, allKeys);
    if (!key) return;
    e.preventDefault();
    if (!shownSections.some((s) => s.section_key === key)) setViewOverride("full");
    select(key);
    setSheet(null);
  };

  // A link to a section (#problem, #s-problem) brings its panel into view, once per arrival.
  useEffect(() => {
    if (!version || !hashLink || hashLink.n !== n || !openKey || openKey !== keyFromHash(hashLink.hash, allKeys)) return;
    if (scrolledTo.current === `${n}${hashLink.hash}`) return;
    scrolledTo.current = `${n}${hashLink.hash}`;
    // Arriving at the open feedback, the review panel scrolls to the first item instead.
    if (arrivedAtFeedback.current) {
      arrivedAtFeedback.current = false;
      return;
    }
    const panel = panelRef.current;
    if (panel && (panel.getBoundingClientRect().top < 0 || panel.getBoundingClientRect().top > window.innerHeight * 0.6)) {
      panel.scrollIntoView({ block: "start" });
    }
  }, [version, n, hashLink, openKey, allKeys]);

  const changedLocks = new Set(
    version?.warnings.filter((w) => w.code === "locked_section_changed").flatMap((w) => w.section_keys) ?? [],
  );
  // O4 'document dates': a roadmap's dates that rest on no verified basis now, by section.
  const dateMarks = useMemo(() => {
    const bySection = new Map<string, DateMarkOut[]>();
    for (const m of version?.date_marks ?? []) {
      if (m.label) bySection.set(m.section_key, [...(bySection.get(m.section_key) ?? []), m]);
    }
    return bySection;
  }, [version]);
  const titleMarks = (version?.date_marks ?? []).filter((m) => m.label && m.where === "title");
  // Owner, 2026-10-20: a roadmap version cannot be approved while a date is marked.
  const flaggedDates = [
    ...new Map((version?.date_marks ?? []).filter((m) => m.label).map((m) => [`${m.text}|${m.label}`, m])).values(),
  ];
  const approveBlocked =
    flaggedDates.length > 0
      ? `${flaggedDates.length} date${flaggedDates.length === 1 ? " rests" : "s rest"} on no verified schedule basis: ${flaggedDates
          .map((m) => `${m.text} (${m.label})`)
          .join(", ")}. Record a basis or import a draft without ${flaggedDates.length === 1 ? "it" : "them"}.`
      : undefined;
  const sectionProps = (s: SectionOut) => ({
    section: s,
    blocks: parsed.get(s.section_key)!.blocks,
    citations,
    highlights: highlights.get(s.section_key) ?? NO_HIGHLIGHTS,
    activeCommentId: activeId,
    readOnly: readOnly || !canDecide,
    changedLock: changedLocks.has(s.section_key),
    evidenceTargets: canComment ? graphQ.data?.entities : undefined,
    refine: canDecide && !readOnly && n === latest ? refine : undefined,
    onHighlightClick,
    onVerdict,
    showLayer: hasBrief,
    dateMarks: dateMarks.get(s.section_key),
  });
  const expandFor = (origin: string): ExpandCtx => ({
    keys: expandable,
    open: opened,
    origin,
    toggle: toggleOpen,
    render: (key) =>
      subtree(sections, key).map((d) => (
        <SectionView key={d.id} {...sectionProps(d)} nested onReviewInFull={canDecide && !readOnly ? reviewInFull : undefined} />
      )),
  });

  // A section is locked once its version is approved; before that an approved section is
  // 'Approved'. A lapsed approval (C2) does not lock it.
  const lockedCount =
    version?.sections.filter((s) => s.verdict?.verdict === "approved" && !s.verdict.lapsed_at).length ?? 0;
  const reviewedCount = version?.sections.filter((s) => s.verdict).length ?? 0;
  const reviewedShown = shownSections.filter((s) => s.verdict).length;
  const error = docQ.error || verQ.error;
  const warnings = version?.warnings ?? [];

  // Feedback: one list, one definition of "open" (lib/feedback.ts) for every count.
  const entries = useMemo(
    () => (feedbackQ.data && commentsQ.data ? feedbackEntries(feedbackQ.data, commentsQ.data, n) : null),
    [feedbackQ.data, commentsQ.data, n],
  );
  const openCounts = useMemo(() => (entries ? openBySection(entries) : NO_COUNTS), [entries]);
  const openFeedback = entries ? entries.filter((e) => e.open).length : null;
  const sectionOpen = scopeKeys ? [...scopeKeys].reduce((sum, k) => sum + (openCounts.get(k) ?? 0), 0) : 0;
  const headings = useMemo(() => new Map(sections.map((s) => [s.section_key, s.heading])), [sections]);
  const placedById = useMemo(() => new Map(placed.map((c) => [c.id, c])), [placed]);

  /** A feedback item's "Go to": this version's section here (the full document when the brief hides it). */
  const goTo: GoTo = useMemo(
    () => ({
      keys: allKeys,
      headings,
      open: (key: string) => {
        setSheet(null);
        if (!shownSections.some((s) => s.section_key === key)) setViewOverride("full");
        select(key);
      },
    }),
    [allKeys, headings, shownSections, select],
  );
  const feedbackFocused = useCallback(() => setFeedbackFocus(false), []);
  // Opening Feedback reads the items again: Oracle may have answered a comment meanwhile.
  const openTab = (t: PanelTab) => {
    if (t === "feedback" && tab !== "feedback") void feedbackQ.reload();
    setTab(t);
  };

  const showFeedback = () => {
    setTab("feedback");
    if (window.matchMedia("(max-width: 639px)").matches) setSheet("review");
    else inspectorRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  const outlineProps = {
    doc,
    n,
    sections: shownSections,
    openKey,
    openCounts,
    closed: readOnly,
    onSelect: (key: string) => {
      select(key);
      setSheet(null);
    },
  };
  // The rail shows at >= 1280 px unless the reader hid it; the switcher stands in for it.
  const rail = !railCollapsed;

  const sectionLink = (s: SectionOut, dir: "prev" | "next", divided: boolean) => (
    <a
      href={sectionHref(doc, n, s.section_key)}
      rel={dir}
      aria-label={`${dir === "prev" ? "Previous" : "Next"} section: ${s.heading}`}
      data-own-nav
      onClick={(e) => {
        if (!plainClick(e)) return;
        e.preventDefault();
        select(s.section_key);
      }}
      className={`flex min-h-14 min-w-0 flex-1 items-center gap-2 px-4 py-2 hover:bg-surface2 max-[600px]:px-3 ${
        dir === "next" ? `justify-end text-right ${divided ? "border-l border-line" : ""}` : ""
      }`}
    >
      {dir === "prev" && (
        <span className="flex-none text-text2">
          <Icon name="chevron-left" size={16} />
        </span>
      )}
      <span className="flex min-w-0 flex-col">
        <span className="text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2">
          {dir === "prev" ? "Previous" : "Next"}
        </span>
        <span className="truncate text-sm leading-5 font-semibold text-text">{s.heading}</span>
      </span>
      {dir === "next" && (
        <span className="flex-none text-text2">
          <Icon name="chevron-right" size={16} />
        </span>
      )}
    </a>
  );

  const shortcuts = (
    <InfoTip label="keyboard shortcuts" hero side="bottom">
      <span className="flex flex-col gap-1.5">
        <span className="flex items-center gap-1.5">
          <Kbd>j</Kbd>
          <Kbd>k</Kbd> or <Kbd>[</Kbd>
          <Kbd>]</Kbd> sections
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>/</Kbd> filter sections
        </span>
        {canComment && (
          <span className="flex items-center gap-1.5">
            <Kbd>c</Kbd> comment on selection
          </span>
        )}
        <span className="flex items-center gap-1.5">
          <Kbd>{"{"}</Kbd>
          <Kbd>{"}"}</Kbd> versions
        </span>
        {hasBrief && (
          <span className="flex items-center gap-1.5">
            <Kbd>v</Kbd> brief / full
          </span>
        )}
      </span>
    </InfoTip>
  );

  const panel = (variant: "side" | "sheet") => (
    <ReviewPanel
      variant={variant}
      version={version}
      doc={doc}
      n={n}
      stats={{ reviewed: reviewedCount, total: sections.length, locked: lockedCount, lockedLabel: version?.approved_at ? "Locked" : "Approved", openFeedback }}
      openFeedback={openFeedback}
      tab={tab}
      setTab={openTab}
      goTo={goTo}
      refreshKey={refreshKey}
      shortcuts={variant === "side" ? shortcuts : undefined}
      feedback={{
        entries,
        error: feedbackQ.error || commentsQ.error,
        scopeKeys: openSection ? scopeKeys : null,
        filters,
        setFilters,
        doc,
        n,
        headings,
        placed: placedById,
        activeId,
        readOnly,
        canComment,
        canDecide,
        userId: me?.user_id ?? me?.token_id ?? null,
        showLayer: hasBrief,
        goTo,
        focus: feedbackFocus && !!version,
        onFocused: feedbackFocused,
        onShowComment: (c) => {
          setSheet(null);
          scrollToComment(c);
        },
        onReply: reply,
        onResolve: resolve,
        // A decision on an item: its counts, and the comment it may have resolved.
        onChanged: () => {
          void feedbackQ.reload();
          void commentsQ.reload();
        },
      }}
    />
  );

  return (
    <div ref={rootRef} onClickCapture={onLinkCapture} className="max-[639px]:pb-16">
      <Page>
        <PageHeader
          testId="doc-header"
          back={<DocCrumb doc={document_} withTitle={false} />}
          title={
            titleMarks.length ? (
              <>
                {document_?.title ?? "…"}
                {titleMarks.map((m) => (
                  <DateMarker key={m.text} mark={m} />
                ))}
              </>
            ) : (
              (document_?.title ?? "…")
            )
          }
          suffix={<span className="font-mono">v{n}</span>}
          status={
            <>
              {document_ && (
                <span data-testid="doc-status" className="inline-flex">
                  <DocStatusChip status={document_.status} />
                </span>
              )}
              {latest != null && n !== latest && <Chip kind="na">Earlier version</Chip>}
              {warnings.length > 0 && (
                <Chip kind="warn">
                  {warnings.length} warning{warnings.length === 1 ? "" : "s"}
                </Chip>
              )}
              {!readOnly && <RoleNote role={role} />}
            </>
          }
          action={
            <>
              {/* C1e: accepted changes staged for the next draft, built in one job. */}
              {document_?.kind === "prd" && <BuildDraftButton doc={doc} />}
              {version &&
                (version.approved_at || canDecide) &&
                (document_?.kind === "prd" && !version.approved_at ? (
                  // T2 publish gate: a PRD is published from the Publish screen, latest version only.
                  <LinkButton
                    variant="primary"
                    icon="check"
                    href={`/documents/${doc}/publish`}
                    aria-description={n !== latest && latest != null ? `Publishes v${latest}, the latest version` : undefined}
                    data-testid="publish-link"
                  >
                    Publish
                  </LinkButton>
                ) : (
                  <ApproveButton
                    doc={doc}
                    n={n}
                    approvedAt={version.approved_at}
                    isLatest={n === latest}
                    blockedReason={approveBlocked}
                    onApproved={() => {
                      verQ.reload();
                      docQ.reload();
                    }}
                  />
                ))}
            </>
          }
        />

        <div className="mb-3 flex flex-wrap items-center gap-2 max-[600px]:gap-y-2.5">
          {versions.length > 0 && <VersionSwitcher doc={doc} versions={versions} current={n} variant="segments" />}
          {hasBrief && (
            <SegmentedControl<DocumentView>
              label="Document view"
              value={view}
              onChange={switchView}
              items={[
                { value: "brief", label: "Brief" },
                { value: "full", label: "Full" },
              ]}
            />
          )}
          {n > 1 && (
            <LinkButton variant="ghost" href={`/documents/${doc}/diff?from=${n - 1}&to=${n}`}>
              Compare with v{n - 1}
            </LinkButton>
          )}
          {version?.source && (
            <span className="text-sm text-text2">
              <SourceLink source={version.source} />
            </span>
          )}
          <span className="flex-1" />
          {hasBrief && (
            <LinkButton icon="monitor" href={`/documents/${doc}/v/${n}/present`}>
              Present
            </LinkButton>
          )}
          <ExportButtons doc={doc} n={n} hasBrief={hasBrief} />
          {document_?.kind === "prd" && n === latest && !canDecide && (
            <LinkButton icon="check" href={`/documents/${doc}/publish`}>
              Check readiness
            </LinkButton>
          )}
          {document_?.kind === "prd" && <BuildRoadmapButton prd={document_} size="sm" />}
        </div>

        {hasBrief && (
          <p
            data-testid="view-note"
            className="mb-3 flex flex-wrap items-center gap-1.5 text-sm text-text2"
          >
            {view === "brief" ? (
              <>
                <span className="tnum whitespace-nowrap">
                  <b className="font-semibold text-text">Brief</b>: {briefSections.length} of {sections.length} sections
                </span>
                <InfoTip label="the brief" side="bottom">
                  Expand a feature or milestone to see its detail.
                </InfoTip>
                <Button variant="ghost" onClick={() => switchView("full")}>
                  Show full document
                </Button>
              </>
            ) : (
              <>
                <span className="tnum whitespace-nowrap">
                  <b className="font-semibold text-text">Full document</b>: all {sections.length} sections
                </span>
                <InfoTip label="the full document" side="bottom">
                  The {briefSections.length} sections marked Brief make up the brief.
                </InfoTip>
                <Button variant="ghost" onClick={() => switchView("brief")}>
                  Show brief
                </Button>
              </>
            )}
          </p>
        )}

        {version && (latest != null && n !== latest || warnings.length > 0 || readOnly) && (
          <div className="mb-4 flex flex-col gap-2">
            {latest != null && n !== latest && (
              <p role="status" className="flex flex-wrap items-center gap-x-2 rounded-button bg-accent-soft px-3 py-2 text-sm font-medium text-accent-ink">
                You are viewing an earlier version.
                <Link href={`/documents/${doc}/v/${latest}`} className="font-semibold underline underline-offset-2">
                  Go to v{latest} (latest)
                </Link>
              </p>
            )}
            {warnings.map((w, i) => (
              <div key={i} role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-button bg-warn-bg px-3 py-2 text-sm text-warn">
                <Icon name="alert" size={16} />
                <p className="min-w-0 flex-1 font-medium">{w.message}</p>
                {w.section_keys.map((k) => (
                  <a
                    key={k}
                    href={sectionHref(doc, n, k)}
                    data-own-nav
                    onClick={(e) => {
                      if (!plainClick(e)) return;
                      e.preventDefault();
                      if (!shownSections.some((s) => s.section_key === k)) setViewOverride("full");
                      select(k);
                    }}
                    className="font-mono text-[13px] font-medium underline underline-offset-2"
                  >
                    #{k}
                  </a>
                ))}
              </div>
            ))}
            {readOnly && (
              <p role="status" className="rounded-button bg-pass-bg px-3 py-2 text-sm font-medium text-pass">
                Approved {formatDate(version.approved_at!)} · review is closed
              </p>
            )}
          </div>
        )}

        {/* The outline rail (>= 1280 px), the section with the switcher above it below that,
            and the review panel; each column sticks and scrolls inside itself. */}
        <div
          data-testid="prd-layout"
          className={`grid items-start gap-4 max-[1100px]:grid-cols-1 max-[600px]:gap-3 ${
            rail ? "grid-cols-[minmax(0,1fr)_380px] min-[1280px]:grid-cols-[280px_minmax(0,1fr)_380px]" : "grid-cols-[minmax(0,1fr)_380px]"
          }`}
        >
          {rail && version && (
            <div className="hidden min-w-0 self-stretch min-[1280px]:block">
              <OutlineRail {...outlineProps} filter={railFilter} filterRef={railFilterRef} onCollapse={() => setRailCollapsed(true)} />
            </div>
          )}
          <div className="flex min-w-0 flex-col gap-3">
            {version && shownSections.length > 0 && (
              <div className={`max-[639px]:hidden ${rail ? "min-[1280px]:hidden" : ""}`}>
                <SectionSwitcher
                  {...outlineProps}
                  filter={switcherFilter}
                  open={switcherOpen}
                  setOpen={setSwitcherOpen}
                  prev={prevSection}
                  next={nextSection}
                  nextToReview={nextToReview}
                  leading={
                    railCollapsed ? (
                      <button
                        type="button"
                        onClick={() => setRailCollapsed(false)}
                        aria-label="Show outline"
                        title="Show outline"
                        data-testid="outline-expand"
                        className="hidden size-9 flex-none place-items-center rounded-lg text-text2 hover:bg-surface2 hover:text-text min-[1280px]:grid"
                      >
                        <Icon name="outline" size={20} />
                      </button>
                    ) : undefined
                  }
                />
              </div>
            )}
            <article
              ref={panelRef}
              aria-label="Document"
              className="min-w-0 scroll-mt-3 rounded-panel border border-line bg-surface shadow-panel"
            >
              {error && (
                <div className="p-4">
                  <ErrorNote>{error}</ErrorNote>
                </div>
              )}
              {!error && !version && (
                <div className="px-4 py-6">
                  <Loading label="Loading version…" />
                </div>
              )}
              {version && !openSection && <Empty>No sections</Empty>}
              {version && openSection && (
                <>
                  <div data-testid="document-sections" data-view={view} data-open={openKey}>
                    <SectionView
                      key={openSection.id}
                      {...sectionProps(openSection)}
                      expand={view === "brief" ? expandFor(openSection.section_key) : undefined}
                      headTools={
                        <Button
                          icon="comment"
                          className="min-[1101px]:hidden max-[639px]:hidden"
                          onClick={showFeedback}
                          aria-label={`Open feedback on this section: ${sectionOpen}`}
                        >
                          Feedback <b className="tnum text-accent-ink">{sectionOpen}</b>
                        </Button>
                      }
                    />
                  </div>
                  {(prevSection || nextSection) && (
                    <nav aria-label="Previous and next section" className="flex items-stretch border-t border-line">
                      {prevSection && sectionLink(prevSection, "prev", false)}
                      {nextSection && sectionLink(nextSection, "next", !!prevSection)}
                    </nav>
                  )}
                </>
              )}
            </article>
          </div>
          <div className="min-w-0 self-stretch max-[639px]:hidden">
            <div
              ref={inspectorRef}
              data-testid="review-panel-column"
              className="scroll-mt-3 min-[1101px]:sticky min-[1101px]:top-4 min-[1101px]:flex min-[1101px]:max-h-[calc(100dvh-2rem)] min-[1101px]:flex-col"
            >
              {panel("side")}
            </div>
          </div>
        </div>
      </Page>

      {/* Phone: Sections and Review, each opening a sheet. */}
      {version && (
        <div
          data-testid="phone-bar"
          className="fixed inset-x-0 bottom-0 z-30 hidden grid-cols-2 gap-2 border-t border-line bg-surface px-3 pt-1.5 pb-[calc(6px+env(safe-area-inset-bottom))] shadow-tip max-[639px]:grid max-[600px]:bottom-[68px] max-[600px]:pb-1.5"
        >
          <button
            type="button"
            onClick={() => setSheet("sections")}
            aria-haspopup="dialog"
            data-testid="phone-sections"
            className="flex h-11 min-w-0 items-center justify-center gap-2 rounded-button border border-line-strong px-3 text-[15px] font-semibold text-text"
          >
            <span className="truncate">Sections</span>
            <span className="tnum flex-none text-text2">
              · {openIdx + 1}/{shownSections.length}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setSheet("review")}
            aria-haspopup="dialog"
            data-testid="phone-review"
            className="flex h-11 min-w-0 items-center justify-center gap-2 rounded-button bg-accent px-3 text-[15px] font-semibold text-on-accent"
          >
            <span className="truncate">Review</span>
            <span className="tnum flex-none">· {openFeedback ?? "–"}</span>
          </button>
        </div>
      )}
      <Sheet open={sheet === "sections"} title="Sections" onClose={() => setSheet(null)} testId="sheet-sections" scroll={false}>
        <SectionsSheetBody
          {...outlineProps}
          filter={sheetFilter}
          header={<ReviewProgress reviewed={reviewedShown} total={shownSections.length} />}
        />
      </Sheet>
      <Sheet open={sheet === "review"} title="Review" onClose={() => setSheet(null)} testId="sheet-review">
        {panel("sheet")}
      </Sheet>

      {selection && !composing && <SelectionButton rect={selection.rect} onOpen={openComposer} />}
      {composing && (
        <CommentPopover rect={composing.rect} anchor={composing.anchor} onCancel={closeComposer} onSubmit={submitComment} />
      )}
    </div>
  );
}

const NO_HIGHLIGHTS: Highlight[] = [];
const NO_COUNTS: ReadonlyMap<string, number> = new Map();
