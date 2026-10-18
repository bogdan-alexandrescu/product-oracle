"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BuildRoadmapButton, SourceLink } from "@/components/BuildRoadmap";
import { CommentPopover, SelectionButton, type PageRect } from "@/components/CommentPopover";
import { CommentsPanel, type PlacedComment } from "@/components/CommentsPanel";
import { DocToolbar } from "@/components/DocToolbar";
import { RoleNote } from "@/components/RoleNote";
import { FeedbackPanel, ResolutionPanel } from "@/components/FeedbackPanel";
import { JobsPanel } from "@/components/JobsPanel";
import { ReportsPanel } from "@/components/ReportsPanel";
import type { ExpandCtx, Highlight } from "@/components/MarkdownBody";
import { SectionView } from "@/components/SectionView";
import { ApproveButton, ExportButtons } from "@/components/VersionActions";
import { VersionSwitcher } from "@/components/VersionSwitcher";
import { Button, ErrorNote, Kbd, Loading } from "@/components/ui";
import { resolveSelector, selectorFromRange, type TextQuoteSelector } from "@/lib/anchor";
import { api, unwrap, type CitationOut, type SectionOut, type Verdict } from "@/lib/api/client";
import { formatDate, formatDateTime, SOURCE_LABEL } from "@/lib/format";
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
  const [hashLink, setHashLink] = useState<{ n: number; key: string } | null>(() =>
    typeof window !== "undefined" && window.location.hash.startsWith("#s-")
      ? { n, key: window.location.hash.slice(3) }
      : null,
  );
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

  // Honour #s-<key> links once the section has rendered, once per version and link.
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    const hash = window.location.hash;
    if (!version || !hash.startsWith("#s-") || scrolledTo.current === `${n}${hash}`) return;
    const el = rootRef.current?.querySelector(`#${CSS.escape(hash.slice(1))}`);
    if (!el) return;
    scrolledTo.current = `${n}${hash}`;
    el.scrollIntoView({ block: "start" });
  }, [version, n, view]);

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

  return (
    <div ref={rootRef}>
      <DocToolbar doc={document_}>
        {versions.length > 0 && <VersionSwitcher doc={doc} versions={versions} current={n} />}
        {n > 1 && (
          <Link
            href={`/documents/${doc}/diff?from=${n - 1}&to=${n}`}
            className="text-sm text-neutral-700 underline-offset-2 hover:text-neutral-950 hover:underline"
          >
            Compare with v{n - 1}
          </Link>
        )}
        {hasBrief && (
          <>
            <div role="group" aria-label="Document view" className="flex items-center">
              <Button
                size="sm"
                className="rounded-r-none"
                aria-pressed={view === "brief"}
                variant={view === "brief" ? "primary" : undefined}
                onClick={() => switchView("brief")}
              >
                Brief
              </Button>
              <Button
                size="sm"
                className="-ml-px rounded-l-none"
                aria-pressed={view === "full"}
                variant={view === "full" ? "primary" : undefined}
                onClick={() => switchView("full")}
              >
                Full document
              </Button>
            </div>
            <Link
              href={`/documents/${doc}/v/${n}/present`}
              className="rounded-md border border-neutral-300 px-2.5 py-1 text-sm font-medium text-neutral-800 hover:bg-neutral-50"
            >
              Present
            </Link>
          </>
        )}
        <ExportButtons doc={doc} n={n} hasBrief={hasBrief} />
        {document_?.kind === "prd" && <BuildRoadmapButton prd={document_} size="sm" />}
        {version && (version.approved_at || canDecide) && (
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
        )}
      </DocToolbar>

      <div className="mx-auto grid max-w-[1400px] gap-x-10 px-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <article className="mx-auto w-full max-w-3xl min-w-0 py-6" aria-label="Document">
          {error && <ErrorNote>{error}</ErrorNote>}
          {!error && !version && <Loading label="Loading version…" />}
          {version && (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
                <span className="font-medium text-neutral-800">Version {version.number}</span>
                <span>Imported {formatDateTime(version.created_at)}</span>
                {version.source && <SourceLink source={version.source} />}
                {version.snapshot && <span>Sources as of {version.snapshot}</span>}
                <span>
                  {reviewedCount}/{version.sections.length} sections reviewed · {lockedCount} locked
                </span>
              </div>
              {latest != null && n !== latest && (
                <p className="mb-3 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-700">
                  You are viewing an earlier version.{" "}
                  <Link href={`/documents/${doc}/v/${latest}`} className="font-medium underline underline-offset-2">
                    Go to v{latest} (latest)
                  </Link>
                </p>
              )}
              {version.warnings.map((w, i) => (
                <div
                  key={i}
                  role="status"
                  className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
                >
                  <p>{w.message}</p>
                  {w.section_keys.length > 0 && (
                    <p className="mt-1 flex flex-wrap gap-2 text-xs">
                      {w.section_keys.map((k) => (
                        <a key={k} href={`#s-${k}`} className="font-mono underline underline-offset-2">
                          #{k}
                        </a>
                      ))}
                    </p>
                  )}
                </div>
              ))}
              {readOnly ? (
                <p className="mb-3 text-sm text-neutral-600">
                  This version was approved on {formatDate(version.approved_at!)}; review is closed.
                </p>
              ) : (
                <RoleNote role={role} />
              )}
              {hasBrief && (
                <p
                  data-testid="view-note"
                  className="mb-2 flex flex-wrap items-center gap-x-2 rounded-md border border-sky-100 bg-sky-50/60 px-3 py-2 text-sm text-neutral-700"
                >
                  {view === "brief" ? (
                    <>
                      <span>
                        <span className="font-medium text-neutral-900">Brief</span>: {briefSections.length} of{" "}
                        {sections.length} sections. Expand a feature or milestone to see its detail.
                      </span>
                      <button type="button" className="font-medium underline underline-offset-2" onClick={() => switchView("full")}>
                        Show full document
                      </button>
                    </>
                  ) : (
                    <>
                      <span>
                        <span className="font-medium text-neutral-900">Full document</span>: all {sections.length} sections; the{" "}
                        {briefSections.length} marked Brief make up the brief.
                      </span>
                      <button type="button" className="font-medium underline underline-offset-2" onClick={() => switchView("brief")}>
                        Show brief
                      </button>
                    </>
                  )}
                </p>
              )}
              <div className="divide-y divide-neutral-100" data-testid="document-sections" data-view={view}>
                {(view === "brief" ? briefSections : sections).map((s) => (
                  <SectionView
                    key={s.id}
                    {...sectionProps(s)}
                    expand={view === "brief" ? expandFor(s.section_key) : undefined}
                  />
                ))}
              </div>
              {version.citations.length > 0 && (
                <section className="mt-6 border-t border-neutral-200 pt-4" aria-labelledby="sources-heading">
                  <h2 id="sources-heading" className="mb-2 text-sm font-semibold text-neutral-700">
                    Sources
                  </h2>
                  <ol className="flex flex-col gap-1.5 text-sm text-neutral-700">
                    {version.citations.map((c, i) => (
                      <li key={c.id} className="flex gap-2">
                        <span className="w-5 shrink-0 text-right text-neutral-400">{i + 1}.</span>
                        <span>
                          <span className="text-neutral-500">{SOURCE_LABEL[c.source]} · </span>
                          <a href={c.ref} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                            {c.title ?? c.ref}
                          </a>
                        </span>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
            </>
          )}
        </article>

        <aside
          aria-label="Review panel"
          className="border-t border-neutral-200 py-6 lg:sticky lg:top-14 lg:max-h-[calc(100vh-3.5rem)] lg:overflow-y-auto lg:border-t-0 lg:border-l lg:pl-6"
        >
          <div role="tablist" aria-label="Review panel" className="mb-4 flex flex-wrap gap-x-0.5 border-b border-neutral-200">
            {(
              [
                ["comments", `Comments${commentsQ.data ? ` (${openComments})` : ""}`],
                ["feedback", "Feedback"],
                ["resolutions", "Resolutions"],
                ["reports", "Reports"],
                ["jobs", "Jobs"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                role="tab"
                type="button"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={`-mb-px border-b-2 px-1.5 pt-1 pb-2 text-sm whitespace-nowrap ${
                  tab === id
                    ? "border-neutral-900 font-medium text-neutral-900"
                    : "border-transparent text-neutral-500 hover:text-neutral-800"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div role="tabpanel">
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
            {tab === "feedback" && (
              <FeedbackPanel doc={doc} current={n} versions={versions} refreshKey={refreshKey} />
            )}
            {tab === "resolutions" && <ResolutionPanel doc={doc} n={n} refreshKey={refreshKey} />}
            {tab === "reports" && <ReportsPanel doc={doc} n={n} refreshKey={refreshKey} />}
            {tab === "jobs" && <JobsPanel doc={doc} version={n} refreshKey={refreshKey} />}
          </div>
          <p className="mt-6 flex flex-wrap gap-x-3 gap-y-1 text-xs text-neutral-400">
            <span>
              <Kbd>j</Kbd>/<Kbd>k</Kbd> sections
            </span>
            {canComment && (
              <span>
                <Kbd>c</Kbd> comment on selection
              </span>
            )}
            <span>
              <Kbd>[</Kbd>/<Kbd>]</Kbd> versions
            </span>
            {hasBrief && (
              <span>
                <Kbd>v</Kbd> brief / full
              </span>
            )}
          </p>
        </aside>
      </div>

      {selection && !composing && <SelectionButton rect={selection.rect} onOpen={openComposer} />}
      {composing && (
        <CommentPopover rect={composing.rect} anchor={composing.anchor} onCancel={closeComposer} onSubmit={submitComment} />
      )}
    </div>
  );
}

const NO_HIGHLIGHTS: Highlight[] = [];
