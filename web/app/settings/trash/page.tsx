"use client";

import Link from "next/link";
import { useState } from "react";

import { entrySummary, entryText, itemKind, itemTitle } from "@/components/ArtifactMenu";
import { Button, Chip, confirmInPage, Empty, InfoTip, Notice, PageHeader, Panel, toast } from "@/components/ds";
import { LoadError } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { artifactsChanged } from "@/lib/artifacts";
import { formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

type Entry = Schemas["TrashEntryOut"];

/** F-68: deletes an entry for good now (owners; DELETE /v1/trash/{entry_id}). */
/** G-4: what an entry holds beyond its name, in a few words: a goal's features, an agenda item's meeting. */
function holds(root: Entry["root"]): string | null {
  if (root.type === "goal" && root.features != null) return `with ${root.features} ${root.features === 1 ? "feature" : "features"}`;
  if (root.type === "agenda_item" && root.meeting) return `from ${root.meeting}`;
  return null;
}

/** G-4: Restore's (i): "Restore brings back Goal Activation with 5 features". */
function restoreText(e: Entry): string {
  const name = e.root.code ? `${e.root.code} ${e.root.title}` : itemTitle(e.root, e.root.title);
  const what = `${itemKind(e.root)} ${name}`;
  if (e.root.type === "agenda_item" && e.root.meeting) return `Restore brings back ${what} to the agenda of ${e.root.meeting}.`;
  const held = holds(e.root);
  if (held) return `Restore brings back ${what} ${held}, as they were.`;
  if (e.items.length) return `Restore brings back ${entryText(e.root, e.items)}, together.`;
  return `Restore brings back ${what} as it was.`;
}

const purge = (e: Entry) => unwrap(api.DELETE("/v1/trash/{entry_id}", { params: { path: { entry_id: e.id } } }));

function Row({ e, mayPurge, onGone }: { e: Entry; mayPurge: boolean; onGone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function restore() {
    setBusy(true);
    setError(null);
    try {
      const out = await unwrap(api.POST("/v1/trash/{entry_id}/restore", { params: { path: { entry_id: e.id } } }));
      artifactsChanged();
      // A task whose feature is still in Trash: "Restored Task Spec; it shows when F-3 Ledger is restored".
      const held = out.not_restored.map((n) => `; ${n.reason}`).join("");
      toast({ message: `Restored ${entrySummary(e.root, e.items)}${held}` });
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
      toast({ message: `Deleted for good: ${entrySummary(e.root, e.items)}` });
      onGone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }
  return (
    <li data-testid="trash-entry" className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3 max-[600px]:px-3">
      {/* Below 600px the buttons take their own line under the text, so a name never squeezes. */}
      <div className="min-w-0 flex-1 max-[600px]:basis-full">
        <p className="flex flex-wrap items-baseline gap-x-2">
          {/* port-an-decisions: one list, each entry's kind as a chip (Document, Feature, Agenda item, Request, ...). */}
          <Chip kind="line" data-testid="trash-kind">
            {itemKind(e.root)}
          </Chip>
          {/* A feature's code before its name ("F-26 Alert rules engine"), as the roadmap reads it. */}
          <span className="min-w-0 font-semibold break-words">{e.root.code ? `${e.root.code} ${e.root.title}` : itemTitle(e.root, e.root.title)}</span>
          {e.published && <Chip kind="warn">Was published</Chip>}
        </p>
        {holds(e.root) && (
          <p className="mt-0.5 text-sm break-words text-text2" data-testid="trash-holds">
            {holds(e.root)}
          </p>
        )}
        {e.items.length > 0 && (
          <ul aria-label={`Went with ${e.root.title}`} className="mt-1 flex flex-col gap-0.5 text-sm">
            {e.items.map((i) => (
              <li key={i.id} className="flex min-w-0 items-baseline gap-2">
                {/* A run's title says it is a run ("The run of Oct 17 that wrote …"). */}
                {i.type !== "run" && <span className="flex-none text-[13px] text-text2">{itemKind(i)}</span>}
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
          <>
            <Button aria-label={`Restore ${e.root.title}`} disabled={busy} onClick={restore}>
              Restore
            </Button>
            <InfoTip label={`restoring ${e.root.title}`} side="bottom">
              {restoreText(e)}
            </InfoTip>
          </>
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

/** Settings › Trash (#482): each delete with what went with it, Restore and days left, as one list
 * with each entry's kind as a chip. Owners see everything; others what they deleted (features,
 * goals, decisions, questions, meeting agenda items), which they restore themselves (its
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
    const names = rows.map((e) => (e.root.code ? `${e.root.code} ${e.root.title}` : itemTitle(e.root, e.root.title)));
    const what = names.length > 3 ? `${names.length} deleted items` : names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
    const along = rows.reduce((n, e) => n + e.items.length, 0);
    const ok = await confirmInPage({
      title: "Empty Trash?",
      message: `Everything here goes for good: ${what}${along ? `, and the ${along} ${along === 1 ? "item" : "items"} that went with ${rows.length === 1 ? "it" : "them"}` : ""}. This cannot be undone.`,
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
      toast({ message: "Trash is empty" });
    } catch (err) {
      setEmptyError(errorMessage(err));
    } finally {
      // Even when one fails partway, what did go is gone: other pages refresh their counts.
      artifactsChanged();
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
          count={q.error ? undefined : q.data?.length}
          tools={
            mayPurge &&
            !q.error &&
            !!q.data?.length && (
              <Button variant="ghost" disabled={emptying} onClick={() => void emptyTrash()}>
                Empty Trash
              </Button>
            )
          }
        >
          {/* F-1: a list that did not load says so, with Try again, and nothing under it. */}
          {q.error && (
            <div className="p-4">
              <LoadError what="the trash" error={q.error} onRetry={() => void q.reload()} />
            </div>
          )}
          {emptyError && <Notice tone="error">{emptyError}</Notice>}
          {!q.error && q.data && q.data.length === 0 && (
            <Empty testId="trash-empty">
              <span className="inline-flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
                Trash is empty.
                {/* Where they delete: owners documents, everyone else the roadmap's features and goals. */}
                {can("delete_document") ? (
                  <Link href="/documents" className="font-semibold text-accent-ink hover:underline">
                    Open PRDs
                  </Link>
                ) : (
                  <Link href="/simple/roadmap" className="font-semibold text-accent-ink hover:underline">
                    Open the roadmap
                  </Link>
                )}
                <InfoTip label="deleted items" side="bottom">
                  What you delete waits here for 30 days, with everything that went with it. Until then an owner, or
                  whoever deleted a feature, goal, decision or agenda item, can restore it; after that it is gone for
                  good.
                </InfoTip>
              </span>
            </Empty>
          )}
          {!q.error && q.data && q.data.length > 0 && (
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
