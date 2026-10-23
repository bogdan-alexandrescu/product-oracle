"use client";

import { useEffect, useRef, useState } from "react";

import { Chip, Icon } from "@/components/ds";
import { ErrorNote } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { errorMessage, useQuery } from "@/lib/use-query";

type Item = Schemas["StagingItem"];

/** How long a removed chip can be brought back before it is removed on the server. */
export const UNDO_MS = 5000;

/**
 * G4 One staging list: the chip row of everything staged for one checkpoint, from review rows
 * and from discussions alike ("Staged: …"). Approvers remove a chip with "×" and may Undo for
 * 5 s; the removal reaches the server (D8's delete, or unstaging a next-draft row) only then.
 */
export function StagingBar({ runId, checkpointId, revision }: { runId: string; checkpointId: string; revision: number }) {
  const q = useQuery(`staging|${checkpointId}`, () =>
    unwrap(api.GET("/v1/staging", { params: { query: { checkpoint: checkpointId } } })),
  );
  const { reload } = q;
  // The shared draft changed (a row action, another approver): read the list again.
  useEffect(() => void reload(), [revision, reload]);
  const [removed, setRemoved] = useState<Item | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const commit = async (item: Item) => {
    try {
      if (item.source === "next_draft_change") {
        await unwrap(
          api.POST("/v1/next-draft-changes/{change_id}/unstage", {
            params: { path: { change_id: item.id } },
            body: { lock_version: item.lock_version ?? 1 },
          }),
        );
      } else {
        await unwrap(
          api.DELETE("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/actions/{action_id}", {
            params: { path: { run_id: runId, checkpoint_id: checkpointId, action_id: item.id } },
          }),
        );
      }
    } catch (e) {
      setError(errorMessage(e));
    }
    setRemoved((r) => (r?.id === item.id ? null : r));
    await q.reload();
  };
  const remove = (item: Item) => {
    if (timer.current) clearTimeout(timer.current);
    // An earlier removal still waiting for its Undo goes through now.
    if (removed) void commit(removed);
    setRemoved(item);
    timer.current = setTimeout(() => void commit(item), UNDO_MS);
  };
  const undo = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setRemoved(null);
  };

  const list = q.data;
  const staged = (list?.items ?? []).filter((i) => i.state === "staged" && i.id !== removed?.id);
  return (
    <div data-testid="staging-bar" className="flex flex-wrap items-center gap-1.5 text-sm">
      <span className="font-medium text-text2">Staged:</span>
      {list && staged.length === 0 && <span className="text-text2">Nothing staged</span>}
      {staged.map((item) => {
        const line = item.origin === "discussion" ? (item.origin_line ?? "From a private discussion") : null;
        return (
          <span key={item.id} data-testid="staged-chip" className="inline-flex max-w-full">
            <Chip kind="line" wrap title={item.reason ?? undefined}>
              {line && (
                <span role="img" aria-label={line} title={line} data-testid="chip-discussion" className="inline-flex">
                  <Icon name="comment" size={16} />
                </span>
              )}
              {item.label}
              {list?.can_stage && (
                <button type="button" aria-label={`Remove ${item.label}`} onClick={() => remove(item)} className="ml-1 inline-flex hover:text-crit">
                  <Icon name="x" size={16} />
                </button>
              )}
            </Chip>
          </span>
        );
      })}
      {removed && (
        <span role="status" className="text-text2">
          Removed {removed.label}.{" "}
          <button type="button" onClick={undo} className="font-medium text-accent-ink hover:underline">
            Undo
          </button>
        </span>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}
