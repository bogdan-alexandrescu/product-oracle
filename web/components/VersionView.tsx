"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CommentPopover, SelectionButton, type PageRect } from "@/components/CommentPopover";
import { CommentsPanel, type PlacedComment } from "@/components/CommentsPanel";
import { DocToolbar } from "@/components/DocToolbar";
import { RoleNote } from "@/components/RoleNote";
import { FeedbackPanel, ResolutionPanel } from "@/components/FeedbackPanel";
import type { Highlight } from "@/components/MarkdownBody";
import { SectionView } from "@/components/SectionView";
import { ApproveButton, ExportButtons } from "@/components/VersionActions";
import { VersionSwitcher } from "@/components/VersionSwitcher";
import { ErrorNote, Kbd, Loading } from "@/components/ui";
import { resolveSelector, selectorFromRange, type TextQuoteSelector } from "@/lib/anchor";
import { api, unwrap, type CitationOut, type Verdict } from "@/lib/api/client";
import { formatDate, formatDateTime, SOURCE_LABEL } from "@/lib/format";
import { blocksText, parseBlocks } from "@/lib/markdown";
import { hasRole, useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

type Selection = { sectionKey: string; anchor: TextQuoteSelector; rect: PageRect };
type Tab = "comments" | "feedback" | "resolutions";

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
  const focusIdx = useRef(-1);
  // Queries are scoped to this view: Next keeps recently visited routes mounted (hidden).
  const rootRef = useRef<HTMLDivElement>(null);

  const version = verQ.data;
  const document_ = docQ.data;
  const versions = useMemo(() => document_?.versions ?? [], [document_]);
  const readOnly = !!version?.approved_at;
  const latest = versions.at(-1)?.number;

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

  const scrollToComment = useCallback((c: PlacedComment) => {
    setActiveId(c.id);
    const root = rootRef.current;
    const mark = root?.querySelector(`[data-comment-ids~="${c.id}"]`);
    (mark ?? root?.querySelector(`#s-${CSS.escape(c.section_key)}`))?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, []);

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
  }, [selection, openComposer, versions, n, doc, router]);

  // Honour #s-<key> links once the version has rendered.
  useEffect(() => {
    if (!version || !window.location.hash.startsWith("#s-")) return;
    rootRef.current?.querySelector(`#${CSS.escape(window.location.hash.slice(1))}`)?.scrollIntoView({ block: "start" });
  }, [version]);

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
        <ExportButtons doc={doc} n={n} />
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
              <div className="divide-y divide-neutral-100">
                {version.sections.map((s) => (
                  <SectionView
                    key={s.id}
                    section={s}
                    blocks={parsed.get(s.section_key)!.blocks}
                    citations={citations}
                    highlights={highlights.get(s.section_key) ?? NO_HIGHLIGHTS}
                    activeCommentId={activeId}
                    readOnly={readOnly || !canDecide}
                    changedLock={changedLocks.has(s.section_key)}
                    evidenceTargets={canComment ? graphQ.data?.entities : undefined}
                    onHighlightClick={onHighlightClick}
                    onVerdict={onVerdict}
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
          <div role="tablist" aria-label="Review panel" className="mb-4 flex gap-1 border-b border-neutral-200">
            {(
              [
                ["comments", `Comments${commentsQ.data ? ` (${openComments})` : ""}`],
                ["feedback", "Feedback"],
                ["resolutions", "Resolutions"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                role="tab"
                type="button"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={`-mb-px border-b-2 px-2 pb-2 text-sm ${
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
