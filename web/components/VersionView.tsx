"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BuildRoadmapButton, SourceLink } from "@/components/BuildRoadmap";
import { CommentPopover, SelectionButton, type PageRect } from "@/components/CommentPopover";
import { CommentsPanel, type PlacedComment } from "@/components/CommentsPanel";
import { DocStatusChip } from "@/app/documents/_components/DocStatusChip";
import { DocCrumb } from "@/components/DocToolbar";
import {
  Button,
  Chip,
  Icon,
  InfoTip,
  Inspector,
  InspectorRow,
  InspectorSection,
  LinkButton,
  Page,
  PageHeader,
  SegmentedControl,
  Split,
} from "@/components/ds";
import { Kbd, TabBar } from "@/components/review/parts";
import { RoleNote } from "@/components/RoleNote";
import { FeedbackPanel, ResolutionPanel } from "@/components/FeedbackPanel";
import { JobsPanel } from "@/components/JobsPanel";
import { ReportsPanel } from "@/components/ReportsPanel";
import type { ExpandCtx, Highlight } from "@/components/MarkdownBody";
import { SectionView } from "@/components/SectionView";
import { ApproveButton, ExportButtons } from "@/components/VersionActions";
import { VersionSwitcher } from "@/components/VersionSwitcher";
import { ErrorNote, Loading } from "@/components/ui";
import { resolveSelector, selectorFromRange, type TextQuoteSelector } from "@/lib/anchor";
import { api, unwrap, type CitationOut, type SectionOut, type Verdict } from "@/lib/api/client";
import { formatDate, formatDateTime, SOURCE_LABEL, VERDICT_LABEL } from "@/lib/format";
import { blocksText, parseBlocks } from "@/lib/markdown";
import { hasRole, useMe } from "@/lib/me";
import { useDocumentView, type DocumentView } from "@/lib/preferences";
import { useQuery } from "@/lib/use-query";

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
type Tab = "comments" | "feedback" | "resolutions" | "reports" | "jobs";

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
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

  const [selection, setSelection] = useState<Selection | null>(null);
  const [composing, setComposing] = useState<Selection | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("comments");
  const [refreshKey, setRefreshKey] = useState(0);
  // O1f: the brief or the whole version; the choice is remembered per user. A comment
  // on a section the brief does not show switches this page to the full document only.
  const [savedView, saveView] = useDocumentView();
  const [viewOverride, setViewOverride] = useState<DocumentView | null>(null);
  // A #s-<key> link to a detail section (a roadmap's link to a PRD feature) opens this
  // version on the full document, until the reader picks a view.
  const [hashLink, setHashLink] = useState<{ n: number; key: string } | null>(null);
  // The link this arrival has scrolled to: once per arrival, not on every view change.
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    const hash = window.location.hash;
    scrolledTo.current = null;
    // Next writes an in-app navigation's URL, #hash included, only once the new page has
    // committed, so the hash cannot be read while rendering: read it here. This also runs
    // when Next shows a kept route again.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHashLink(hash.startsWith("#s-") ? { n, key: hash.slice(3) } : null);
  }, [doc, n]);
  // Open detail section -> the brief section showing it.
  const [opened, setOpened] = useState<Map<string, string>>(() => new Map());
  const [scrollTarget, setScrollTarget] = useState<{ id: string; key: string } | null>(null);
  const focusIdx = useRef(-1);
  // Queries are scoped to this view: Next keeps recently visited routes mounted (hidden).
  const rootRef = useRef<HTMLDivElement>(null);

  const version = verQ.data;
  const document_ = docQ.data;
  const versions = useMemo(() => document_?.versions ?? [], [document_]);
  const readOnly = !!version?.approved_at;
  const latest = versions.at(-1)?.number;
  const refine = useMemo(() => ({ doc, n }), [doc, n]);

  const sections = useMemo(() => version?.sections ?? [], [version]);
  const briefSections = useMemo(() => sections.filter((s) => s.layer === "brief"), [sections]);
  const hasBrief = briefSections.length > 0;
  const linkedDetail =
    hashLink?.n === n &&
    !briefSections.some((s) => s.section_key === hashLink.key) &&
    sections.some((s) => s.section_key === hashLink.key);
  const view: DocumentView = hasBrief ? (viewOverride ?? (linkedDetail ? "full" : savedView)) : "full";
  // Detail sections a brief section links to: each feature row and milestone expands.
  const expandable = useMemo(() => {
    const detail = new Set(sections.filter((s) => s.layer !== "brief").map((s) => s.section_key));
    const keys = new Set<string>();
    for (const s of briefSections) for (const m of s.body_md.matchAll(SECTION_LINK)) if (detail.has(m[1])) keys.add(m[1]);
    return keys;
  }, [sections, briefSections]);

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

  // Scroll to a comment once the section it is on has rendered (after Expand or a switch).
  useEffect(() => {
    if (!scrollTarget) return;
    const root = rootRef.current;
    const mark = root?.querySelector(`[data-comment-ids~="${scrollTarget.id}"]`);
    const el = mark ?? root?.querySelector(`#s-${CSS.escape(scrollTarget.key)}`);
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      setScrollTarget(null);
    }
  }, [scrollTarget, view, opened, version]);


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
    version?.citations.forEach((c, i) => m.set(c.cite_key, { citation: c, number: i + 1 }));
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

  const scrollToComment = useCallback(
    (c: PlacedComment) => {
      setActiveId(c.id);
      const root = rootRef.current;
      const mark = root?.querySelector(`[data-comment-ids~="${c.id}"]`);
      const el = mark ?? root?.querySelector(`#s-${CSS.escape(c.section_key)}`);
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        return;
      }
      // Not shown in the brief: expand the feature or milestone that holds it, else
      // show the full document.
      const all = version?.sections ?? [];
      const holder = [...expandable].find((k) => subtree(all, k).some((s) => s.section_key === c.section_key));
      const origin = holder && briefSections.find((s) => s.body_md.includes(`](#${holder})`));
      if (holder && origin) setOpened((prev) => new Map(prev).set(holder, origin.section_key));
      else setViewOverride("full");
      setScrollTarget({ id: c.id, key: c.section_key });
    },
    [version, expandable, briefSections],
  );

  const onHighlightClick = useCallback((id: string) => {
    setActiveId(id);
    setTab("comments");
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
    setTab("comments");
    bump();
    docQ.reload();
  }

  async function reply(id: string, body: string) {
    await unwrap(api.POST("/v1/comments/{comment_id}/replies", { params: { path: { comment_id: id } }, body: { body } }));
    await commentsQ.reload();
  }

  async function resolve(id: string, resolved: boolean) {
    await unwrap(api.PATCH("/v1/comments/{comment_id}", { params: { path: { comment_id: id } }, body: { resolved } }));
    await commentsQ.reload();
  }

  // Keyboard: j/k move between sections, c comments on the selection, [ ] switch versions.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const sections = [...(rootRef.current?.querySelectorAll<HTMLElement>("section[data-section-key]") ?? [])];
      if (e.key === "j" || e.key === "k") {
        const current = sections.findIndex((s) => s.contains(document.activeElement));
        const from = current >= 0 ? current : focusIdx.current;
        const next = Math.max(0, Math.min(sections.length - 1, from + (e.key === "j" ? 1 : -1)));
        focusIdx.current = next;
        sections[next]?.focus({ preventScroll: true });
        sections[next]?.scrollIntoView({ block: "start", behavior: "smooth" });
      } else if (e.key === "v" && hasBrief) {
        switchView(view === "brief" ? "full" : "brief");
      } else if (e.key === "c" && selection) {
        e.preventDefault();
        openComposer();
      } else if ((e.key === "[" || e.key === "]") && versions.length) {
        const i = versions.findIndex((v) => v.number === n);
        const target = versions[i + (e.key === "]" ? 1 : -1)];
        if (target) router.push(`/documents/${doc}/v/${target.number}`);
      } else if (e.key === "Escape") {
        setSelection(null);
        setActiveId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, openComposer, versions, n, doc, router, hasBrief, view, switchView]);

  // Honour #s-<key> links once the section has rendered.
  useEffect(() => {
    const hash = window.location.hash;
    if (!version || !hash.startsWith("#s-") || scrolledTo.current === `${n}${hash}`) return;
    const el = rootRef.current?.querySelector(`#${CSS.escape(hash.slice(1))}`);
    if (!el) return;
    scrolledTo.current = `${n}${hash}`;
    el.scrollIntoView({ block: "start" });
  }, [version, n, view, hashLink]);

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
  });
  const expandFor = (origin: string): ExpandCtx => ({
    keys: expandable,
    open: opened,
    origin,
    toggle: toggleOpen,
    render: (key) =>
      subtree(sections, key).map((d) => <SectionView key={d.id} {...sectionProps(d)} nested />),
  });

  const changedLocks = new Set(
    version?.warnings.filter((w) => w.code === "locked_section_changed").flatMap((w) => w.section_keys) ?? [],
  );
  const lockedCount = version?.sections.filter((s) => s.verdict?.verdict === "approved").length ?? 0;
  const reviewedCount = version?.sections.filter((s) => s.verdict).length ?? 0;
  const openComments = placed.filter((c) => !c.resolved_at).length;
  const error = docQ.error || verQ.error;

  const shownSections = view === "brief" ? briefSections : sections;
  const stripSections = shownSections.filter((s) => s.level <= 2);
  const warnings = version?.warnings ?? [];

  const tabs: { id: Tab; label: string; count?: number | null }[] = [
    { id: "comments", label: "Comments", count: commentsQ.data ? openComments : null },
    { id: "feedback", label: "Feedback" },
    { id: "resolutions", label: "Resolutions" },
    { id: "reports", label: "Reports" },
    { id: "jobs", label: "Jobs" },
  ];

  const inspector = (
    <Inspector
      label="Review panel"
      eyebrow={`Review · v${n}`}
      action={
        <InfoTip label="keyboard shortcuts" hero side="bottom">
          <span className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5">
              <Kbd>j</Kbd>
              <Kbd>k</Kbd> sections
            </span>
            {canComment && (
              <span className="flex items-center gap-1.5">
                <Kbd>c</Kbd> comment on selection
              </span>
            )}
            <span className="flex items-center gap-1.5">
              <Kbd>[</Kbd>
              <Kbd>]</Kbd> versions
            </span>
            {hasBrief && (
              <span className="flex items-center gap-1.5">
                <Kbd>v</Kbd> brief / full
              </span>
            )}
          </span>
        </InfoTip>
      }
      head={
        version && (
          <dl className="mt-2.5 flex flex-wrap gap-x-7 gap-y-2">
            {(
              [
                ["Reviewed", `${reviewedCount}/${version.sections.length}`, "stat-reviewed"],
                ["Locked", lockedCount, "stat-locked"],
                ["Open comments", commentsQ.data ? openComments : "–", "stat-open-comments"],
              ] as const
            ).map(([label, value, testId]) => (
              <div key={label} data-testid={testId} className="flex flex-col-reverse">
                <dt className="text-[13px] leading-4 font-semibold tracking-[0.02em] text-hero-text2">{label}</dt>
                <dd className="tnum font-display text-[34px] leading-10 font-bold tracking-[-0.03em]">{value}</dd>
              </div>
            ))}
          </dl>
        )
      }
    >
      {version && (
        <InspectorSection label="Version">
          <InspectorRow value={<span className="text-sm font-medium">{formatDateTime(version.created_at)}</span>}>
            Imported
          </InspectorRow>
          {version.snapshot && (
            <InspectorRow value={<span className="font-mono text-[13px] font-medium">{version.snapshot}</span>}>
              Sources as of
            </InspectorRow>
          )}
          {version.source && (
            <div className="flex min-h-8 items-center text-sm text-text2">
              <SourceLink source={version.source} />
            </div>
          )}
        </InspectorSection>
      )}
      <div className="px-5 pt-1 max-[600px]:px-4">
        <TabBar label="Review panel" size="sm" tabs={tabs} value={tab} onChange={setTab} />
      </div>
      <div role="tabpanel" className="px-5 py-3.5 max-[600px]:px-4 xl:max-h-[calc(100vh-330px)] xl:overflow-y-auto">
        {tab === "comments" &&
          (commentsQ.error ? (
            <ErrorNote>{commentsQ.error}</ErrorNote>
          ) : !commentsQ.data ? (
            <Loading />
          ) : (
            <CommentsPanel
              showLayer={hasBrief}
              comments={placed}
              activeId={activeId}
              readOnly={readOnly}
              canComment={canComment}
              canResolveAny={canDecide}
              userId={me?.user_id ?? me?.token_id ?? null}
              onSelect={scrollToComment}
              onReply={reply}
              onResolve={resolve}
            />
          ))}
        {tab === "feedback" && <FeedbackPanel doc={doc} current={n} versions={versions} refreshKey={refreshKey} />}
        {tab === "resolutions" && <ResolutionPanel doc={doc} n={n} refreshKey={refreshKey} />}
        {tab === "reports" && <ReportsPanel doc={doc} n={n} refreshKey={refreshKey} />}
        {tab === "jobs" && <JobsPanel doc={doc} version={n} refreshKey={refreshKey} />}
      </div>
    </Inspector>
  );

  return (
    <div ref={rootRef}>
      <Page>
        <PageHeader
          testId="doc-header"
          back={<DocCrumb doc={document_} withTitle={false} />}
          title={document_?.title ?? "…"}
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
            version &&
            (version.approved_at || canDecide) && (
              <ApproveButton
                doc={doc}
                n={n}
                approvedAt={version.approved_at}
                isLatest={n === latest}
                onApproved={() => {
                  verQ.reload();
                  docQ.reload();
                }}
              />
            )
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
          <span className="flex-1" />
          {hasBrief && (
            <LinkButton icon="monitor" href={`/documents/${doc}/v/${n}/present`}>
              Present
            </LinkButton>
          )}
          <ExportButtons doc={doc} n={n} hasBrief={hasBrief} />
          {document_?.kind === "prd" && <BuildRoadmapButton prd={document_} size="sm" />}
        </div>

        {version && (
          <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-panel border border-line bg-surface py-2 pr-3 pl-4 shadow-panel">
            <span className="flex-none text-[13px] font-semibold tracking-[0.02em] whitespace-nowrap text-text2">
              Sections{" "}
              <b className="tnum font-bold text-text">
                {reviewedCount}/{version.sections.length}
              </b>
            </span>
            <nav aria-label="Sections" className="flex min-w-0 flex-1 gap-1 overflow-x-auto max-[600px]:order-last max-[600px]:basis-full">
              {stripSections.map((s) => {
                const v = s.verdict?.verdict;
                return (
                  <a
                    key={s.id}
                    href={`#s-${s.section_key}`}
                    className={`flex h-8 flex-none items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium whitespace-nowrap hover:bg-surface2 ${
                      v ? "text-text" : "text-text2"
                    }`}
                  >
                    {v === "approved" && (
                      <span className="text-pass">
                        <Icon name="check" size={16} />
                      </span>
                    )}
                    {v === "changes_requested" && <span aria-hidden className="size-2 rounded-full bg-warn" />}
                    {v === "rejected" && <span aria-hidden className="size-2 rounded-full bg-crit" />}
                    {v && <span className="sr-only">{VERDICT_LABEL[v]}:</span>}
                    {s.heading}
                  </a>
                );
              })}
            </nav>
            {hasBrief && (
              <p data-testid="view-note" className="flex flex-none items-center gap-1.5 text-sm text-text2">
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
          </div>
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
                  <a key={k} href={`#s-${k}`} className="font-mono text-[13px] font-medium underline underline-offset-2">
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

        <Split inspector={inspector}>
          <article aria-label="Document" className="min-w-0 rounded-panel border border-line bg-surface shadow-panel">
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
            {version && (
              <>
                <div className="divide-y divide-line" data-testid="document-sections" data-view={view}>
                  {shownSections.map((s) => (
                    <SectionView key={s.id} {...sectionProps(s)} expand={view === "brief" ? expandFor(s.section_key) : undefined} />
                  ))}
                </div>
                {version.citations.length > 0 && (
                  <section className="border-t border-line px-6 py-4 max-[600px]:px-4" aria-labelledby="sources-heading">
                    <h2 id="sources-heading" className="mb-2 font-display text-lg leading-6 font-bold">
                      Sources <span className="tnum text-accent-ink">{version.citations.length}</span>
                    </h2>
                    <ol className="flex flex-col">
                      {version.citations.map((c, i) => (
                        <li key={c.id} className="flex min-h-8 items-center gap-2.5 text-sm">
                          <span className="tnum w-5 flex-none text-right font-semibold text-text2">{i + 1}</span>
                          <span className="flex-none text-[13px] font-semibold text-text2">{SOURCE_LABEL[c.source]}</span>
                          <a
                            href={c.ref}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="min-w-0 truncate font-medium text-text underline-offset-2 hover:underline"
                          >
                            {c.title ?? c.ref}
                          </a>
                        </li>
                      ))}
                    </ol>
                  </section>
                )}
              </>
            )}
          </article>
        </Split>
      </Page>

      {selection && !composing && <SelectionButton rect={selection.rect} onOpen={openComposer} />}
      {composing && (
        <CommentPopover rect={composing.rect} anchor={composing.anchor} onCancel={closeComposer} onSubmit={submitComment} />
      )}
    </div>
  );
}

const NO_HIGHLIGHTS: Highlight[] = [];
