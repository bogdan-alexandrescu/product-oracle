"use client";

import { useEffect, useState, type FormEvent } from "react";

import { Button, Chip, type ChipKind } from "@/components/ds";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { calendarDay, todayIn, useCompanyZone } from "@/lib/dates";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import { CHANNEL_LABEL } from "./RequestList";

type Request = Schemas["RequestOut"];
type Reply = Schemas["ReplyOut"];
type SentChannel = NonNullable<Reply["channel"]>;

const STATUS: Record<Reply["status"], { label: string; kind: ChipKind }> = {
  drafted: { label: "Drafted", kind: "warn" },
  sent: { label: "Sent", kind: "pass" },
  notified: { label: "Told in Oracle", kind: "pass" },
  skipped: { label: "Skipped", kind: "na" },
  withdrawn: { label: "Withdrawn", kind: "na" },
};
const SENT_CHANNEL: Record<SentChannel, string> = { email: "Email", slack: "Slack", call: "Call", in_app: "In the app", other: "Other" };
const LABEL = "flex flex-col gap-1 text-sm font-semibold text-text2";
/** How often the panel asks again while Oracle drafts. */
const POLL_MS = 1_000;

/**
 * The Why not panel (H10): one reply per person who asked for a request said no to, with the
 * name as given, how they asked, the state and the draft. Approvers and owners, and the member
 * who filed the request, edit, copy, mark sent, skip, Tell them in Oracle (member askers) and
 * draft again with Oracle; everyone else reads it with no buttons (#370). While Oracle's job
 * drafts, the panel reads "Drafting the replies…" and asks again until it ends. After a
 * Reopen, approvers may Tell the people who asked (those already sent or told). Every action
 * hands the request, read again, to `onRequest` (its counts and Loop closed).
 */
