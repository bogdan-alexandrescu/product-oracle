"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import {
  Button,
  Chip,
  CostFigure,
  DataTable,
  Empty,
  Icon,
  InfoTip,
  LinkButton,
  Page,
  PageHeader,
  Panel,
  type Column,
  type IconName,
} from "@/components/ds";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { errorMessage, useQuery } from "@/lib/use-query";

import { CHECKPOINT_LABEL, age, shortId, usd, type InboxOut, type RunSummary } from "../runs/_lib";

/** One row of B1's "Needs you" table: kind, item, context, age, the action. */
type Need = {
  key: string;
  icon: IconName;
  kind: string;
  item: ReactNode;
  context: ReactNode;
  run?: string;
  at?: string | null;
  action: ReactNode;
};

const COLUMNS: Column<Need>[] = [
  {
    key: "kind",
    header: "Kind",
    width: "170px",
    phone: "meta",
    cell: (n) => (
      <span className="flex min-w-0 items-center gap-2.5 max-[600px]:gap-1.5" title={n.kind}>
        <Icon name={n.icon} className="flex-none text-accent-ink" />
        <span className="truncate font-medium">{n.kind}</span>
      </span>
    ),
  },
  {
    key: "item",
    header: "Item",
    phone: "title",
    cell: (n) => <span className="flex min-w-0 items-center gap-x-2.5 gap-y-1 max-[600px]:flex-wrap">{n.item}</span>,
  },
  { key: "context", header: "For", width: "26%", phone: "meta", cell: (n) => n.context },
  {
    key: "run",
    header: "Run",
    width: "64px",
    phone: "hide",
    cell: (n) => <span className="tnum font-mono text-sm text-text2">{n.run ?? ""}</span>,
  },
  {
    key: "age",
    header: "Age",
    width: "56px",
    align: "right",
    phone: "meta",
    cell: (n) => (
      <span className="tnum text-text2" title={n.at ? formatDateTime(n.at) : undefined}>
        {age(n.at)}
      </span>
    ),
  },
  {
    key: "act",
    header: <span className="sr-only">Action</span>,
    width: "212px",
    align: "right",
    phone: "action",
    cell: (n) => <span className="inline-flex flex-wrap justify-end gap-1.5">{n.action}</span>,
  },
];

function NeedTable({ title, testId, rows }: { title: string; testId: string; rows: Need[] }) {
  if (rows.length === 0) return null;
  return (
    <section aria-label={title} data-testid={testId}>
      <DataTable label={title} columns={COLUMNS} rows={rows} rowKey={(n) => n.key} hideHeader />
    </section>
  );
}

function RunName({ run }: { run: Pick<RunSummary, "flow_title" | "document_slug"> }) {
  return (
    <span className="min-w-0 truncate">
      {run.flow_title}
      {run.document_slug && <span className="ml-1.5 font-mono text-sm text-text2">{run.document_slug}</span>}
    </span>
  );
}

