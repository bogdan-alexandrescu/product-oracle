"use client";

import { RoleBadge } from "@/components/RoleBadge";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";

import { BuildRoadmapButton, SourceLink } from "@/components/BuildRoadmap";
import { CommentPopover, SelectionButton, type PageRect } from "@/components/CommentPopover";
import { DocStatusChip } from "@/app/documents/_components/DocStatusChip";
import { DocCrumb } from "@/components/DocToolbar";
import { PricingDecide } from "@/components/PricingDecide";
import { Button, Chip, Empty, Icon, InfoTip, LinkButton, NotFoundPanel, Page, PageHeader, SegmentedControl, Sheet } from "@/components/ds";
import { DocumentNotFound } from "@/components/DocumentNotFound";
import { DiscussionThread } from "@/components/discuss/DiscussionThread";
import { StartDiscussion, type DiscussionSubject } from "@/components/discuss/StartDiscussion";
import { SectionQuestions, type GoTo } from "@/components/FeedbackPanel";
import { HeldRewritesButton, HeldRewritesPanel, useHeldRewrites } from "@/components/HeldRewrites";
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
import { RunReviewBar } from "@/components/review/RunReviewBar";
import { useDateRights } from "@/components/DateBasisDialog";
import { DateMarkContext, type DateMarkCtx } from "@/components/DateMarker";
import { DateMarker, type ExpandCtx, type Highlight } from "@/components/MarkdownBody";
import { DraftNewItems } from "@/components/DraftNewItems";
import { DraftWithOracleButton, isTemplateOnly } from "@/components/DraftWithOracle";
import { SectionView } from "@/components/SectionView";
import { SpecDesignLinks } from "@/components/DesignReview";
import { SpecStaleness } from "@/components/SpecStaleness";
import { buildCodeIndex } from "@/lib/code-index";
import { useCodeEntities } from "@/lib/codes";
import { BuildDraftButton } from "@/components/NextDraft";
import { DraftRoadmapPane } from "@/components/roadmap/DraftRoadmapPane";
import { RoadmapItemsPane } from "@/components/roadmap/RoadmapItemsPane";
import { VersionTabs } from "@/components/roadmap/VersionTabs";
import { ApproveButton, ExportButtons } from "@/components/VersionActions";
import { EvidencePane } from "@/components/evidence/EvidencePane";
import { VersionSwitcher } from "@/components/VersionSwitcher";
import { ErrorNote, Loading } from "@/components/ui";
import { resolveSelector, selectorFromRange, type TextQuoteSelector } from "@/lib/anchor";
import { ApiError, api, unwrap, type CitationOut, type DateMarkOut, type SectionOut, type Verdict } from "@/lib/api/client";
import { draftRoadmapOf } from "@/lib/api/draft-roadmap";
import { feedbackEntries, openBySection } from "@/lib/feedback";
import { formatDate } from "@/lib/format";
import { blocksText, parseBlocks } from "@/lib/markdown";
import { useMe } from "@/lib/me";
import { OWNER_APPROVES } from "@/lib/owner-kinds";
import { useDocumentView, type DocumentView } from "@/lib/preferences";
import { useScreenSubject } from "@/lib/screen-subject";
import { keyFromHash, sectionHref } from "@/lib/section-link";
import { useLiveRefresh } from "@/lib/use-live-refresh";
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