export function WhyNot({ request, onRequest }: { request: Request; onRequest: (request: Request) => void }) {
  const { me, can } = useMe();
  const zone = useCompanyZone();
  const mine = !!me?.user_id && request.filed_by === me.user_id;
  const canAct = can("update_request_reply", mine);
  const canDraft = can("draft_request_replies", mine);
  const canTell = can("tell_reopened");
  const path = { params: { path: { request_id: request.id } } };
  const list = useQuery(`request-replies:${request.id}:${request.lock_version}`, () => unwrap(api.GET("/v1/requests/{request_id}/replies", path)), {
    keepPrevious: true,
  });
  const replies = list.data ?? [];
  const drafting = replies.some((r) => r.drafting);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { reload } = list;

  useEffect(() => {
    if (!drafting) return;
    const t = setTimeout(reload, POLL_MS);
    return () => clearTimeout(t);
  }, [drafting, list.data, reload]);

  async function act(call: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await call();
      onRequest(await unwrap(api.GET("/v1/requests/{request_id}", path)));
      list.reload();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const live = request.state === "disqualified";
  const told = replies.some((r) => r.kind === "no" && (r.status === "sent" || r.status === "notified"));
  const reopenedSent = replies.some((r) => r.kind === "reopened");
  const open = replies.filter((r) => r.status === "drafted");
  return (
    <div data-testid="why-not" className="flex min-w-0 flex-col gap-3 text-[15px]">
      {request.loop_closed_on && (
        <p data-testid="loop-closed" className="font-semibold text-pass">
          Loop closed · {calendarDay(request.loop_closed_on)}
        </p>
      )}
      {drafting && <p className="text-sm text-text2">Drafting the replies…</p>}
      {list.error && <ErrorNote>{list.error}</ErrorNote>}
      {list.data && replies.length === 0 && <p className="text-sm text-text2">No replies</p>}
      <ul className="flex min-w-0 flex-col gap-3">
        {replies.map((r) => (
          <ReplyRow key={`${r.id}:${r.lock_version}`} reply={r} canAct={canAct && r.status === "drafted"} busy={busy} today={todayIn(zone)} act={act} />
        ))}
      </ul>
      {(canDraft && live && open.length > 0) || (canTell && !live && told && !reopenedSent) ? (
        <div className="flex flex-wrap gap-2">
          {canDraft && live && open.length > 0 && (
            <Button disabled={busy || drafting} onClick={() => act(() => unwrap(api.POST("/v1/requests/{request_id}/replies/draft", path)))}>
              Draft again with Oracle
            </Button>
          )}
          {canTell && !live && told && !reopenedSent && (
            <Button disabled={busy} onClick={() => act(() => unwrap(api.POST("/v1/requests/{request_id}/replies/reopened", path)))}>
              Tell the people who asked
            </Button>
          )}
        </div>
      ) : null}
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}

type Mode = null | "edit" | "sent" | "skip";

function ReplyRow({
  reply,
  canAct,
  busy,
  today,
  act,
}: {
  reply: Reply;
  canAct: boolean;
  busy: boolean;
  today: string;
  act: (call: () => Promise<unknown>) => Promise<boolean>;
}) {
  const [mode, setMode] = useState<Mode>(null);
  const [body, setBody] = useState(reply.body ?? "");
  const [channel, setChannel] = useState<SentChannel>("email");
  const [day, setDay] = useState(today);
  const [why, setWhy] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const path = { params: { path: { reply_id: reply.id } } };
  const submit = (call: () => Promise<unknown>) => async (e: FormEvent) => {
    e.preventDefault();
    if (await act(call)) setMode(null);
  };
  const status = STATUS[reply.status];
  const done =
    reply.status === "sent"
      ? `Sent · ${reply.channel ? SENT_CHANNEL[reply.channel] : ""}${reply.sent_on ? ` · ${calendarDay(reply.sent_on)}` : ""}${reply.sent_by_name ? ` · by ${reply.sent_by_name}` : ""}`
      : reply.status === "skipped"
        ? `Skipped · ${reply.skip_reason ?? ""}`
        : null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(reply.body ?? "");
      setCopied("Copied");
    } catch {
      setCopied("Could not copy; select the text instead");
    }
  };

  return (
    <li data-testid="reply" className="flex min-w-0 flex-col gap-2 rounded-lg border border-line p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 break-words font-semibold">{reply.asker}</span>
        {reply.channel_asked && <Chip kind="line">{CHANNEL_LABEL[reply.channel_asked]}</Chip>}
        <Chip kind={status.kind}>{status.label}</Chip>
        {reply.kind === "reopened" && <Chip kind="line">Looking again</Chip>}
        {reply.draft_source === "template" && <Chip kind="line">Template</Chip>}
      </div>
      {reply.asked && <p className="min-w-0 break-words text-sm text-text2">Asked: {reply.asked}</p>}
      {mode === "edit" ? (
        <form className="flex flex-col gap-2" onSubmit={submit(() => unwrap(api.PATCH("/v1/request-replies/{reply_id}", { ...path, body: { lock_version: reply.lock_version, body } })))}>
          <label className={LABEL}>
            Reply to {reply.asker}
            <textarea className={INPUT} rows={5} value={body} maxLength={2000} onChange={(e) => setBody(e.target.value)} />
          </label>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
            <Button variant="solid" type="submit" disabled={busy}>
              Save
            </Button>
          </div>
        </form>
      ) : reply.body ? (
        <p className="min-w-0 whitespace-pre-wrap break-words">{reply.body}</p>
      ) : (
        !reply.drafting && <p className="text-sm text-text2">{canAct ? "Write a reply" : "No reply written yet"}</p>
      )}
      {reply.warnings.includes("sounds_like_a_promise") && (
        <p data-testid="promise-warning" className="text-sm font-semibold text-warn">
          Sounds like a promise
        </p>
      )}
      {done && <p className="min-w-0 break-words text-sm text-text2">{done}</p>}
      {mode === "sent" && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={submit(() => unwrap(api.POST("/v1/request-replies/{reply_id}/sent", { ...path, body: { channel, sent_on: day || null } })))}
        >
          <label className={`${LABEL} min-w-0 flex-1 basis-32`}>
            Channel
            <select className={INPUT} value={channel} onChange={(e) => setChannel(e.target.value as SentChannel)}>
              {(Object.keys(SENT_CHANNEL) as SentChannel[]).map((c) => (
                <option key={c} value={c}>
                  {SENT_CHANNEL[c]}
                </option>
              ))}
            </select>
          </label>
          <label className={`${LABEL} min-w-0 flex-1 basis-32`}>
            Day
            <input type="date" className={INPUT} value={day} max={today} onChange={(e) => setDay(e.target.value)} />
          </label>
          <Button variant="ghost" onClick={() => setMode(null)}>
            Cancel
          </Button>
          <Button variant="solid" type="submit" disabled={busy}>
            Save as sent
          </Button>
        </form>
      )}
      {mode === "skip" && (
        <form className="flex flex-wrap items-end gap-2" onSubmit={submit(() => unwrap(api.POST("/v1/request-replies/{reply_id}/skip", { ...path, body: { reason: why.trim() } })))}>
          <label className={`${LABEL} min-w-0 flex-1 basis-48`}>
            Why skip it
            <input className={INPUT} value={why} maxLength={500} placeholder="Asked anonymously" onChange={(e) => setWhy(e.target.value)} />
          </label>
          <Button variant="ghost" onClick={() => setMode(null)}>
            Cancel
          </Button>
          <Button variant="solid" type="submit" disabled={busy || !why.trim()}>
            Skip reply
          </Button>
        </form>
      )}
      {canAct && mode === null && (
        // Phone: the actions wrap under the draft, Copy and Mark sent first.
        <div className="flex flex-wrap items-center gap-2">
          {reply.body && <Button onClick={copy}>Copy</Button>}
          <Button disabled={busy} onClick={() => setMode("sent")}>
            Mark sent
          </Button>
          {reply.member_id && (
            <Button disabled={busy || !reply.body} onClick={() => act(() => unwrap(api.POST("/v1/request-replies/{reply_id}/notify", path)))}>
              Tell them in Oracle
            </Button>
          )}
          <Button
            variant="ghost"
            disabled={busy || reply.drafting}
            onClick={() => {
              setBody(reply.body ?? "");
              setMode("edit");
            }}
          >
            {reply.body ? "Edit" : "Write a reply"}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setMode("skip")}>
            Skip
          </Button>
          {copied && (
            <span role="status" className="text-sm text-text2">
              {copied}
            </span>
          )}
        </div>
      )}
    </li>
  );
}
