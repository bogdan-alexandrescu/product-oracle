"use client";

import Link from "next/link";
import { useState } from "react";

import { Button, Chip, Empty, InfoTip, LinkButton, Notice, Page, PageHeader, Panel, type ChipKind } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatDate } from "@/lib/format";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import { NewEntryDialog } from "./_new-entry";

type Entry = Schemas["ChangelogEntryOut"];

const CATEGORIES: Entry["category"][] = ["added", "changed", "deprecated", "removed", "fixed", "security"];
const CATEGORY_LABEL: Record<Entry["category"], string> = {
  added: "Added",
  changed: "Changed",
  deprecated: "Deprecated",
  removed: "Removed",
  fixed: "Fixed",
  security: "Security",
};
const STATUS_LABEL: Record<Entry["status"], string> = { draft: "Draft", published: "Published", withdrawn: "Withdrawn" };
const STATUS_KIND: Record<Entry["status"], ChipKind> = { draft: "na", published: "pass", withdrawn: "line" };

/** Days newest first, each with its categories in Keep a Changelog's order. */
function grouped(entries: Entry[]): [string, [Entry["category"], Entry[]][]][] {
  const days = [...new Set(entries.map((e) => e.released_on))].sort().reverse();
  return days.map((day) => [
    day,
    CATEGORIES.map((c) => [c, entries.filter((e) => e.released_on === day && e.category === c)] as [Entry["category"], Entry[]]).filter(
      ([, rows]) => rows.length > 0,
    ),
  ]);
}

/**
 * Changelog (H6): what changed, newest first, dated and grouped by category. Internal entries
 * are for every member; an approver publishes public ones, then exports them for a person to
 * post on the company's site. Oracle posts nothing outside.
 */
export default function ChangelogPage() {
  const q = useQuery("changelog", () => unwrap(api.GET("/v1/changelog", { params: { query: { limit: 500 } } })));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const { can } = useMe();
  const entries = q.data ?? [];

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

  async function exportAs(format: "md" | "html") {
    setBusy(`export-${format}`);
    setError(null);
    try {
      const { data, error: failed, response } = await api.GET("/v1/changelog/export", {
        params: { query: { audience: "public", format } },
        parseAs: "text",
      });
      if (!response.ok || typeof data !== "string") throw new Error(typeof failed === "string" ? failed : "The export failed.");
      const blob = new Blob([data], { type: format === "html" ? "text/html" : "text/markdown" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `changelog.${format}`;
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setError(e instanceof Error ? e.message : errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Page>
      <PageHeader
        title="Changelog"
        back={
          <Link href="/roadmap" className="hover:underline">
            Roadmap
          </Link>
        }
        status={
          q.data && (
            <>
              <Chip kind="acc">{entries.length} entries</Chip>
              <InfoTip label="Changelog" align="start" side="bottom">
                Internal entries are for everyone at the company. Public entries need an approver&apos;s Publish; Export
                gives the published ones as Markdown or HTML for a person to post. Oracle posts nothing outside.
              </InfoTip>
            </>
          )
        }
        action={
          <div className="flex flex-wrap gap-2">
            <LinkButton href="/roadmap/launches">Launches</LinkButton>
            <Button disabled={busy !== null} onClick={() => exportAs("md")} data-testid="export-md">
              Export Markdown
            </Button>
            <Button disabled={busy !== null} onClick={() => exportAs("html")} data-testid="export-html">
              Export HTML
            </Button>
            {can("create_changelog_entry") && (
              <Button variant="primary" icon="plus" onClick={() => setCreating(true)} data-testid="new-entry">
                New entry
              </Button>
            )}
          </div>
        }
      />
      <div className="flex flex-col gap-3">
        {(q.error || error) && <Notice tone="error">{q.error ?? error}</Notice>}
        <Panel testId="changelog">
          {q.data && entries.length === 0 && <Empty>No changelog entries yet</Empty>}
          {grouped(entries).map(([day, groups]) => (
            <section key={day} aria-label={formatDate(`${day}T12:00:00Z`)} data-testid="changelog-day" className="border-b border-line px-4 py-3 last:border-b-0 max-[600px]:px-3">
              <h2 className="font-display text-lg font-bold tracking-heading">
                <time dateTime={day}>{day}</time>
              </h2>
              {groups.map(([category, rows]) => (
                <div key={category} data-testid="changelog-category" data-category={category} className="mt-2">
                  <h3 className="text-[13px] font-semibold tracking-[0.02em] text-text2">{CATEGORY_LABEL[category]}</h3>
                  <ul className="mt-1 flex flex-col divide-y divide-line">
                    {rows.map((e) => (
                      <EntryRow key={e.id} entry={e} busy={busy} act={act} />
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ))}
        </Panel>
      </div>
      {creating && (
        <NewEntryDialog
          categories={CATEGORIES}
          categoryLabel={CATEGORY_LABEL}
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await q.reload();
          }}
        />
      )}
    </Page>
  );
}

function EntryRow({
  entry,
  busy,
  act,
}: {
  entry: Entry;
  busy: string | null;
  act: (key: string, call: () => Promise<unknown>) => Promise<void>;
}) {
  const { can } = useMe();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(entry.title);
  const [body, setBody] = useState(entry.body);
  const path = { params: { path: { entry_id: entry.id } } };
  return (
    <li className="flex flex-col gap-1.5 py-2" data-testid="changelog-entry" data-status={entry.status}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 font-medium">{entry.title}</span>
        <Chip kind={entry.audience === "public" ? "acc" : "line"}>{entry.audience === "public" ? "Public" : "Internal"}</Chip>
        <Chip kind={STATUS_KIND[entry.status]} dot data-testid="entry-status">
          {STATUS_LABEL[entry.status]}
        </Chip>
      </div>
      {entry.body && <p className="text-[15px] leading-6 text-text2">{entry.body}</p>}
      {/* #370: each action shows only for a role that may call it. */}
      <div className="flex flex-wrap gap-1.5 empty:hidden">
        {can("update_changelog_entry") && (
          <Button variant="ghost" onClick={() => setEditing((x) => !x)}>
            Edit
          </Button>
        )}
        {entry.status === "draft" && can("publish_changelog_entry") && (
          <Button disabled={busy !== null} onClick={() => act(`publish-${entry.id}`, () => unwrap(api.POST("/v1/changelog/{entry_id}/publish", path)))}>
            Publish
          </Button>
        )}
        {entry.status === "published" && can("withdraw_changelog_entry") && (
          <Button
            variant="ghost"
            disabled={busy !== null}
            onClick={() => act(`withdraw-${entry.id}`, () => unwrap(api.POST("/v1/changelog/{entry_id}/withdraw", path)))}
          >
            Withdraw
          </Button>
        )}
      </div>
      {editing && (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-sm font-medium">
            Title
            <input className="h-9 rounded-lg border border-line-strong bg-surface px-2.5 text-[15px]" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium">
            What changed
            <textarea className="min-h-20 rounded-lg border border-line-strong bg-surface p-2.5 text-[15px]" value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
          <Button
            variant="solid"
            disabled={busy !== null || !title.trim()}
            onClick={() =>
              act(`edit-${entry.id}`, async () => {
                await unwrap(api.PATCH("/v1/changelog/{entry_id}", { ...path, body: { title: title.trim(), body, lock_version: entry.lock_version } }));
                setEditing(false);
              })
            }
          >
            Save
          </Button>
        </div>
      )}
    </li>
  );
}