export default function InboxPage() {
  const q = useQuery("inbox", () => unwrap(api.GET("/v1/inbox")));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inbox = q.data;

  async function act(key: string, call: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await call();
      await q.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  const path = (id: string) => ({ params: { path: { run_id: id } } });

  return (
    <Page>
      <PageHeader title="Inbox" status={inbox && inbox.total > 0 && <Chip kind="acc">{inbox.total} waiting</Chip>} />
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {q.loading && !inbox && <Loading />}
      {error && (
        <div className="mb-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {inbox && <Needs inbox={inbox} busy={busy} act={act} path={path} />}
    </Page>
  );
}

function Needs({
  inbox,
  busy,
  act,
  path,
}: {
  inbox: InboxOut;
  busy: string | null;
  act: (key: string, call: () => Promise<unknown>) => Promise<void>;
  path: (id: string) => { params: { path: { run_id: string } } };
}) {
  const checkpoints: Need[] = inbox.checkpoints.map((c) => ({
    key: c.id,
    icon: "flag",
    kind: "Checkpoint",
    item: <span className="truncate">{CHECKPOINT_LABEL[c.kind]}</span>,
    context: (
      <span className="block truncate" title={[c.flow_title, c.segment_title, c.document_slug].filter(Boolean).join(" · ")}>
        {c.segment_title ?? c.flow_title}
        {c.document_slug && <span className="ml-1.5 font-mono text-sm text-text2">{c.document_slug}</span>}
      </span>
    ),
    run: shortId(c.run_id),
    at: c.created_at,
    action: (
      <LinkButton variant="solid" href={`/runs/${c.run_id}`}>
        Review
      </LinkButton>
    ),
  }));

  const approvals: Need[] = inbox.approvals.map((r) => ({
    key: r.id,
    icon: "coin",
    kind: "Cost approval",
    item: (
      <>
        <span className="truncate">Start run</span>
        <CostFigure usd={r.estimate_usd} est prominent />
        <span className="sr-only">Estimated {usd(r.estimate_usd)}, over the $50 approval threshold.</span>
      </>
    ),
    context: (
      <Link href={`/runs/${r.id}`} className="block truncate hover:underline">
        <RunName run={r} />
      </Link>
    ),
    run: shortId(r.id),
    at: r.created_at,
    action: (
      <Button
        aria-label={`Approve ${usd(r.estimate_usd)}`}
        disabled={busy !== null}
        onClick={() => act(`approve-${r.id}`, () => unwrap(api.POST("/v1/runs/{run_id}/approve", path(r.id))))}
      >
        Approve
      </Button>
    ),
  }));

  const overruns: Need[] = inbox.overruns.map((r) => ({
    key: r.id,
    icon: "pause",
    kind: "Overrun",
    item: (
      <>
        <span className="truncate">Resume or cancel</span>
        <CostFigure usd={r.spent_usd} of={r.estimate_usd} prominent />
        <span className="sr-only">Spent {usd(r.spent_usd)} of {usd(r.estimate_usd)} estimated</span>
      </>
    ),
    context: (
      <Link href={`/runs/${r.id}`} className="block truncate hover:underline">
        <RunName run={r} />
      </Link>
    ),
    run: shortId(r.id),
    at: r.started_at ?? r.created_at,
    action: (
      <>
        <Button
          disabled={busy !== null}
          onClick={() => act(`resume-${r.id}`, () => unwrap(api.POST("/v1/runs/{run_id}/resume", path(r.id))))}
        >
          Resume
        </Button>
        <Button
          variant="ghost"
          disabled={busy !== null}
          onClick={() => act(`cancel-${r.id}`, () => unwrap(api.POST("/v1/runs/{run_id}/cancel", path(r.id))))}
        >
          Cancel run
        </Button>
      </>
    ),
  }));

  const feedback: Need[] = inbox.feedback.map((d) => {
    const href = d.latest_version ? `/documents/${d.slug}/v/${d.latest_version}` : `/documents/${d.slug}`;
    const latest = d.items.map((f) => f.created_at).sort().at(-1);
    return {
      key: d.document_id,
      icon: "comment",
      kind: "Feedback",
      item: (
        <>
          <span className="tnum truncate" title={d.items.map((f) => `v${f.raised_on_version} · ${f.summary}`).join("\n")}>
            {d.open_count} open item{d.open_count === 1 ? "" : "s"}
          </span>
        </>
      ),
      context: <span className="block truncate">{d.title}</span>,
      at: latest,
      action: (
        <LinkButton href={href} aria-label={`Resolve ${d.title}`}>
          Resolve
        </LinkButton>
      ),
    };
  });

  return (
    <Panel
      title="Needs you"
      count={inbox.total}
      tools={
        inbox.total > 0 && (
          <>
            {checkpoints.length > 0 && <CountChip label="Checkpoints" n={checkpoints.length} />}
            {approvals.length + overruns.length > 0 && <CountChip label="Cost" n={approvals.length + overruns.length} />}
            {feedback.length > 0 && <CountChip label="Feedback" n={feedback.length} />}
          </>
        )
      }
    >
      {inbox.total === 0 ? (
        <Empty>
          Nothing waiting{" "}
          <InfoTip label="the inbox" align="start">
            Checkpoints that need a decision, such as a run waiting for budget approval or a draft ready for review, land
            here.
          </InfoTip>
        </Empty>
      ) : (
        <>
          <NeedTable title="Checkpoints" testId="inbox-checkpoints" rows={checkpoints} />
          <NeedTable title="Cost approvals" testId="inbox-approvals" rows={approvals} />
          <NeedTable title="Paused on overrun" testId="inbox-overruns" rows={overruns} />
          <NeedTable title="Open feedback" testId="inbox-feedback" rows={feedback} />
        </>
      )}
    </Panel>
  );
}

function CountChip({ label, n }: { label: string; n: number }) {
  return (
    <Chip kind="line">
      {label} <b className="tnum">{n}</b>
    </Chip>
  );
}
