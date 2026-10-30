"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useRef, useState } from "react";

import { Button, Dialog } from "@/components/ds";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { formatAge } from "@/lib/format";
import { displayName } from "@/lib/names";
import { errorMessage, useQuery } from "@/lib/use-query";

import { CHANNEL_LABEL, STATE } from "./RequestList";

type Request = Schemas["RequestOut"];

/**
 * New request (#329): the button on the Requests header and in its empty state. #370: a role
 * that cannot file a request (a viewer) is not shown it. The header's opens at once at
 * ?compose=request (where /requests/new leads); closing it drops that from the address.
 */
export function NewRequestButton({
  onFiled,
  variant = "primary",
  className,
  fromAddress = false,
}: {
  onFiled: (request: Request) => void;
  /** Opens at once when the address asks for a new request (?compose=request). */
  fromAddress?: boolean;
  /** The header's is the page's primary action; the empty state's is secondary. */
  variant?: "primary" | "secondary";
  className?: string;
}) {
  const { can } = useMe();
  const router = useRouter();
  const pathname = usePathname();
  const asked = useSearchParams().get("compose") === "request";
  const [open, setOpen] = useState(() => fromAddress && asked);
  const close = () => {
    setOpen(false);
    if (fromAddress && asked) router.replace(pathname);
  };
  // create_request's handler wants an owner only to name someone else as the requester.
  if (!can("create_request", true)) return null;
  return (
    <>
      <Button variant={variant} icon="plus" className={className} onClick={() => setOpen(true)}>
        New request
      </Button>
      {open && (
        <NewRequestDialog
          onClose={close}
          onFiled={(request) => {
            close();
            onFiled(request);
          }}
          onOpenExisting={(id) => {
            setOpen(false);
            router.push(`/requests?request=${encodeURIComponent(id)}`);
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
 * in another channel whoever asked). The ds Dialog: typed words ask before they are thrown away.
 */
/** Two titles that read the same: case, spaces and end punctuation aside (qa-work-37). */
const titleWords = (t: string) => t.replace(/[\s]+/g, " ").trim().replace(/[.!?]+$/, "").trim();
const sameTitle = (a: string, b: string) => titleWords(a).toLowerCase() === titleWords(b).toLowerCase();

/** "just now", "5m ago". */
function filedAgo(at: string): string {
  const age = formatAge(at);
  return !age || age === "now" || age.startsWith("in ") ? "just now" : `${age} ago`;
}

/**
 * qa-work-37: before filing, a request already in the queue under the same title (not merged
 * away) is shown, with Open it (to merge or add to it there) or File anyway.
 */
function NewRequestDialog({
  onClose,
  onFiled,
  onOpenExisting,
}: {
  onClose: () => void;
  onFiled: (request: Request) => void;
  /** Opens a request already filed under this title, instead of filing a second. */
  onOpenExisting: (id: string) => void;
}) {
  const { me, can } = useMe();
  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
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
  /** rirs-34: a missing title or body is said under its field, which takes focus. */
  const [missing, setMissing] = useState<"title" | "body" | null>(null);
  // qa-onboarding-1: typed words ask "Discard your changes?" before Escape, the X or Cancel throws them away.
  const [renamed, setRenamed] = useState(false);
  const dirty = !!title.trim() || !!body.trim() || goalIds.length > 0 || channel !== "in_app" || renamed;
  /** The request already filed under this title, once asked; the title it was found for. */
  const [twin, setTwin] = useState<{ request: Request; title: string } | null>(null);

  async function submit() {
    if (!title.trim()) {
      setMissing("title");
      titleRef.current?.focus();
      return;
    }
    if (!body.trim()) {
      setMissing("body");
      bodyRef.current?.focus();
      return;
    }
    setMissing(null);
    setBusy(true);
    setError(null);
    try {
      // Asked once per title: File anyway files it.
      if (!twin || !sameTitle(twin.title, title)) {
        const found = await unwrap(api.GET("/v1/requests", { params: { query: { q: titleWords(title), limit: 50 } } }));
        const same = found.items.find((r) => r.state !== "merged" && sameTitle(r.title, title));
        if (same) {
          setTwin({ request: same, title });
          return;
        }
      }
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
  const fieldNote = (id: string, text: string) => (
    <span id={id} data-testid={id} className="text-sm font-medium text-crit">
      {text}
    </span>
  );
  return (
    <Dialog
      title="New request"
      testId="new-request-dialog"
      onClose={onClose}
      dirty={dirty}
      askOnCancel
      phoneSheet
      busy={busy}
      onSubmit={() => void submit()}
      actions={
        <Button variant="primary" type="submit" disabled={busy}>
          {twin && sameTitle(twin.title, title) ? "File anyway" : "File request"}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
            Title
            <input
              ref={titleRef}
              data-autofocus
              className={`${INPUT} aria-invalid:border-crit`}
              value={title}
              maxLength={200}
              aria-invalid={missing === "title" || undefined}
              aria-describedby={missing === "title" ? "new-request-title-note" : undefined}
              onChange={(e) => {
                setTitle(e.target.value);
                if (missing === "title") setMissing(null);
              }}
            />
          </label>
          {missing === "title" && fieldNote("new-request-title-note", "Give the request a title")}
        </div>
        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
            What it is and why
            <textarea
              ref={bodyRef}
              className={`${INPUT} aria-invalid:border-crit`}
              rows={4}
              value={body}
              maxLength={4000}
              aria-invalid={missing === "body" || undefined}
              aria-describedby={missing === "body" ? "new-request-body-note" : undefined}
              onChange={(e) => {
                setBody(e.target.value);
                if (missing === "body") setMissing(null);
              }}
            />
          </label>
          {missing === "body" && fieldNote("new-request-body-note", "Say what it is and why")}
        </div>
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
              onChange={(e) => {
                setRequester(e.target.value);
                setRenamed(true);
              }}
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
        {twin && sameTitle(twin.title, title) && (
          <div role="alert" data-testid="new-request-duplicate" className="flex flex-col gap-2 rounded-panel border border-warn bg-warn-bg px-3 py-2.5 text-sm text-text">
            <span>
              <span className="font-semibold">This looks like a request already filed: </span>
              &ldquo;{twin.request.title}&rdquo; ({STATE[twin.request.state].label}, filed {filedAgo(twin.request.created_at)}
              {twin.request.requester_name ? ` by ${twin.request.requester_name}` : ""}). Open it to add to it or merge into it, or file this one anyway.
            </span>
            <span>
              <Button variant="secondary" className="max-[600px]:h-11" onClick={() => onOpenExisting(twin.request.id)}>
                Open it
              </Button>
            </span>
          </div>
        )}
        {error && <ErrorNote>{error}</ErrorNote>}
      </div>
    </Dialog>
  );
}
