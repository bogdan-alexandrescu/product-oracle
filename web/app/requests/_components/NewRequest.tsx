"use client";

import { useRef, useState, type FormEvent } from "react";

import { Button, useFocusTrap } from "@/components/ds";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { displayName } from "@/lib/names";
import { errorMessage, useQuery } from "@/lib/use-query";

import { CHANNEL_LABEL } from "./RequestList";

type Request = Schemas["RequestOut"];

/**
 * New request (#329): the button on the Requests header and in its empty state. #370: a role
 * that cannot file a request (a viewer) is not shown it.
 */
export function NewRequestButton({
  onFiled,
  variant = "primary",
  className,
}: {
  onFiled: (request: Request) => void;
  /** The header's is the page's primary action; the empty state's is secondary. */
  variant?: "primary" | "secondary";
  className?: string;
}) {
  const { can } = useMe();
  const [open, setOpen] = useState(false);
  // create_request's handler wants an owner only to name someone else as the requester.
  if (!can("create_request", true)) return null;
  return (
    <>
      <Button variant={variant} icon="plus" className={className} onClick={() => setOpen(true)}>
        New request
      </Button>
      {open && (
        <NewRequestDialog
          onClose={() => setOpen(false)}
          onFiled={(request) => {
            setOpen(false);
            onFiled(request);
          }}
        />
      )}
    </>
  );
}

/** The channels a request is filed in here, in the queue's words; Interview requests come only from interviews. */
const CHANNELS = (Object.keys(CHANNEL_LABEL) as Request["channel"][]).filter((c) => c !== "interview");

/**
 * Files a request, as New, through POST /v1/requests: a title, what it is and why, its goals
 * (the queue's Goal filter's list: a goal not confirmed yet shows, but cannot be picked, as the
 * API links confirmed goals only, qa-work-16; a rejected or archived goal is not offered), the channel it came in by (the queue's channels)
 * and the requester (in the In app channel the signed-in member, whom only an owner can change;
 * in another channel whoever asked). On a phone it is a full-height sheet.
 */
function NewRequestDialog({ onClose, onFiled }: { onClose: () => void; onFiled: (request: Request) => void }) {
  const { me, can } = useMe();
  const panel = useRef<HTMLDivElement>(null);
  useFocusTrap(panel, true, onClose);
  const goals = useQuery("new-request-goals", () =>
    unwrap(api.GET("/v1/baseline/entities", { params: { query: { type: "goal" } } })),
  );
  // A rejected (or archived) goal has left the baseline: it is no goal to file a request under.
  const offered = (goals.data ?? []).filter((g) => g.status !== "rejected");
  const myName = me?.email ? displayName(me.email) : "";
  const owner = can("create_request");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [goalIds, setGoalIds] = useState<string[]>([]);
  const [requester, setRequester] = useState(myName);
  const [channel, setChannel] = useState<Request["channel"]>("in_app");
  // In the app the requester is the signed-in member unless an owner names someone; another
  // channel's requester is whoever asked there.
  const named = owner || channel !== "in_app";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return setError("Give the request a title");
    if (!body.trim()) return setError("Say what it is and why");
    setBusy(true);
    setError(null);
    try {
      const request = await unwrap(
        api.POST("/v1/requests", {
          body: {
            title: title.trim(),
            body: body.trim(),
            channel,
            goal_ids: goalIds,
            requester_name: named ? requester.trim() || null : null,
            requester_kind: "unknown",
          },
        }),
      );
      onFiled(request);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const toggle = (id: string, on: boolean) => setGoalIds((ids) => (on ? [...ids, id] : ids.filter((x) => x !== id)));
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-hero/50 px-4 py-10 max-[600px]:p-0">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-request-title"
        tabIndex={-1}
        className="w-full max-w-xl min-w-0 rounded-inspector border border-line bg-surface text-text shadow-tip outline-none max-[600px]:min-h-full max-[600px]:max-w-none max-[600px]:rounded-none max-[600px]:border-0"
      >
        <div className="flex min-h-14 items-center gap-2 border-b border-line px-5 max-[600px]:px-4">
          <h2 id="new-request-title" className="font-display text-xl font-bold tracking-heading">
            New request
          </h2>
        </div>
        <form className="flex flex-col gap-3 px-5 py-4 max-[600px]:px-4" onSubmit={submit} noValidate>
          <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
            Title
            <input data-autofocus className={INPUT} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
            What it is and why
            <textarea className={INPUT} rows={4} value={body} maxLength={4000} onChange={(e) => setBody(e.target.value)} />
          </label>
          <fieldset className="flex flex-col gap-1">
            <legend className="text-sm font-semibold text-text2">Goal (optional)</legend>
            {offered.length === 0 ? (
              <p className="text-sm text-text2">{goals.loading ? "Loading goals…" : "No goals yet"}</p>
            ) : (
              offered.map((g) => {
                const ready = g.status === "confirmed";
                return (
                  <label
                    key={g.id}
                    data-testid="new-request-goal"
                    className={`flex min-h-8 items-center gap-2 text-[15px] ${ready ? "" : "text-text2"}`}
                    title={ready ? undefined : "Confirm this goal in Company first: a request links confirmed goals only"}
                  >
                    <input type="checkbox" disabled={!ready} checked={goalIds.includes(g.id)} onChange={(e) => toggle(g.id, e.target.checked)} />
                    {g.title}
                    {!ready && <span className="text-sm">(not confirmed yet)</span>}
                  </label>
                );
              })
            )}
          </fieldset>
          <div className="grid grid-cols-2 gap-3 max-[600px]:grid-cols-1">
            <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
              Requester
              <input
                className={INPUT}
                value={requester}
                maxLength={200}
                readOnly={!named}
                title={named ? undefined : "Only an owner files a request in someone else's name"}
                onChange={(e) => setRequester(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
              Channel
              <select className={INPUT} value={channel} onChange={(e) => setChannel(e.target.value as Request["channel"])}>
                {CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {CHANNEL_LABEL[c]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {error && <ErrorNote>{error}</ErrorNote>}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={busy}>
              File request
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
