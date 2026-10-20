"use client";

import Link from "next/link";
import { useState } from "react";

import { BUILD_PARAM } from "@/components/NextDraft";
import { Chip, DataTable, Empty, Icon, LinkButton, Panel, type Column, type IconName } from "@/components/ds";
import { TabBar } from "@/components/review/parts";
import type { Schemas } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";

import { age, type InboxOut } from "../runs/_lib";

type Item = Schemas["InboxFeedbackItem"];
type StagedRow = Schemas["InboxStaged"];
export type InboxState = Item["state"];

/** The Inbox's feedback tabs (C1e), New first: the default tab on arrival. */
export const STATE_TABS: { id: InboxState; label: string }[] = [
  { id: "new", label: "New" },
  { id: "open", label: "Open" },
  { id: "staged", label: "Staged" },
  { id: "declined", label: "Declined" },
  { id: "done", label: "Done" },
];

/** One row: an item in some state, or a document's staged changes for its next draft. */
type Row =
  | { key: string; type: "item"; item: Item }
  | { key: string; type: "staged"; row: StagedRow };

const KIND: Record<InboxState, { icon: IconName; label: string }> = {
  new: { icon: "comment", label: "Feedback" },
  open: { icon: "comment", label: "Feedback" },
  staged: { icon: "check", label: "Accepted" },
  declined: { icon: "x", label: "Declined" },
  done: { icon: "check", label: "Addressed" },
};

const docHref = (slug: string, n: number | null | undefined, hash?: string | null) =>
  `/documents/${slug}${n ? `/v/${n}` : ""}${hash ? `#${hash}` : ""}`;

function Action({ r }: { r: Row }) {
  if (r.type === "staged") {
    const { row } = r;
    return (
      <LinkButton
        href={`${docHref(row.slug, row.latest_version)}?${BUILD_PARAM}=1`}
        aria-label={`Build draft ${row.next_version} of ${row.title}`}
        data-testid="inbox-build-draft"
      >
        Build draft {row.next_version}
      </LinkButton>
    );
  }
  const f = r.item;
  const slug = f.slug ?? "";
  if (f.state === "new" || f.state === "open") {
    return (
      <LinkButton href={docHref(slug, f.latest_version ?? f.raised_on_version, f.section_key)} aria-label={`Review ${f.summary}`}>
        {f.suggestion_status === "open" ? "Review suggestions" : "Review"}
      </LinkButton>
    );
  }
  if (f.state === "staged") {
    return (
      <LinkButton href={`${docHref(slug, f.latest_version)}?${BUILD_PARAM}=1`} aria-label={`Build draft ${f.staged_for_version} with ${f.summary}`}>
        Build draft {f.staged_for_version}
      </LinkButton>
    );
  }
  return (
    <LinkButton
      variant="ghost"
      href={docHref(slug, f.addressed_in_version ?? f.latest_version ?? f.raised_on_version, f.section_key)}
      aria-label={`View ${f.summary}`}
    >
      View
    </LinkButton>
  );
}

/** What became of an item: the draft it waits for, the decline note, the version that addressed it. */
function Outcome({ f }: { f: Item }) {
  if (f.state === "staged") return <Chip kind="now">Draft {f.staged_for_version}</Chip>;
  if (f.state === "declined")
    return (
      <span className="block truncate text-text2" title={f.resolution_note ?? undefined} data-testid="decline-note">
        {f.resolution_note ?? "Declined"}
      </span>
    );
  if (f.state === "done") return <Chip kind="pass">{f.addressed_in_version ? `v${f.addressed_in_version}` : "Closed"}</Chip>;
  if (f.state === "new") return <Chip kind="acc">New</Chip>;
  return <span className="tnum text-text2">v{f.raised_on_version}</span>;
}

