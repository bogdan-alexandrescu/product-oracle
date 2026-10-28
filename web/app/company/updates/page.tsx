"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { DocStatusChip } from "@/app/documents/_components/DocStatusChip";
import { Button, Chip, DataTable, Empty, InfoTip, Panel, type Column } from "@/components/ds";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { formatDate } from "@/lib/format";
import { useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

import { CompanyHeader } from "../_nav";
import { NewUpdateDialog } from "./_components/NewUpdateDialog";
import { RowMenu, RowMenuItem } from "./_components/RowMenu";
import { VisibilityDialog } from "./_components/VisibilityDialog";
import { byNewestPeriod, formatPeriod, templateOf, VISIBILITY_LABEL, type Update } from "./_components/lib";

/**
 * Company › Updates (H8; owner 2026-10-21, "Update view" and "New pages"): the board and
 * investor updates Oracle drafts and an owner approves, newest period first. Owners and
 * approvers see them; commenters and viewers have no tab, and this page answers them with
 * "Not found". Owners start one (New update) and choose who sees it (a row's ⋯).
 */
export default function UpdatesPage() {
  const { can, capsReady, capsError } = useMe();
  if (!capsReady && !capsError) return <Loading />;
  // #370: the Updates tab's own read (company/_tabs.ts), for any item.
  if (!can("start_draft", true)) {
    return (
      <>
        <CompanyHeader />
        <Panel>
          <Empty testId="updates-not-found">Not found</Empty>
        </Panel>
      </>
    );
  }
  return <Updates />;
}

function Updates() {
  const { can } = useMe();
  // #370: New update starts an update_draft run, which only the run's handler role may; a
  // row's ⋯ changes who sees the update.
  const mayCreate = can("create_run");
  const mayShare = can("set_document_visibility");
  const q = useQuery("documents|update", () => unwrap(api.GET("/v1/documents", { params: { query: { kind: "update" } } })));
  const rows = useMemo(() => [...(q.data ?? [])].sort(byNewestPeriod), [q.data]);
  const [creating, setCreating] = useState(false);
  const [changing, setChanging] = useState<Update | null>(null);

  const columns: Column<Update>[] = [
    {
      key: "title",
      header: "Title",
      phone: "title",
      cell: (u) => (
        <Link href={`/documents/${u.slug}`} className="truncate font-medium text-text hover:underline" data-testid="update-title">
          {u.title}
        </Link>
      ),
    },
    {
      key: "template",
      header: "Template",
      width: "104px",
      phone: "meta",
      cell: (u) => <span className="text-sm text-text2">{templateOf(u.template)?.short ?? u.template ?? "—"}</span>,
    },
    {
      key: "period",
      header: "Period",
      width: "200px",
      phone: "meta",
      cell: (u) => (
        <span className="tnum text-sm" data-testid="update-period">
          {formatPeriod(u.period)}
        </span>
      ),
    },
    { key: "state", header: "State", width: "112px", phone: "meta", cell: (u) => <DocStatusChip status={u.status} dot /> },
    {
      key: "visibility",
      header: "Visibility",
      width: "200px",
      phone: "meta",
      cell: (u) => (
        <span data-testid="update-visibility" className="inline-flex">
          <Chip kind={u.visibility === "company" ? "line" : "acc"}>{VISIBILITY_LABEL[u.visibility]}</Chip>
        </span>
      ),
    },
    {
      key: "updated",
      header: "Updated",
      width: "120px",
      phone: "hide",
      cell: (u) => <span className="tnum text-sm">{formatDate(u.updated_at)}</span>,
    },
    ...(mayShare
      ? [
          {
            key: "actions",
            header: <span className="sr-only">Actions</span>,
            width: "56px",
            phone: "action" as const,
            cell: (u: Update) => (
              <RowMenu label={`Actions for ${u.title}`}>
                {(close) => (
                  <RowMenuItem
                    onClick={() => {
                      close();
                      setChanging(u);
                    }}
                  >
                    {u.visibility === "approvers" ? "Share with the whole company…" : "Limit to owners and approvers…"}
                  </RowMenuItem>
                )}
              </RowMenu>
            ),
          },
        ]
      : []),
  ];

  return (
    <>
      <CompanyHeader
        action={
          mayCreate && (
            <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
              New update
            </Button>
          )
        }
      />
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      <Panel
        title="Updates"
        count={q.data ? rows.length : undefined}
        tools={
          <InfoTip label="updates" align="end">
            The product part of the board update and the monthly investor update. Oracle drafts them from goals, tracks, launches and outcomes:
            metrics first, only dates a verified schedule basis supports, and the asks left for an owner. An owner decides what is said and
            approves; owners and approvers see them unless an owner shares one with the whole company.
          </InfoTip>
        }
      >
        {q.data && rows.length === 0 ? (
          <Empty testId="updates-empty">No updates yet</Empty>
        ) : (
          <DataTable
            label="Updates"
            testId="updates-table"
            columns={columns}
            rows={q.data ? rows : undefined}
            loading={q.loading}
            rowKey={(u) => u.slug}
            rowProps={(u) => ({ "data-testid": "update-row", "data-slug": u.slug })}
          />
        )}
      </Panel>
      {creating && mayCreate && <NewUpdateDialog updates={rows} onClose={() => setCreating(false)} />}
      {changing && mayShare && (
        <VisibilityDialog
          update={changing}
          onClose={() => setChanging(null)}
          onChanged={(out) => {
            setChanging(null);
            q.setData((list) => (list ?? []).map((u) => (u.slug === out.slug ? { ...u, visibility: out.visibility, updated_at: out.updated_at } : u)));
          }}
        />
      )}
    </>
  );
}
