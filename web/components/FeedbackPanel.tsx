"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";

import { SuggestionActions, SuggestionCard, SuggestionForm, useSuggestionDecision } from "@/components/SuggestionCard";
import { Button, Chip, Empty } from "@/components/ds";
import { FeedbackStatusChip, InlineError, Quote, SELECT, VerdictChip } from "@/components/review/parts";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type FeedbackItem, type FeedbackStatus, type Suggestion, type VersionSummary } from "@/lib/api/client";
import { STATUS_LABEL } from "@/lib/format";
import { hasRole, useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

const STATUSES = Object.keys(STATUS_LABEL) as FeedbackStatus[];

/** Where a row's section link goes: the section in this version, else the version it was raised on. */
export type GoTo = {
  /** Section keys of the version on screen. */
  keys: ReadonlySet<string>;
  /** Opens a section of the version on screen. */
  open: (key: string) => void;
};

function plainClick(e: MouseEvent) {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

function SectionLink({ item, doc, current, goTo }: { item: FeedbackItem; doc: string; current: number; goTo?: GoTo }) {
  const key = item.section_key!;
  const here = !!goTo?.keys.has(key);
  const n = here ? current : item.raised_on_version;
  return (
    <Link
      href={`/documents/${doc}/v/${n}#${key}`}
      data-section-link={key}
      onClick={(e) => {
        if (!here || !plainClick(e)) return;
        e.preventDefault();
        goTo!.open(key);
      }}
      className="inline-flex h-8 min-w-0 items-center truncate font-mono text-[13px] font-medium text-accent-ink hover:underline"
    >
      Go to §{key}
      {n !== current && ` (v${n})`}
    </Link>
  );
}

/**
 * Resolve and Reopen for an item without an open suggestion; a comment's thread follows
 * its item, as the Comments tab shows it.
 */
function useTriage(item: FeedbackItem, onChanged?: () => void) {
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

function TriageActions({ item, onChanged }: { item: FeedbackItem; onChanged?: () => void }) {
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
      {(item.section_key || actions) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          {item.section_key && <SectionLink item={item} doc={doc} current={current} goTo={goTo} />}
          {actions && <span className="ml-auto flex flex-wrap justify-end gap-1.5">{actions}</span>}
        </div>
      )}
      {form}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <FeedbackStatusChip status={item.status} />
        {item.verdict ? <VerdictChip verdict={item.verdict} /> : <Chip kind="line">{item.kind === "comment" ? "Comment" : "General"}</Chip>}
        <span className="tnum ml-auto text-[13px] text-text2">
          raised on v{item.raised_on_version}
          {item.addressed_in_version != null && ` · addressed in v${item.addressed_in_version}`}
        </span>
      </div>
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

/**
 * Every comment, section verdict and Oracle suggestion on the document (`items`, loaded by
 * the page so the tab and header can count them), filterable by status and version;
 * `sectionKeys` keeps only the items raised on those sections (the open one). `focus`
 * scrolls the first item into view once, for a link that arrives at the open feedback.
 */
export function FeedbackPanel({
  doc,
  current,
  versions,
  items: all,
  error,
  reload,
  status,
  onStatus,
  sectionKeys,
  goTo,
  focus = false,
  onFocused,
}: {
  doc: string;
  current: number;
  versions: VersionSummary[];
  items: FeedbackItem[] | undefined;
  error: string | null;
  reload: () => void;
  status: FeedbackStatus | "";
  onStatus: (s: FeedbackStatus | "") => void;
  sectionKeys?: ReadonlySet<string> | null;
  goTo?: GoTo;
  focus?: boolean;
  onFocused?: () => void;
}) {
  const [version, setVersion] = useState<number | "">("");
  const listRef = useRef<HTMLOListElement>(null);
  const items = all?.filter(
    (f) =>
      (!status || f.status === status) &&
      (version === "" || f.raised_on_version === version) &&
      (!sectionKeys || (!!f.section_key && sectionKeys.has(f.section_key))),
  );

  // Arriving at the open feedback: the first item at the top of the panel, its actions in view.
  const ready = !!items && items.length > 0;
  useEffect(() => {
    if (!focus || !ready) return;
    const el = listRef.current?.querySelector<HTMLElement>("[data-testid=feedback-item]");
    if (!el) return;
    const box = el.closest<HTMLElement>("[role=tabpanel]");
    if (box && box.scrollHeight > box.clientHeight + 1 && getComputedStyle(box).overflowY !== "visible") {
      box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - 8;
      if (box.getBoundingClientRect().bottom > window.innerHeight || box.getBoundingClientRect().top < 0) {
        box.scrollIntoView({ block: "nearest" });
      }
    } else {
      el.scrollIntoView({ block: "start" });
    }
    onFocused?.();
  }, [focus, ready, onFocused]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-0 flex-1">
          <span className="sr-only">Status</span>
          <select
            aria-label="Filter by status"
            value={status}
            onChange={(e) => onStatus(e.target.value as FeedbackStatus | "")}
            className={`${SELECT} w-full`}
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-1">
          <span className="sr-only">Raised on</span>
          <select
            aria-label="Filter by version"
            value={version}
            onChange={(e) => setVersion(e.target.value ? Number(e.target.value) : "")}
            className={`${SELECT} w-full`}
          >
            <option value="">All versions</option>
            {versions.map((v) => (
              <option key={v.number} value={v.number}>
                Raised on v{v.number}
              </option>
            ))}
          </select>
        </label>
        {items && (
          <span className="tnum flex-none text-[13px] font-semibold text-text2">
            {items.length} item{items.length === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {!all && !error && <Loading />}
      {items && items.length === 0 && <Empty>No feedback</Empty>}
      {items && items.length > 0 && (
        <ol ref={listRef} className="flex flex-col" aria-label="Feedback items">
          {items.map((f) => (
            <FeedbackRow key={f.id} item={f} doc={doc} current={current} goTo={goTo} onChanged={reload} />
          ))}
        </ol>
      )}
    </div>
  );
}

/** How this version handled feedback raised on earlier versions; `sectionKeys` as in FeedbackPanel. */
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