const COLUMNS: Column<Row>[] = [
  {
    key: "kind",
    header: "Kind",
    width: "150px",
    phone: "meta",
    cell: (r) => {
      const k = r.type === "staged" ? { icon: "doc" as const, label: "Next draft" } : KIND[r.item.state];
      return (
        <span className="flex min-w-0 items-center gap-2.5 max-[600px]:gap-1.5" title={k.label}>
          <Icon name={k.icon} className="flex-none text-accent-ink" />
          <span className="truncate font-medium">{k.label}</span>
        </span>
      );
    },
  },
  {
    key: "item",
    header: "Item",
    phone: "title",
    cell: (r) =>
      r.type === "staged" ? (
        <span className="tnum truncate font-semibold" data-testid="staged-row-label">
          {r.row.count} change{r.row.count === 1 ? "" : "s"} staged for draft {r.row.next_version}
        </span>
      ) : (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate" title={r.item.summary}>
            {r.item.summary}
          </span>
          {r.item.section_key && <span className="flex-none font-mono text-[13px] text-text2">#{r.item.section_key}</span>}
        </span>
      ),
  },
  {
    key: "doc",
    header: "For",
    width: "22%",
    phone: "meta",
    cell: (r) => {
      const title = r.type === "staged" ? r.row.title : r.item.title;
      const slug = r.type === "staged" ? r.row.slug : r.item.slug;
      return slug ? (
        <Link href={`/documents/${slug}`} className="block truncate hover:underline">
          {title}
        </Link>
      ) : (
        <span className="block truncate">{title}</span>
      );
    },
  },
  {
    key: "outcome",
    header: "Outcome",
    width: "20%",
    phone: "meta",
    cell: (r) =>
      r.type === "staged" ? (
        r.row.draft_job_status ? (
          <Chip kind="acc">{r.row.draft_job_status === "succeeded" ? "Ready" : "Building"}</Chip>
        ) : (
          <span className="tnum text-text2">v{r.row.latest_version}</span>
        )
      ) : (
        <Outcome f={r.item} />
      ),
  },
  {
    key: "age",
    header: "Age",
    width: "56px",
    align: "right",
    phone: "meta",
    cell: (r) => {
      const at = r.type === "staged" ? null : r.item.state === "new" || r.item.state === "open" ? r.item.created_at : r.item.updated_at;
      return (
        <span className="tnum text-text2" title={at ? formatDateTime(at) : undefined}>
          {at ? age(at) : ""}
        </span>
      );
    },
  },
  {
    key: "act",
    header: <span className="sr-only">Action</span>,
    width: "190px",
    align: "right",
    phone: "action",
    cell: (r) => (
      <span className="inline-flex justify-end">
        <Action r={r} />
      </span>
    ),
  },
];

/**
 * The display state of an item this visit: what was new on arrival stays New until the
 * next visit, even though arriving marked it seen (`seenBefore`: my previous visit).
 */
export function visitState(item: Item, seenBefore: string | null | undefined): InboxState {
  if (item.state === "open" && seenBefore !== undefined && (seenBefore === null || item.created_at > seenBefore)) return "new";
  return item.state;
}

/** C1e: feedback by state in tabs with counts, New first; Staged leads with each document's next draft. */
export function FeedbackStates({ inbox, seenBefore }: { inbox: InboxOut; seenBefore: string | null | undefined }) {
  const [tab, setTab] = useState<InboxState>("new");
  const items = (inbox.items ?? []).map((i) => ({ ...i, state: visitState(i, seenBefore) }));
  const counts = Object.fromEntries(STATE_TABS.map((t) => [t.id, items.filter((i) => i.state === t.id).length])) as Record<
    InboxState,
    number
  >;
  const rows: Row[] = [
    ...(tab === "staged" ? (inbox.staged ?? []).map((row) => ({ key: `doc-${row.document_id}`, type: "staged" as const, row })) : []),
    ...items.filter((i) => i.state === tab).map((item) => ({ key: item.id, type: "item" as const, item })),
  ];
  const label = STATE_TABS.find((t) => t.id === tab)!.label;
  return (
    <Panel title="Feedback" count={counts.new + counts.open}>
      <div className="px-4 pt-1 max-[600px]:px-3" data-testid="inbox-state-tabs">
        <TabBar
          label="Feedback by state"
          tabs={STATE_TABS.map((t) => ({ id: t.id, label: t.label, count: counts[t.id] }))}
          value={tab}
          onChange={setTab}
        />
      </div>
      <div role="tabpanel" aria-label={label} data-testid={`inbox-tab-${tab}`}>
        {rows.length === 0 ? (
          <Empty>Nothing {label.toLowerCase()}</Empty>
        ) : (
          <DataTable
            label={`${label} feedback`}
            columns={COLUMNS}
            rows={rows}
            rowKey={(r) => r.key}
            hideHeader
            rowProps={(r) => ({ "data-state": r.type === "staged" ? "staged-doc" : r.item.state })}
          />
        )}
      </div>
    </Panel>
  );
}
