"use client";

import Link from "next/link";
import { useState } from "react";

import { entryText, itemKind, itemTitle } from "@/components/ArtifactMenu";
import { Button, Chip, confirmInPage, Empty, InfoTip, Notice, PageHeader, Panel, toast } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { artifactsChanged } from "@/lib/artifacts";
import { formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

type Entry = Schemas["TrashEntryOut"];

/** F-68: deletes an entry for good now (owners; DELETE /v1/trash/{entry_id}). */
const purge = (e: Entry) => unwrap(api.DELETE("/v1/trash/{entry_id}", { params: { path: { entry_id: e.id } } }));

function Row({ e, mayPurge, onGone }: { e: Entry; mayPurge: boolean; onGone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function restore() {
    setBusy(true);
    setError(null);
    try {
      await unwrap(api.POST("/v1/trash/{entry_id}/restore", { params: { path: { entry_id: e.id } } }));
      artifactsChanged();
      toast({ message: `Restored ${entryText(e.root, e.items)}` });
      onGone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }
  async function deleteForGood() {
    const ok = await confirmInPage({
      title: `Delete ${itemTitle(e.root, e.root.title)} for good?`,
      message: e.items.length ? `${entryText(e.root, e.items)} go for good. This cannot be undone.` : "It goes for good. This cannot be undone.",
      action: "Delete for good",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await purge(e);
      artifactsChanged();
      toast({ message: `Deleted for good: ${entryText(e.root, e.items)}` });
      onGone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }
  return (
    <li data-testid="trash-entry" className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3 max-[600px]:px-3">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[13px] font-semibold text-text2">{itemKind(e.root)}</span>
          {/* A feature's code before its name ("F-26 Alert rules engine"), as the roadmap reads it. */}
          <span className="min-w-0 font-semibold break-words">{e.root.code ? `${e.root.code} ${e.root.title}` : itemTitle(e.root, e.root.title)}</span>
          {e.published && <Chip kind="warn">Was published</Chip>}
        </p>
        {e.items.length > 0 && (
          <ul aria-label={`Went with ${e.root.title}`} className="mt-1 flex flex-col gap-0.5 text-sm">
            {e.items.map((i) => (
              <li key={i.id} className="flex min-w-0 items-baseline gap-2">
                <span className="flex-none text-[13px] text-text2">{itemKind(i)}</span>
                {/* F-69: a run by the same title the delete dialog gave it. */}
                <span className="min-w-0 break-words">{itemTitle(i, e.root.title)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-sm text-text2">
          Deleted by {e.deleted_by_name ?? "someone"} on {formatDateTime(e.deleted_at)}
          {e.reason ? `: ${e.reason}` : ""}
        </p>
        {error && <Notice tone="error">{error}</Notice>}
      </div>
      <div className="flex flex-none items-center gap-2">
        <Chip kind={e.days_left <= 3 ? "warn" : "line"}>
          {e.days_left} {e.days_left === 1 ? "day" : "days"} left
        </Chip>
        {e.can_restore && (
          <Button aria-label={`Restore ${e.root.title}`} disabled={busy} onClick={restore}>
            Restore
          </Button>
        )}
        {mayPurge && (
          <Button variant="ghost" aria-label={`Delete ${e.root.title} for good`} disabled={busy} onClick={() => void deleteForGood()}>
            Delete for good
          </Button>
        )}
      </div>
    </li>
  );
}

/** Settings › Trash (#482): each delete with what went with it, Restore and days left. Owners see
 * everything; others the features and goals they deleted, which they restore themselves (its
 * can_restore). */
export default function TrashPage() {
  const { can, loading } = useMe();
  const sees = can("list_trash");
  const q = useQuery(sees ? "trash" : "trash|none", () => (sees ? unwrap(api.GET("/v1/trash")) : Promise.resolve([] as Entry[])));
  const mayPurge = can("purge_trash_entry");
  const [emptying, setEmptying] = useState(false);
  const [emptyError, setEmptyError] = useState<string | null>(null);
  // F-68: every entry for good, at once (owners).
  async function emptyTrash() {
    const rows = q.data ?? [];
    const ok = await confirmInPage({
      title: "Empty Trash?",
      message: `${rows.length} ${rows.length === 1 ? "item goes" : "items go"} for good. This cannot be undone.`,
      action: "Empty Trash",
      destructive: true,
    });
    if (!ok) return;
    setEmptying(true);
    setEmptyError(null);
    try {
      for (const e of rows) {
        await purge(e);
        q.setData((all) => all?.filter((r) => r.id !== e.id));
      }
      artifactsChanged();
      toast({ message: "Trash is empty" });
    } catch (err) {
      setEmptyError(errorMessage(err));
    } finally {
      setEmptying(false);
    }
  }
  return (
    <>
      <PageHeader
        title="Trash"
        info={
          <InfoTip label="Trash" align="start" side="bottom">
            Deleted artifacts wait here for 30 days, with everything that went with them. Restore brings them back
            together; Delete for good, or 30 days, ends them.
          </InfoTip>
        }
      />
      {!loading && !sees ? (
        <Notice>Only owners delete and restore artifacts.</Notice>
      ) : (
        <Panel
          title="Deleted"
          count={q.data?.length}
          tools={
            mayPurge &&
            !!q.data?.length && (
              <Button variant="ghost" disabled={emptying} onClick={() => void emptyTrash()}>
                Empty Trash
              </Button>
            )
          }
        >
          {q.error && <Notice tone="error">{q.error}</Notice>}
          {emptyError && <Notice tone="error">{emptyError}</Notice>}
          {q.data && q.data.length === 0 && (
            <Empty testId="trash-empty">
              <span className="inline-flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
                Trash is empty.
                {/* Where they delete: owners documents, everyone else the roadmap's features and goals. */}
                {can("delete_document") ? (
                  <Link href="/documents" className="font-semibold text-accent-ink hover:underline">
                    Open Documents
                  </Link>
                ) : (
                  <Link href="/simple/roadmap" className="font-semibold text-accent-ink hover:underline">
                    Open the roadmap
                  </Link>
                )}
                <InfoTip label="deleted items" side="bottom">
                  What you delete waits here for 30 days, with everything that went with it. Until then an owner, or
                  whoever deleted a feature or goal, can restore it; after that it is gone for good.
                </InfoTip>
              </span>
            </Empty>
          )}
          {q.data && q.data.length > 0 && (
            <ul className="divide-y divide-line">
              {q.data.map((e) => (
                <Row key={e.id} e={e} mayPurge={mayPurge} onGone={() => q.setData((rows) => rows?.filter((r) => r.id !== e.id))} />
              ))}
            </ul>
          )}
        </Panel>
      )}
    </>
  );
}
