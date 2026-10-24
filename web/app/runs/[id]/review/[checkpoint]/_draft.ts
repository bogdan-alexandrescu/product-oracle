import { api, unwrap, type Schemas } from "@/lib/api/client";

type Review = Schemas["CheckpointReview"];

/**
 * The checkpoint's shared draft (D8), asked for by the shell together with the run
 * (./_shell.tsx) rather than by its view once the run has answered: the first load waits
 * for the slower of the two reads, not their sum. The view takes the read begun for it; its
 * reloads read again.
 */
const begun = new Map<string, Promise<Review>>();

export const draftKey = (runId: string, checkpointId: string) => `draft|${runId}|${checkpointId}`;

function readDraft(runId: string, checkpointId: string): Promise<Review> {
  return unwrap(api.GET("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/review", { params: { path: { run_id: runId, checkpoint_id: checkpointId } } }));
}

/** Begins the draft's read; the returned function forgets it if no view took it. */
export function beginDraft(runId: string, checkpointId: string): () => void {
  const key = draftKey(runId, checkpointId);
  const read = readDraft(runId, checkpointId);
  // A failure shows in the view that takes the read, never as an unhandled rejection here.
  read.catch(() => undefined);
  begun.set(key, read);
  return () => {
    if (begun.get(key) === read) begun.delete(key);
  };
}

/** The draft: the read the shell began, once, else a new one. */
export function loadDraft(runId: string, checkpointId: string): Promise<Review> {
  const key = draftKey(runId, checkpointId);
  const read = begun.get(key);
  begun.delete(key);
  return read ?? readDraft(runId, checkpointId);
}