const PHONE = "(max-width: 639px)";
/** e2e-review-live: how often an open run review re-reads the review state (as the meeting chat does). */
const LIVE_POLL_MS = 5_000;
function subscribePhone(cb: () => void) {
  const mq = window.matchMedia(PHONE);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
/** A phone-width window; false on the server and while hydrating, so both render the same. */
function usePhone() {
  return useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE).matches, () => false);
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
 *
 * A roadmap version has two page tabs under its header (E2): Document (this view) and Items
 * (`pane="items"`, its items as rows). The header, toolbar, warnings and Approve are the same
 * on both, so approval and date marks never differ between tabs. A PRD version has Document
 * and Roadmap (E1, `pane="roadmap"`: the draft's items-only roadmap).
 */
export function VersionView({ doc, n, pane = "document" }: { doc: string; n: number; pane?: "document" | "items" | "roadmap" | "evidence" }) {
  const router = useRouter();
  const onDocument = pane === "document";
  const { me, can, capsReady, capsError } = useMe();
  // #370: what the signed-in person may call. Comments (create_comment); section verdicts
  // (review_section), which also stand for the other decisions on a version.
  const canComment = can("create_comment");
  const canDecide = can("review_section");
  // qa-shell-4: a document (or version) the API does not have (404) shows one not-found
  // state and no actions. A missing document wins over its missing version.
  const [missing, setMissing] = useState<"doc" | "version" | null>(null);
  const docQ = useQuery(`doc|${doc}`, () =>
    unwrap(api.GET("/v1/documents/{doc}", { params: { path: { doc } } })).catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 404) setMissing("doc");
      throw e;
    }),
  );
  const verQ = useQuery(`ver|${doc}|${n}`, () =>
    unwrap(api.GET("/v1/documents/{doc}/versions/{n}", { params: { path: { doc, n } } })).catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 404) setMissing((m) => (m === "doc" ? m : "version"));
      throw e;
    }),
  );
  // Commenters can cite public links on baseline items from any section.
  const graphQ = useQuery(`baseline-graph|${canComment}`, () =>
    canComment ? unwrap(api.GET("/v1/baseline/graph")) : Promise.resolve(null),
  );
  const commentsQ = useQuery(`comments|${doc}|${n}`, () =>
    unwrap(api.GET("/v1/documents/{doc}/versions/{n}/comments", { params: { path: { doc, n } } })),
  );
  const [refreshKey, setRefreshKey] = useState(0);
  // #347: each section's review state (re-review asked, its owner) and the held agent rewrites.
  const statesQ = useQuery(`section-states|${doc}|${n}`, () =>
    unwrap(api.GET("/v1/documents/{doc}/versions/{n}/section-states", { params: { path: { doc, n } } })).catch(() => null),
  );
  const held = useHeldRewrites(doc);
  const [heldOpen, setHeldOpen] = useState(false);
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
  // G1: a discussion open in the Feedback tab (its thread), or one being started.
  // qa-docs-33: `feedback`, a thread just started that is also the review's whole-draft feedback.
  const [discussion, setDiscussion] = useState<{ id: string; changes?: boolean; feedback?: boolean } | { start: DiscussionSubject } | null>(null);
  const [discussionsKey, setDiscussionsKey] = useState(0);
  // A link with ?feedback=open (the Inbox's): the Feedback tab on every section's open items,
  // the first one brought into view, once (ffb19 lane).
  const [feedbackFocus, setFeedbackFocus] = useState(false);
  const arrivedAtFeedback = useRef(false);
  // Navigation: the switcher's popover, the phone's sheets, the rail's collapsed state.
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [sheet, setSheet] = useState<"sections" | "review" | "more" | null>(null);
  const phone = usePhone();
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
    // ?discussion=<id> (G6, the Inbox's link): its thread in the Feedback tab; &changes=1
    // scrolls the thread to its changes card.
    const toDiscussion = params.get("discussion");
    // Next writes an in-app navigation's URL, #hash included, only once the new page has
    // committed, so the hash cannot be read while rendering: read it here. This also runs
    // when Next shows a kept route again.
    /* eslint-disable react-hooks/set-state-in-effect */
    setHash(h);
    setHashLink(h ? { n, hash: h } : null);
    if (toDiscussion) {
      setTab("feedback");
      setDiscussion({ id: toDiscussion, changes: params.get("changes") === "1" });
      if (window.matchMedia("(max-width: 639px)").matches) setSheet("review");
    } else if (toFeedback) {
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
  // qa-docs-8: on a phone the Sections / Review bar sits on the app's tab bar. The page's scroll
  // padding at the bottom is set to both bars (the room from the bar's top to the screen's
  // bottom), so a section's end or its Prev/Next scrolled into view stops clear of both.
  const [phoneBar, setPhoneBar] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = phoneBar;
    if (!el) return;
    // qa-docs-9: every mounted view's bar is counted, so the hidden one Next keeps of the
    // version left (v2 -> v1) never clears the padding the shown one set.
    PHONE_BARS.add(el);
    fitPhoneBars();
    const watch = new ResizeObserver(fitPhoneBars);
    watch.observe(el);
    window.addEventListener("resize", fitPhoneBars);
    return () => {
      watch.disconnect();
      window.removeEventListener("resize", fitPhoneBars);
      PHONE_BARS.delete(el);
      fitPhoneBars();
    };
  }, [phoneBar]);
  const panelRef = useRef<HTMLElement>(null);

  const version = verQ.data;
  const document_ = docQ.data;
  // The document's discussions (G1): the Feedback tab's fourth kind, never open feedback.
  const documentId = document_?.id;
  const discussionsQ = useQuery(
    `discussions|${documentId}|${discussionsKey}`,
    () =>
      documentId
        ? unwrap(api.GET("/v1/discussions", { params: { query: { document_id: documentId, limit: 100 } } })).then((r) => r.items)
        : Promise.resolve(null),
    { keepPrevious: true },
  );
  const isRoadmap = document_?.kind === "roadmap";
  // The Items tab's count (E2): the version's items, brief view.
  const itemCountQ = useQuery(`roadmap-item-count|${doc}|${n}|${isRoadmap}`, () =>
    isRoadmap
      ? unwrap(api.GET("/v1/roadmaps/{doc}/items", { params: { path: { doc }, query: { version: n, view: "brief" } } }))
          .then((r) => r.items.length)
          .catch(() => null)
      : Promise.resolve(null),
  );
  // The pane's own URL for another version: the switcher keeps the tab.
  const paneHref = useCallback(
    (v: number) =>
      pane === "items" && isRoadmap
        ? `/documents/${doc}/v/${v}/items`
        : pane === "roadmap" && document_?.kind === "prd"
          ? `/documents/${doc}/v/${v}/roadmap`
          : pane === "evidence" && document_?.kind === "prd"
            ? `/documents/${doc}/v/${v}/evidence`
            : `/documents/${doc}/v/${v}`,
    [pane, isRoadmap, document_?.kind, doc],
  );
  // Only a roadmap has an Items tab: a PRD's /items opens the version.
  useEffect(() => {
    if (pane === "items" && document_ && document_.kind !== "roadmap") router.replace(`/documents/${doc}/v/${n}`);
    // E1: only a PRD has a Roadmap tab; a roadmap's /roadmap opens its Items tab.
    // Only a PRD version has an Evidence tab.
    if (pane === "evidence" && document_ && document_.kind !== "prd") router.replace(`/documents/${doc}/v/${n}`);
    if (pane === "roadmap" && document_ && document_.kind !== "prd") {
      router.replace(document_.kind === "roadmap" ? `/documents/${doc}/v/${n}/items` : `/documents/${doc}/v/${n}`);
    }
  }, [pane, document_, doc, n, router]);
  const versions = useMemo(() => document_?.versions ?? [], [document_]);
  const readOnly = !!version?.approved_at;
  const latest = versions.at(-1)?.number;
  // #255: a PRD still on its template's skeleton is drafted first, then published.
  const templateOnly = isTemplateOnly(document_?.kind, versions);
  const refine = useMemo(() => ({ doc, n }), [doc, n]);
  const sectionStates = useMemo(
    () => new Map((statesQ.data?.sections ?? []).map((st) => [st.section_key, st])),
    [statesQ.data],
  );

  // qa-docs-50: the version's opening section, the document's own title as its heading
  // (the "# Title" line), reads as the Introduction it is, not as a second title.
  const docTitle = document_?.title;
  const sections = useMemo(
    () =>
      (version?.sections ?? []).map((s, i) =>
        i === 0 && s.level === 1 && docTitle && s.heading.trim() === docTitle.trim() ? { ...s, heading: "Introduction" } : s,
      ),
    [version, docTitle],
  );
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
  // e2e-review-live: other reviewers' work shows without a reload. On window focus, and every
  // LIVE_POLL_MS while a run review waits on this version, the review state is read again in
  // place (sections and verdicts, feedback and Oracle's suggestions, the run review bar): no
  // query blanks while it does, and open forms keep their state.
  const [runReviewOpen, setRunReviewOpen] = useState(false);
  const [liveTick, setLiveTick] = useState(0);
  useLiveRefresh(
    () => {
      // Without a hash the first unreviewed section is open: keep it open when someone else reviews it.
      if (!hash && openKey) setHash(`#${openKey}`);
      void verQ.reload();
      void docQ.reload();
      void commentsQ.reload();
      void statesQ.reload();
      void feedbackQ.reload();
      void discussionsQ.reload();
      void held.refresh();
      setLiveTick((t) => t + 1);
    },
    onDocument && runReviewOpen ? LIVE_POLL_MS : null,
    rootRef,
  );
  // G7 3.3: the panel is about the open section, else the document.
  useScreenSubject(
    document_ ? (openSection ? { kind: "section", subject: { document_id: document_.id, version: n, section_key: openSection.section_key } } : { kind: "document", subject: { document_id: document_.id, version: n } }) : null,
    document_ ? (openSection ? `${document_.title} · ${openSection.heading}` : document_.title) : null,
  );
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

  // #305: the codes this version names (its headings and lines, the company's goals and
  // features), indexed once per version, not per section.
  const codeEntities = useCodeEntities();
  const codes = useMemo(() => buildCodeIndex(version?.sections ?? [], codeEntities), [version, codeEntities]);

  const citations = useMemo(() => {
    const m = new Map<string, { citation: CitationOut; number: number }>();
    // E1: Oracle's sources first, then the ones an edit added (listed apart, numbered on).
    const ordered = [...(version?.citations.filter((c) => !c.added) ?? []), ...(version?.citations.filter((c) => c.added) ?? [])];
    ordered.forEach((c, i) => m.set(c.cite_key, { citation: c, number: i + 1 }));
    return m;
  }, [version]);

  const placed = useMemo(() => {
    if (!version || !commentsQ.data) return [];
    const order = new Map(sections.map((s) => [s.section_key, s]));
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
  }, [version, sections, commentsQ.data, parsed]);

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
    // A selection made before tracking began (the right to comment still loading) counts too.
    onChange();
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
      // The Items tab: only { } (versions, keeping the tab).
      if (!onDocument && e.key !== "{" && e.key !== "}") return;
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
        if (target) router.push(paneHref(target.number));
      } else if (e.key === "Escape") {
        setSelection(null);
        setActiveId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, openComposer, versions, n, router, hasBrief, view, switchView, shownSections, openIdx, select, focusFilter, onDocument, paneHref]);

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
  const isUpdate = document_?.kind === "update";
  // F3: a roadmap's markers open a popover to record the basis a date needs.
  const dateRights = useDateRights();
  const dateMarkCtx: DateMarkCtx | null =
    isRoadmap && version
      ? {
          prd: version.source?.document_id ?? null,
          sectionText: (key) => version.sections.find((x) => x.section_key === key)?.body_md ?? "",
          rights: dateRights.data ?? null,
          onChanged: () => void verQ.reload(),
        }
      : null;
  const datedWords = (m: DateMarkOut) => `${formatDate(m.date)}${m.status === "withdrawn" ? " (its schedule was withdrawn)" : ""}`;
  const approveBlocked =
    flaggedDates.length > 0 && isUpdate
      ? // H8: an update's Approve names what is left to resolve.
        `Resolve ${flaggedDates.length} unverified date${flaggedDates.length === 1 ? "" : "s"}`
      : flaggedDates.length > 0
      ? // qa-docs-34, qa-docs-66: plain words, a readable date, and the fix (a link after it).
        `${flaggedDates.length} date${flaggedDates.length === 1 ? " is" : "s are"} not backed by a confirmed schedule: ${flaggedDates
          .map(datedWords)
          .join(", ")}. Confirm a schedule for ${flaggedDates.length === 1 ? "it" : "them"}, or take ${flaggedDates.length === 1 ? "it" : "them"} out in a new draft.`
      : undefined;
  // Review of qa-docs-3: a reviewer who cannot approve reads why, not the approver's next step.
  const approveBlockedNote =
    flaggedDates.length > 0 && isUpdate
      ? `${flaggedDates.length} date${flaggedDates.length === 1 ? " is" : "s are"} not verified yet, so this update cannot be approved.`
      : flaggedDates.length > 0
      ? `${flaggedDates.length} date${flaggedDates.length === 1 ? " is" : "s are"} not backed by a confirmed schedule: ${flaggedDates
          .map(datedWords)
          .join(", ")}. The version cannot be approved until ${flaggedDates.length === 1 ? "it is" : "they are"} resolved.`
      : undefined;
  // H4: a vision or a product strategy is an owner's to approve; approvers still set
  // section verdicts and comment.
  const ownerApproves = document_ ? OWNER_APPROVES[document_.kind] : undefined;
  // The API checks the owner by the document's kind (MIN_APPROVER_ROLE): approve_version's
  // per-item role (owner) passes any kind, an approver only the other kinds.
  const canApprove = can("approve_version", !ownerApproves);
  /** Opens the Feedback tab on a new discussion of `subject` (on a phone, in the Review sheet). */
  const discuss = useCallback((subject: DiscussionSubject) => {
    setTab("feedback");
    setDiscussion({ start: subject });
    if (window.matchMedia("(max-width: 639px)").matches) setSheet("review");
    else inspectorRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, []);
  const discussSection = useMemo(
    () =>
      canComment && document_
        ? (s: SectionOut) =>
            discuss({
              kind: "section",
              subject: { document_id: document_.id, version: n, section_key: s.section_key },
              label: `${document_.title} · ${s.heading}`,
            })
        : undefined,
    [canComment, document_, n, discuss],
  );
  // qa-docs-33: the whole draft's Discuss; during a review (not approved) its thread is also
  // the review's whole-draft feedback (the API raises the General item).
  const discussDraft = () =>
    document_ && discuss({ kind: "document", subject: { document_id: document_.id, version: n }, label: document_.title, review: !readOnly });
  const closeDiscussion = () => {
    const feedback = !!discussion && "id" in discussion && discussion.feedback;
    setDiscussion(null);
    // qa-docs-33: back from whole-draft feedback, on General, where the old comment went.
    setFilters((f) => (feedback ? { ...f, kind: "all", state: "open", scope: "general" } : { ...f, kind: "discussion" }));
    setDiscussionsKey((k) => k + 1);
    // fix3-discuss review 2: deleting the first message or making the thread private
    // withdrew or unlinked its item: the list and counts read it again.
    if (feedback) {
      void feedbackQ.reload();
      docQ.reload();
    }
  };
  const discussionPane =
    discussion &&
    ("start" in discussion ? (
      <div className="flex flex-col gap-3">
        <div>
          <Button variant="ghost" icon="chevron-left" onClick={closeDiscussion}>
            All feedback
          </Button>
        </div>
        <StartDiscussion
          key={JSON.stringify(discussion.start.subject)}
          subject={discussion.start}
          onStarted={(id, visibility) => {
            const feedback = !!discussion.start.review && visibility === "open";
            setDiscussion({ id, feedback });
            setDiscussionsKey((k) => k + 1);
            // qa-docs-33: the thread is the review's whole-draft feedback: every count shows it.
            if (feedback) {
              void feedbackQ.reload();
              docQ.reload();
            }
          }}
          onCancel={closeDiscussion}
        />
      </div>
    ) : (
      <DiscussionThread
        key={discussion.id}
        id={discussion.id}
        focusChanges={discussion.changes}
        onBack={closeDiscussion}
        onChanged={() => setDiscussionsKey((k) => k + 1)}
      />
    ));

  // H8: on an update, approvers comment and suggest; owners also set section verdicts.
  // As canApprove: the API's MIN_VERDICT_ROLE; put_review_policy stands for an owner.
  const canVerdict = canDecide && (!isUpdate || can("put_review_policy"));
  const sectionProps = (s: SectionOut) => ({
    section: s,
    blocks: parsed.get(s.section_key)!.blocks,
    citations,
    highlights: highlights.get(s.section_key) ?? NO_HIGHLIGHTS,
    activeCommentId: activeId,
    readOnly: readOnly || !canVerdict,
    // qa-docs-77: who may review, beside the state (an approved version's banner says why it is closed).
    readOnlyNote:
      readOnly || canVerdict || !capsReady
        ? undefined
        : canDecide
          ? "Owners review an update's sections."
          : "Approvers review sections.",
    // H8: an update's Asks section is the owner's to write; highlighted until it is.
    placeholder: isUpdate && s.section_key === "asks" && /^\s*Owner to fill/m.test(s.body_md),
    changedLock: changedLocks.has(s.section_key),
    evidenceTargets: canComment ? graphQ.data?.entities : undefined,
    refine: canDecide && !readOnly && n === latest ? refine : undefined,
    // Approvers edit any section by hand; a section's owner edits their own from the commenter
    // role up (the API's floor), so a viewer never can and is not offered it (#370).
    edit:
      !readOnly &&
      n === latest &&
      (canDecide || (canComment && !!me?.user_id && sectionStates.get(s.section_key)?.owner_id === me.user_id))
        ? refine
        : undefined,
    rereview: !!sectionStates.get(s.section_key)?.rereview_requested,
    ask: canComment && !readOnly && n === latest && document_ ? { documentId: document_.id } : undefined,
    onHighlightClick,
    onVerdict,
    showLayer: hasBrief,
    dateMarks: dateMarks.get(s.section_key),
    onDiscuss: !readOnly ? discussSection : undefined,
    codes,
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
    noun: hasBrief ? (view === "brief" ? "brief sections" : "sections") : undefined,
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
      // qa-docs-13, qa-docs-5: the head counts the sections shown, as the outline does; with a
      // brief it says which ("brief sections" in Brief, "all sections" in Full).
      stats={{
        reviewed: reviewedShown,
        total: shownSections.length,
        reviewedLabel: hasBrief ? (view === "brief" ? "Reviewed, brief sections" : "Reviewed, all sections") : undefined,
        locked: lockedCount,
        lockedLabel: version?.approved_at ? "Locked" : "Approved",
        openFeedback,
      }}
      openFeedback={openFeedback}
      tab={tab}
      setTab={openTab}
      goTo={goTo}
      refreshKey={refreshKey}
      shortcuts={variant === "side" ? shortcuts : undefined}
      questions={document_ && scopeKeys ? <SectionQuestions documentId={document_.id} sectionKeys={scopeKeys} /> : undefined}
      discussion={discussionPane}
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
        rolesReady: capsReady || !!capsError,
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
        discussions: { rows: discussionsQ.data ?? null, onOpen: (id) => setDiscussion({ id }) },
        // fix3-discuss review: a General item made in Discuss opens its thread; back on General.
        onOpenThread: (id) => setDiscussion({ id, feedback: true }),
        // A decision on an item: its counts, and the comment it may have resolved.
        onChanged: () => {
          void feedbackQ.reload();
          void commentsQ.reload();
        },
      }}
    />
  );

  // The version's other actions: in the toolbar on a wide screen, in the More sheet on a phone.
  // qa-docs-47: each action once: Brief / Full is the switch above. qa-docs-33: a phone's
  // header has no Discuss (but on Items), so More has it: whole-draft feedback on a phone.
  const moreActions = document_ && (
    <>
      {phone && pane !== "items" && canComment && !readOnly && (
        <Button icon="comment" onClick={discussDraft}>
          Discuss
        </Button>
      )}
      {n > 1 && (
        <LinkButton variant="ghost" href={`/documents/${doc}/diff?from=${n - 1}&to=${n}`}>
          Compare with v{n - 1}
        </LinkButton>
      )}
      {/* v2 screen 2: what this version changes for the outputs built on earlier ones. */}
      {document_.kind === "prd" && (
        <LinkButton variant="ghost" href={`/documents/${doc}/v/${n}/impact`}>
          Impact
        </LinkButton>
      )}
      {version?.source && (
        <span className="text-sm text-text2">
          <SourceLink source={version.source} />
        </span>
      )}
      {!phone && <span className="flex-1" />}
      {hasBrief && (
        <LinkButton icon="monitor" href={`/documents/${doc}/v/${n}/present`}>
          Present
        </LinkButton>
      )}
      <ExportButtons doc={doc} n={n} hasBrief={hasBrief} />
      {document_.kind === "prd" && (
        <LinkButton icon="priorities" href={`/documents/${doc}/v/${n}/quality`} data-testid="quality-link">
          Quality
        </LinkButton>
      )}
      {/* qa-docs-64: the toolbar is the same for every role; publishing (and its readiness
          check) is the header's Publish, shown to whoever may approve (can()). */}
      {document_.kind === "prd" && <BuildRoadmapButton prd={document_} size="sm" />}
    </>
  );

  // The evidence pane says itself when the version is not found.
  if (missing === "doc" || (missing === "version" && pane !== "evidence")) {
    return missing === "doc" ? (
      <DocumentNotFound />
    ) : (
      <NotFoundPanel
        title="Version not found"
        icon="doc"
        testId="doc-not-found"
        actions={
          <>
            <LinkButton href={`/documents/${doc}`} variant="secondary" className="h-10">
              Open the document
            </LinkButton>
            <LinkButton href="/documents" variant="secondary" icon="back" className="h-10">
              Back to PRDs
            </LinkButton>
          </>
        }
      >
        <p>Version {n} of this document doesn&apos;t exist.</p>
      </NotFoundPanel>
    );
  }

  return (
    <DateMarkContext.Provider value={dateMarkCtx}>
    <div ref={rootRef} onClickCapture={onLinkCapture} className={onDocument ? "max-[639px]:pb-16" : undefined}>
      <Page>
        <PageHeader
          testId="doc-header"
          phoneTitle
          phoneActionStart
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
              {/* #370: someone who can do nothing on the version reads it with View only. */}
              {capsReady && <RoleBadge />}
            </>
          }
          action={
            <>
              {/* G1: a discussion of the whole document. On a phone the header has no room;
                  each section's ⋯ menu still has Discuss this section. */}
              {document_ && canComment && !readOnly && (
                <Button
                  icon="comment"
                  // qa-docs-61/62: level with a blocked Approve (its reason sits below it); on the
                  // Items tab (no sections, so no section menus) a phone keeps Discuss too.
                  className={`${approveBlocked ? "self-start" : ""} ${pane === "items" ? "" : "max-[639px]:hidden"}`}
                  data-testid="doc-discuss"
                  onClick={discussDraft}
                >
                  Discuss
                </Button>
              )}
              {/* C1e: accepted changes staged for the next draft, built in one job. */}
              {document_?.kind === "prd" && <BuildDraftButton doc={doc} />}
              {/* H9: an approved pricing memo's Decide (the pricing owner), or who it waits for. */}
              {document_?.kind === "pricing" && n === latest && <PricingDecide slug={document_.slug} />}
              {templateOnly && document_ && <DraftWithOracleButton slug={document_.slug} />}
              {version &&
                (version.approved_at || canApprove) &&
                (document_?.kind === "prd" && !version.approved_at ? (
                  // T2 publish gate: a PRD is published from the Publish screen, latest version only.
                  <LinkButton
                    // qa-docs-66: an earlier version does not push publishing (it publishes the latest).
                    variant={templateOnly || (latest != null && n !== latest) ? "secondary" : "primary"}
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
                    blockedFix={approveBlocked && !isUpdate ? { href: "/plan/dates", label: "Open Plan › Dates" } : undefined}
                    unreviewed={{ count: sections.length - reviewedCount, total: sections.length }}
                    onApproved={() => {
                      verQ.reload();
                      docQ.reload();
                    }}
                  />
                ))}
              {/* qa-docs-3: a reviewer who cannot approve still sees why the version cannot be
                  approved (the marked dates); only the Approve button is the approver's. */}
              {version && !version.approved_at && !canApprove && capsReady && approveBlockedNote && (
                <span
                  data-testid="approve-blocked-note"
                  className="block max-w-[min(28rem,calc(100vw-2.5rem))] text-right text-sm font-medium break-words text-warn max-[600px]:text-left"
                >
                  {approveBlockedNote}
                </span>
              )}
            </>
          }
        />
        <VersionTabs
          doc={doc}
          n={n}
          kind={document_?.kind}
          active={pane}
          count={itemCountQ.data ?? undefined}
          draft={draftRoadmapOf(version)}
        />

        {/* No actions until the document is there: a missing one shows only its not-found state. */}
        {document_ && (
        <div className="mb-3 flex flex-wrap items-center gap-2 max-[600px]:gap-y-2.5" data-testid="version-toolbar">
          {versions.length > 0 && <VersionSwitcher doc={doc} versions={versions} current={n} variant="segments" hrefFor={paneHref} />}
          {onDocument && hasBrief && (
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
          {!phone && moreActions}
          {(held.rows.length > 0 || heldOpen) && (
            <HeldRewritesButton open={held.open} active={heldOpen} onClick={() => setHeldOpen((o) => !o)} />
          )}
          {/* qa-docs-12: a phone keeps the version and the view in one row; the rest is behind More. */}
          {phone && (
            <Button icon="more" className="ml-auto" aria-haspopup="dialog" data-testid="version-more" onClick={() => setSheet("more")}>
              More
            </Button>
          )}
        </div>
        )}
        {document_ && (
          <Sheet open={phone && sheet === "more"} title={`More on v${n}`} onClose={() => setSheet(null)} testId="sheet-more">
            <div className="flex flex-col items-start gap-2.5 px-4 py-3">{moreActions}</div>
          </Sheet>
        )}
        {/* #481: a spec version that may be stale is reviewed or reconciled here. */}
        {document_?.kind === "spec" && version && !version.approved_at && (
          <SpecStaleness doc={doc} n={n} mayApprove={canApprove} onChanged={() => void verQ.reload()} />
        )}
        {/* v2 screen 4: the spec's user flow and wireframes, and their review. */}
        {document_?.kind === "spec" && <SpecDesignLinks doc={doc} />}

        {onDocument && hasBrief && (
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
                  Expand a feature or milestone to see its detail. Full above shows every section.
                </InfoTip>
              </>
            ) : (
              <>
                <span className="tnum whitespace-nowrap">
                  <b className="font-semibold text-text">Full document</b>: all {sections.length} sections
                </span>
                <InfoTip label="the full document" side="bottom">
                  The {briefSections.length} sections marked Brief make up the brief.
                </InfoTip>
              </>
            )}
          </p>
        )}
        {/* qa-docs-72: Brief / Full and Present need a brief layer, which a version written
            without one (an older import) has not: say so, rather than the tools just missing. */}
        {onDocument && !hasBrief && document_?.kind === "prd" && version && sections.length > 0 && (
          <p data-testid="view-note" className="mb-3 flex flex-wrap items-center gap-1.5 text-sm text-text2">
            <span className="tnum whitespace-nowrap">
              <b className="font-semibold text-text">Full document</b>: all {sections.length} sections
            </span>
            <InfoTip label="no brief" side="bottom">
              This version was written without a brief, so it has no Brief view and no Present.
            </InfoTip>
          </p>
        )}

        {version && (latest != null && n !== latest || warnings.length > 0 || readOnly) && (
          <div className="mb-4 flex flex-col gap-2">
            {latest != null && n !== latest && (
              <p role="status" className="flex flex-wrap items-center gap-x-2 rounded-button bg-accent-soft px-3 py-2 text-sm font-medium text-accent-ink">
                You are viewing an earlier version.
                {/* qa-docs-78: an Approve offered here says what it approves. */}
                {canApprove && !version.approved_at && document_?.kind !== "prd" && (
                  <span data-testid="earlier-approve-note">
                    Approving here approves v{n}, not v{latest}.
                  </span>
                )}
                <Link href={paneHref(latest)} className="font-semibold underline underline-offset-2">
                  Go to v{latest} (latest)
                </Link>
              </p>
            )}
            {warnings.map((w, i) => (
              <div key={i} role="status" data-warning={w.code} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-button bg-warn-bg px-3 py-2 text-sm text-warn">
                <Icon name="alert" size={16} />
                <p className="min-w-0 flex-1 font-medium">{w.message}</p>
                {/* #396: a date warning says to record a date basis on Plan › Dates (F3). */}
                {w.code === "unverified_date" && (
                  <Link href="/plan/dates" className="font-medium underline underline-offset-2">
                    Open Plan › Dates
                  </Link>
                )}
                {w.section_keys.map((k) => (
                  <a
                    key={k}
                    href={sectionHref(doc, n, k)}
                    data-own-nav
                    onClick={(e) => {
                      // On the Items tab the link opens the section on the Document tab.
                      if (!plainClick(e) || !onDocument) return;
                      e.preventDefault();
                      if (!shownSections.some((s) => s.section_key === k)) setViewOverride("full");
                      select(k);
                    }}
                    className="font-medium underline underline-offset-2"
                  >
                    {headings.get(k) ?? k}
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

        {/* S4: what synced into the author's sources since this draft, with Refresh. */}
        {onDocument && version && document_?.kind === "prd" && latest != null && n === latest && (
          <DraftNewItems doc={doc} slug={document_.slug} n={n} />
        )}

        {heldOpen && (
          <HeldRewritesPanel
            doc={doc}
            rows={held.rows}
            headings={headings}
            canDecide={canDecide}
            onChanged={held.reload}
            onClose={() => setHeldOpen(false)}
          />
        )}

        {/* D10: the run's review of this draft, decided here, above the sections. */}
        {onDocument && version && (
          <RunReviewBar
            doc={doc}
            n={n}
            refreshKey={`${refreshKey}|${sections.filter((x) => x.verdict).length}|${version.approved_at ?? ""}|${liveTick}`}
            onDecided={() => void Promise.all([verQ.reload(), docQ.reload()])}
            onOpen={setRunReviewOpen}
          />
        )}
        {pane === "items" && isRoadmap && (
          <RoadmapItemsPane doc={doc} n={n} sections={sections} canDecide={canDecide} dateMarks={version?.date_marks} />
        )}
        {pane === "roadmap" && document_?.kind === "prd" && (
          <DraftRoadmapPane
            doc={doc}
            n={n}
            latest={latest ?? n}
            sections={sections}
            canDerive={canDecide}
            isOwner={can("put_draft_roadmap_settings")}
            onStatus={verQ.reload}
          />
        )}
        {/* v2 screen 3: the evidence inspector; it says itself when the version is not found. */}
        {pane === "evidence" && document_?.kind === "prd" && (
          <EvidencePane doc={doc} n={n} title={document_.title} latest={latest ?? n} />
        )}
        {pane !== "document" && !document_ && !error && <Loading label="Loading version…" />}
        {pane !== "document" && error && !(pane === "evidence" && document_) && <ErrorNote>{error}</ErrorNote>}

        {/* The outline rail (>= 1280 px), the section with the switcher above it below that,
            and the review panel; each column sticks and scrolls inside itself. */}
        {onDocument && (
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
        )}
      </Page>

      {/* Phone: Sections and Review, each opening a sheet. */}
      {onDocument && version && (
        <div
          ref={setPhoneBar}
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
          header={<ReviewProgress reviewed={reviewedShown} total={shownSections.length} noun={outlineProps.noun} />}
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
    </DateMarkContext.Provider>
  );
}

/** The phone's Sections / Review bars of the mounted version views (qa-docs-8, qa-docs-9). */
const PHONE_BARS = new Set<HTMLElement>();
/** The page's own bottom scroll padding, from before a bar set it. */
let basePadding: string | null = null;
/** The page's bottom scroll padding: the room from the shown bar's top to the screen's bottom. */
function fitPhoneBars() {
  const root = document.documentElement;
  const rooms = [...PHONE_BARS]
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.height > 0)
    .map((r) => Math.ceil(window.innerHeight - r.top));
  if (rooms.length > 0) {
    basePadding ??= root.style.scrollPaddingBottom;
    root.style.scrollPaddingBottom = `${Math.max(...rooms)}px`;
  } else if (basePadding !== null) {
    root.style.scrollPaddingBottom = basePadding;
    basePadding = null;
  }
}

const NO_HIGHLIGHTS: Highlight[] = [];
const NO_COUNTS: ReadonlyMap<string, number> = new Map();
