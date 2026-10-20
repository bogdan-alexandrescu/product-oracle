"use client";

import Link from "next/link";
import { useState, type MouseEvent, type ReactNode } from "react";

import { SuggestionActions, SuggestionCard, SuggestionForm, useSuggestionDecision } from "@/components/SuggestionCard";
import { Button, Chip, Empty } from "@/components/ds";
import { FeedbackStatusChip, InlineError, Quote, VerdictChip } from "@/components/review/parts";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type FeedbackItem, type FeedbackStatus, type Suggestion } from "@/lib/api/client";
import { hasRole, useMe } from "@/lib/me";
import { sectionHref } from "@/lib/section-link";
import { useQuery } from "@/lib/use-query";

/** Where a row's section link goes: the section in this version, else the version it was raised on. */
export type GoTo = {
  /** Section keys of the version on screen. */
  keys: ReadonlySet<string>;
  /** Opens a section of the version on screen. */
  open: (key: string) => void;
  /** Section headings of the version on screen: "Go to 2.2 Evidence from support". */
  headings?: ReadonlyMap<string, string>;
};

function plainClick(e: MouseEvent) {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

/** "Go to <section>": the one section link (sectionHref); opens it here when this version has it. */
export function SectionLink({ item, doc, current, goTo }: { item: FeedbackItem; doc: string; current: number; goTo?: GoTo }) {
  const key = item.section_key!;
  const here = !!goTo?.keys.has(key);
  const n = here ? current : item.raised_on_version;
  const heading = here ? goTo?.headings?.get(key) : undefined;
  return (
    <Link
      href={sectionHref(doc, n, key)}
      data-section-link={key}
      data-testid="feedback-goto"
      data-own-nav
      title={heading ?? `§${key}`}
      onClick={(e) => {
        if (!here || !plainClick(e)) return;
        e.preventDefault();
        goTo!.open(key);
      }}
      className="inline-flex h-7 min-w-0 items-center gap-1 text-sm font-semibold text-accent-ink hover:underline"
    >
      <span className="min-w-0 truncate">
        Go to {heading ?? <span className="font-mono text-[13px] font-medium">§{key}</span>}
      </span>
      {n !== current && <span className="flex-none">(v{n})</span>}
    </Link>
  );
}

/**
 * Resolve and Reopen for an item without an open suggestion; a comment's thread follows
 * its item, as the Comments tab shows it.
 */
export function useTriage(item: FeedbackItem, onChanged?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function set(status: "addressed" | "open") {
    setBusy(true);
    setError(null);
    try {
      await unwrap(
        api.PATCH("/v1/feedback/{feedback_id}", {
          params: { path: { feedback_id: item.id } },
          body: { status },
        }),
      );
      if (item.comment_id) {
        await unwrap(
          api.PATCH("/v1/comments/{comment_id}", {
            params: { path: { comment_id: item.comment_id } },
            body: { resolved: status === "addressed" },
          }),
        );
      }
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, set };
}

function FeedbackRow({
  item,
  doc,
  current,
  goTo,
  onChanged,
}: {
  item: FeedbackItem;
  doc: string;
  current: number;
  goTo?: GoTo;
  onChanged?: () => void;
}) {
  const { role } = useMe();
  const canDecide = hasRole(role, "approver") && !!onChanged;
  return item.suggestion ? (
    <SuggestionRow item={item} suggestion={item.suggestion} doc={doc} current={current} goTo={goTo} canDecide={canDecide} onChanged={onChanged} />
  ) : (
    <PlainRow item={item} doc={doc} current={current} goTo={goTo} canDecide={canDecide} onChanged={onChanged} />
  );
}

type RowProps = { item: FeedbackItem; doc: string; current: number; goTo?: GoTo; canDecide: boolean; onChanged?: () => void };

function SuggestionRow({ suggestion, ...props }: RowProps & { suggestion: Suggestion }) {
  // Remounts when the suggestion changes, so the editor starts from the saved text.
  return <SuggestionRowInner key={`${suggestion.id}|${suggestion.updated_at}`} suggestion={suggestion} {...props} />;
}

function SuggestionRowInner({ item, suggestion, doc, current, goTo, canDecide, onChanged }: RowProps & { suggestion: Suggestion }) {
  const d = useSuggestionDecision(suggestion, () => onChanged?.());
  // Decided (or nothing to decide): the item itself is resolved or reopened.
  const open = suggestion.status === "open" && item.status === "open";
  return (
    <Row
      item={item}
      doc={doc}
      current={current}
      goTo={goTo}
      actions={canDecide && (open ? <SuggestionActions d={d} /> : <TriageActions item={item} onChanged={onChanged} />)}
      form={canDecide && open && <SuggestionForm d={d} />}
    >
      <SuggestionCard suggestion={suggestion} canDecide={canDecide} editing={d.mode === "edit"} />
    </Row>
  );
}

function PlainRow({ item, doc, current, goTo, canDecide, onChanged }: RowProps) {
  return <Row item={item} doc={doc} current={current} goTo={goTo} actions={canDecide && <TriageActions item={item} onChanged={onChanged} />} />;
}

export function TriageActions({ item, onChanged }: { item: FeedbackItem; onChanged?: () => void }) {
  const t = useTriage(item, onChanged);
  if (item.status === "superseded") return null;
  return (
    <>
      {item.status === "open" ? (
        <Button variant="solid" icon="check" disabled={t.busy} onClick={() => t.set("addressed")}>
          Resolve
        </Button>
      ) : (
        <Button disabled={t.busy} onClick={() => t.set("open")}>
          Reopen
        </Button>
      )}
      {t.error && <InlineError>{t.error}</InlineError>}
    </>
  );
}

/** One feedback item: its section link and actions on top, then what it says. */
function Row({
  item,
  doc,
  current,
  goTo,
  actions,
  form,
  children,
}: {
  item: FeedbackItem;
  doc: string;
  current: number;
  goTo?: GoTo;
  actions?: ReactNode;
  form?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li
      className="scroll-mt-16 border-b border-line py-3 last:border-b-0"
      data-testid="feedback-item"
      data-feedback-id={item.id}
      data-status={item.status}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {item.section_key && <SectionLink item={item} doc={doc} current={current} goTo={goTo} />}
        <FeedbackStatusChip status={item.status} />
        {item.verdict ? <VerdictChip verdict={item.verdict} /> : <Chip kind="line">{item.kind === "comment" ? "Comment" : "General"}</Chip>}
        <span className="tnum ml-auto text-[13px] text-text2">
          raised on v{item.raised_on_version}
          {item.addressed_in_version != null && ` · addressed in v${item.addressed_in_version}`}
        </span>
      </div>
      {actions && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="feedback-actions">
          {actions}
        </div>
      )}
      {form}
      <p className="mt-1.5 text-[15px] leading-[22px] text-text">{item.summary}</p>
      {item.anchor && <Quote>{item.anchor.exact}</Quote>}
      {item.resolution_note && (
        <p className="mt-1 text-sm leading-5 text-text2">
          <span className="font-semibold text-text">Resolution:</span> {item.resolution_note}
        </p>
      )}
      {children}
    </li>
  );
}

/** How this version handled feedback raised on earlier versions; `sectionKeys` keeps only those sections' items. */
export function ResolutionPanel({
  doc,
  n,
  refreshKey,
  sectionKeys,
  goTo,
}: {
  doc: string;
  n: number;
  refreshKey: number;
  sectionKeys?: ReadonlySet<string> | null;
  goTo?: GoTo;
}) {
  const q = useQuery(`${doc}|${n}|${refreshKey}`, () =>
    unwrap(api.GET("/v1/documents/{doc}/versions/{n}/resolution-report", { params: { path: { doc, n } } })),
  );
  if (q.error) return <ErrorNote>{q.error}</ErrorNote>;
  if (!q.data) return <Loading />;
  const items = sectionKeys
    ? q.data.items.filter((f) => !!f.section_key && sectionKeys.has(f.section_key))
    : q.data.items;
  if (items.length === 0) {
    return <Empty>No earlier feedback</Empty>;
  }
  const counts = sectionKeys
    ? items.reduce<Record<string, number>>((m, f) => ({ ...m, [f.status]: (m[f.status] ?? 0) + 1 }), {})
    : q.data.counts;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-3">
        {Object.entries(counts).map(([s, count]) => (
          <span key={s} className="tnum inline-flex items-center gap-1.5 text-sm font-bold">
            <FeedbackStatusChip status={s as FeedbackStatus} /> {count}
          </span>
        ))}
      </div>
      <ol className="flex flex-col">
        {items.map((f) => (
          <FeedbackRow key={f.id} item={f} doc={doc} current={n} goTo={goTo} />
        ))}
      </ol>
    </div>
  );
}
