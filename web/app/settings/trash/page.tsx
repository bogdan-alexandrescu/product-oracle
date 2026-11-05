"use client";

import { useState } from "react";

import { entryText, itemKind } from "@/components/ArtifactMenu";
import { Button, Chip, InfoTip, Notice, PageHeader, toast } from "@/components/ds"; // MOCK-HOOK
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { artifactsChanged } from "@/lib/artifacts";
import { formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { mkParam, MkTrashList } from "@/components/simple/PanelMenuMock"; // MOCK-HOOK
import { MK_DOCS } from "@/lib/api/mock/panel-trash"; // MOCK-HOOK
import { errorMessage, useQuery } from "@/lib/use-query";

type Entry = Schemas["TrashEntryOut"];

function Row({ e, onRestored }: { e: Entry; onRestored: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function restore() {
    setBusy(true);
    setError(null);
    try {
      await unwrap(api.POST("/v1/trash/{entry_id}/restore", { params: { path: { entry_id: e.id } } }));
      artifactsChanged();
      toast({ message: `Restored ${entryText(e.root, e.items)}` });
      onRestored();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }
  return (
    <li data-testid="trash-entry" className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3 max-[600px]:px-3">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2">
          {mkParam("pm3", "a") === "a" ? <Chip kind="line">{itemKind(e.root)}</Chip> /* MOCK-HOOK */ : <span className="text-[13px] font-semibold text-text2">{itemKind(e.root)}</span>}
          <span className="min-w-0 font-semibold break-words">{e.root.title}</span>
          {e.published && <Chip kind="warn">Was published</Chip>}
        </p>
        {e.items.length > 0 && (
          <ul aria-label={`Went with ${e.root.title}`} className="mt-1 flex flex-col gap-0.5 text-sm">
            {e.items.map((i) => (
              <li key={i.id} className="flex min-w-0 items-baseline gap-2">
                <span className="flex-none text-[13px] text-text2">{itemKind(i)}</span>
                <span className="min-w-0 break-words">{i.title}</span>
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
        <Button aria-label={`Restore ${e.root.title}`} disabled={busy} onClick={restore}>
          Restore
        </Button>
      </div>
    </li>
  );
}

/** Settings › Trash (#482, owners): each delete with what went with it, Restore and days left. */
export default function TrashPage() {
  const { can, loading } = useMe(); // MOCK-HOOK
  const owner = can("list_trash");
  const q = useQuery(owner ? "trash" : "trash|none", () => (owner ? unwrap(api.GET("/v1/trash")) : Promise.resolve([] as Entry[])));
  return (
    <>
      <PageHeader
        title="Trash"
        info={
          <InfoTip label="Trash" align="start" side="bottom">
            Deleted features, goals and documents wait here for 30 days, with everything that went with them. Restore brings them back
            together; after 30 days they are gone for good. {/* MOCK-HOOK */}
          </InfoTip>
        }
      />
      {/* MOCK-HOOK: features and goals beside documents (pm3); approvers and viewers read features and goals. */}
      {!loading && (
        <MkTrashList
          owner={owner}
          proposes={!owner && can("create_simple_change")}
          docs={(q.data?.length ? q.data : owner ? (MK_DOCS as Entry[]) : []).map((e) => ({ kind: itemKind(e.root), title: e.root.title, by: e.deleted_by_name ?? "someone", at: e.deleted_at, days_left: e.days_left, node: <Row e={e} onRestored={() => q.setData((rows) => rows?.filter((r) => r.id !== e.id))} /> }))} /* MOCK-HOOK */
        />
      )}
      {/* MOCK-HOOK: the Deleted panel and its owners-only notice are drawn by MkTrashList above. */}
    </>
  );
}
