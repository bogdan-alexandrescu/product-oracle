"use client";

import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

import type { PlanItem } from "@/app/plan/_lib";
import { Button, confirmInPage, Icon, Notice } from "@/components/ds";
import { INPUT } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatDay } from "@/lib/format";
import { errorMessage, useQuery } from "@/lib/use-query";

type TrackerIssue = Schemas["TrackerIssueOut"];
type Linked = { prd: string | null; item_key: string; item_title?: string | null };

const STATE: Record<string, string> = { todo: "Open", in_progress: "In progress", done: "Closed", cancelled: "Not planned" };

/** "Spend forecast for the month (Usage alerts PRD)": the item a link points at, by the Plan's names when it has them. */
function linkedName(l: Linked, items: PlanItem[]): { item: string; prd: string } {
  const i = items.find((x) => x.prd?.slug === l.prd && x.key === l.item_key);
  return { item: i?.title ?? l.item_title ?? l.item_key, prd: i?.prd?.title ?? l.prd ?? "another PRD" };
}

/** "acme/app#412 · Saved cards checkout · Open · milestone Beta (Nov 30)" */
function issueLine(i: TrackerIssue): string {
  const ms = i.milestone ? `milestone ${i.milestone.title}${i.milestone.due ? ` (${formatDay(`${i.milestone.due}T12:00:00Z`)})` : ""}` : "";
  return [i.external_ref, i.title, STATE[i.state] ?? i.raw_status ?? i.state, ms].filter(Boolean).join(" · ");
}

/** The 409's body: the item the issue is linked to now. */
function conflictOf(error: unknown): Linked | null {
  const detail = error && typeof error === "object" && "detail" in error ? (error.detail as { linked?: Linked } | null) : null;
  return detail && typeof detail === "object" && detail.linked ? detail.linked : null;
}

/**
 * F7 Link issue: search your own synced GitHub issues and tie one to a Plan item. Linking an
 * issue tied to another item asks before moving it. Oracle never writes to GitHub.
 */
export function LinkIssueDialog({
  item,
  items,
  onClose,
  onLinked,
}: {
  item: PlanItem;
  /** The Plan's items, to name the item an issue is linked to now. */
  items: PlanItem[];
  onClose: () => void;
  onLinked: () => void;
}) {
  const id = useId();
  const [term, setTerm] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // Escape closes, unless the Move question took it (its dialog handles it first).
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const q = useQuery(
    `tracker-issues|${term.trim()}`,
    () => unwrap(api.GET("/v1/tracker/issues", { params: { query: { q: term.trim(), limit: 20 } } })),
    { keepPrevious: true },
  );
  const results = q.data ?? [];
  const issue = results.find((i) => i.source_item_id === picked) ?? null;
  const here = (l: Linked | null | undefined) => !!l && l.prd === item.prd?.slug && l.item_key === item.key;

  async function link() {
    if (!issue || !item.prd) return;
    setBusy(true);
    setError(null);
    try {
      let move = false;
      if (issue.linked && !here(issue.linked)) {
        if (!(await confirmInPage({ action: "Move", message: `Move it from ${linkedName(issue.linked, items).item}?` }))) return;
        move = true;
      }
      const post = (move: boolean) =>
        api.POST("/v1/tracker/links", { body: { prd: item.prd!.slug, item_key: item.key, source_item_id: issue.source_item_id, move } });
      let res = await post(move);
      const other = res.response.status === 409 ? conflictOf(res.error) : null;
      if (other) {
        // Linked elsewhere since the search: ask, then move.
        if (!(await confirmInPage({ action: "Move", message: `Move it from ${linkedName(other, items).item}?` }))) return;
        res = await post(true);
      }
      await unwrap(Promise.resolve(res));
      onLinked();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    // On the body, as Build roadmap's: keep clicks from selecting the table's rows underneath.
    <div
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-hero/50 px-4 py-10 max-[600px]:px-2 max-[600px]:py-4"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.key !== "Escape" && e.stopPropagation()}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        tabIndex={-1}
        data-testid="link-issue-dialog"
        className="w-full max-w-xl min-w-0 overflow-hidden rounded-inspector border border-line bg-surface text-text shadow-tip outline-none"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-3.5 max-[600px]:px-4">
          <h2 id={`${id}-title`} className="min-w-0 font-display text-lg font-bold tracking-heading break-words">
            Link a GitHub issue to {item.title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid size-8 flex-none place-items-center rounded-lg text-text2 hover:bg-surface2 hover:text-text"
          >
            <Icon name="x" size={20} />
          </button>
        </div>
        <div className="flex flex-col gap-3 px-5 py-4 text-[15px] max-[600px]:px-4">
          <input
            autoFocus
            type="search"
            className={INPUT}
            aria-label="Search your GitHub issues"
            placeholder="#412, acme/app#412, words of the title or the issue's URL"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
          />
          {q.error && <Notice tone="error">{q.error}</Notice>}
          {q.data && results.length === 0 && (
            <p data-testid="link-issue-none" className="text-text2">
              Add its repository as a GitHub source in Settings › Sources first.
            </p>
          )}
          {results.length > 0 && (
            <ul aria-label="Your GitHub issues" className="flex max-h-80 flex-col overflow-y-auto rounded-button border border-line">
              {results.map((i) => {
                const l = i.linked ? linkedName(i.linked, items) : null;
                const on = i.source_item_id === picked;
                return (
                  <li key={i.source_item_id} className="border-b border-line last:border-b-0">
                    <button
                      type="button"
                      data-testid="link-issue-result"
                      aria-pressed={on}
                      onClick={() => setPicked(i.source_item_id)}
                      className={`flex min-h-11 w-full min-w-0 flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-surface2 ${on ? "bg-accent-soft" : ""}`}
                    >
                      <span className="w-full min-w-0 break-words">{issueLine(i)}</span>
                      {l && (
                        <span data-testid="link-issue-linked" className="text-sm text-text2">
                          {here(i.linked) ? "Linked to this item" : `Linked to ${l.item} (${l.prd})`}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {error && <Notice tone="error">{error}</Notice>}
        </div>
        <div className="flex flex-col gap-2 border-t border-line px-5 py-3 max-[600px]:px-4">
          <p data-testid="link-issue-sharing" className="text-sm text-text2">
            Everyone who can see the Plan will see this issue&apos;s number, title, state and link.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={link} disabled={busy || !issue || here(issue.linked)}>
              Link
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
