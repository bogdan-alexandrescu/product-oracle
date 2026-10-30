"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";

import { findPeople, PersonPicker, type Person } from "@/components/PersonPicker";
import { Button, Chip, confirmInPage, CostFigure, Icon, InfoTip, Notice, useFocusTrap } from "@/components/ds";
import { InlineError, Menu, TEXTAREA } from "@/components/review/parts";
import { INPUT, Loading } from "@/components/ui";
import { api, ApiError, unwrap, type Schemas } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { openStream } from "@/lib/stream";
import { invalidateWaiting, waitingChanged } from "@/lib/waiting";
import { errorMessage, useQuery } from "@/lib/use-query";

import { ChangesCard } from "./ChangesCard";
import { type Cite, ReplyBody } from "./cited";
import { plural } from "./DiscussionList";

type Discussion = Schemas["DiscussionOut"];
type Message = Schemas["DiscussionMessageOut"];
type Channel = Schemas["NotificationChannelOut"];
type Counts = { messages: number; people: number };
type Loaded = { kind: "ok"; d: Discussion; messages: Message[] } | { kind: "private" } | { kind: "error"; message: string };

const STARTER_ADDS = "Only the starter can add people to a private discussion";
const SHARE_TO_ADD = "Share this finding at Summary or above to add people";
const VISIBILITY_TIP = { open: "Everyone who can see this can read it", private: "Only the people in it can read it" } as const;
// G8 Slack bridge copy (spec 3.1, 3.4).
const PRIVATE_STAYS = "Private discussions stay in Oracle";
const OWNER_CONNECTS = "An owner connects Oracle to Slack in Settings";
const mirrorConfirm = (channel: string) =>
  `Everything posted in this discussion from now on, Oracle's replies included, will be visible to everyone in #${channel}, including people who are not in Oracle.`;
const privateStopsMirror = (channel: string) =>
  `This discussion is mirrored to #${channel}. Making it private stops the mirror. What was posted stays in Slack.`;

async function load(id: string): Promise<Loaded> {
  try {
    const [d, page] = await Promise.all([
      unwrap(api.GET("/v1/discussions/{discussion_id}", { params: { path: { discussion_id: id } } })),
      unwrap(api.GET("/v1/discussions/{discussion_id}/messages", { params: { path: { discussion_id: id }, query: { limit: 200 } } })),
    ]);
    return { kind: "ok", d, messages: page.items };
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) return { kind: "private" };
    return { kind: "error", message: errorMessage(e) };
  }
}

/** #710: as the API's replies.OFF_HERE; the reply's prompt says the same. */
export const LIVE_OFF = "Live reads are off: others can read this discussion.";

/**
 * Under the composer (#710): what Oracle may read live of the reader's own sources when
 * they ask here, which is only in a private chat that only they are in; with others in it,
 * that live reads are off. Nothing for a reader with no live source (or live reads turned off).
 */
function LiveReadsNotice({ alone }: { alone: boolean }) {
  const sources = useQuery("live-sources", () => unwrap(api.GET("/v1/live/sources")));
  const labels = (sources.data ?? []).map((s) => s.label);
  if (labels.length === 0) return null;
  return (
    <p className="flex items-center gap-1.5 text-[13px] text-text2" data-testid="live-reads-notice">
      <Icon name={alone ? "sources" : "lock"} size={16} />
      {alone ? `Oracle may read live: ${labels.join(", ")}` : LIVE_OFF}
    </p>
  );
}

/** "Make this discussion open? …": the counts the API gave, redrawn when they move (409). */
export function makeOpenWarning(subject: string, c: Counts): string {
  return `Make this discussion open? Everyone who can see ${subject} will read its ${plural(c.messages, "message", "messages")} from ${plural(
    c.people,
    "person",
    "people",
  )}, including what was written while it was private.`;
}

/** A message's text with each "@Name" it mentions drawn as a chip. */
function Body({ m }: { m: Message }) {
  if (m.mentions.length === 0) return <>{m.body}</>;
  const names = [...new Set(m.mentions.map((x) => x.name))].sort((a, b) => b.length - a.length);
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const parts = m.body.split(new RegExp(`(@(?:${escaped.join("|")}))`, "g"));
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith("@") && names.includes(part.slice(1)) ? (
          <span key={i} data-testid="mention-chip" className="rounded-md bg-accent-soft px-1 font-semibold text-accent-ink">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** The Make open warning (G1 "Open later?", owner 2026-10-21), a dialog in the page. */
function MakeOpenWarning({
  text,
  busy,
  error,
  onOpen,
  onKeep,
}: {
  text: string;
  busy: boolean;
  error: string | null;
  onOpen: () => void;
  onKeep: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const title = useId();
  useFocusTrap(ref, true, onKeep);
  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-hero/50 px-4 py-10 max-[600px]:px-2 max-[600px]:py-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onKeep();
      }}
    >
      <div
        ref={ref}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={title}
        tabIndex={-1}
        data-testid="make-open-warning"
        className="w-full max-w-md min-w-0 rounded-inspector border border-line bg-surface text-text shadow-tip outline-none"
      >
        <div className="flex min-h-14 items-center border-b border-line px-5 max-[600px]:px-4">
          <h2 id={title} className="font-display text-lg font-bold tracking-heading">
            Make open
          </h2>
        </div>
        <p className="px-5 py-3.5 text-[15px] leading-6 max-[600px]:px-4">{text}</p>
        {error && (
          <div className="px-5 pb-2 max-[600px]:px-4">
            <InlineError>{error}</InlineError>
          </div>
        )}
        <div className="flex justify-end gap-2 border-t border-line px-5 py-3 max-[600px]:px-4">
          <Button variant="ghost" onClick={onKeep}>
            Keep private
          </Button>
          <Button variant="primary" data-autofocus disabled={busy} onClick={onOpen}>
            Make open
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Oracle's reply (G2): "Oracle is thinking…" while pending, the text growing with a caret
 * while it streams (Stop for the person who asked), citations as chips, an amber "Oracle
 * pushes back" label, and a failed or stopped reply's copy with Retry.
 */
function OracleReply({ m, discussionId, asker, onEnded }: { m: Message; discussionId: string; asker: boolean; onEnded?: () => void }) {
  const [msg, setMsg] = useState<Message>(m);
  const [text, setText] = useState(m.body);
  const [live, setLive] = useState(m.status === "pending" || m.status === "streaming");
  const [error, setError] = useState<string | null>(m.error ?? null);
  const [run, setRun] = useState(0);
  const { can } = useMe();
  // G3: the reply's changes land as it ends; the card under the thread reloads them.
  const ended = useRef(onEnded);
  useEffect(() => {
    ended.current = onEnded;
  });

  useEffect(() => {
    if (!live) return;
    const abort = new AbortController();
    // The stream sends the text from its start: the first piece replaces what was loaded.
    let fresh = true;
    void openStream(`/v1/discussions/${discussionId}/messages/${m.id}/stream`, {
      signal: abort.signal,
      onReset: () => {
        fresh = true;
      },
      onDelta: (t) => {
        const first = fresh;
        fresh = false;
        setText((x) => (first ? "" : x) + t);
        setMsg((x) => (x.status === "pending" ? { ...x, status: "streaming" } : x));
      },
      // Sent as each marker completes, so it shows as a chip while the reply streams.
      onCitations: (cites) => setMsg((x) => ({ ...x, citations: cites as Message["citations"] })),
      onDone: (out) => {
        const done = out as Message;
        setMsg(done);
        setText(done.body);
        setError(null);
        setLive(false);
        ended.current?.();
      },
      onChanges: () => ended.current?.(),
      onError: (e) => {
        if (abort.signal.aborted) return;
        setMsg((x) => ({ ...x, status: "failed", error_reason: e.reason }));
        setError(e.message || "Oracle can't reply right now.");
        setLive(false);
      },
    }).catch(() => setLive(false));
    return () => abort.abort();
  }, [live, run, discussionId, m.id]);

  const stop = async () => {
    try {
      await unwrap(api.POST("/v1/discussions/{discussion_id}/messages/{reply_id}/cancel", { params: { path: { discussion_id: discussionId, reply_id: m.id } } }));
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const retry = async () => {
    try {
      const out = await unwrap(
        api.POST("/v1/discussions/{discussion_id}/messages/{reply_id}/retry", { params: { path: { discussion_id: discussionId, reply_id: m.id } } }),
      );
      setMsg(out);
      setText("");
      setError(null);
      setLive(true);
      setRun((r) => r + 1);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const canRetry = can("retry_discussion_reply", asker);
  const citations = (msg.citations ?? []) as unknown as Cite[];
  const thinking = live && !text;
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="oracle-reply" data-status={msg.status}>
      {msg.pushback && (
        <span data-testid="oracle-pushback">
          <Chip kind="warn">Oracle pushes back</Chip>
        </span>
      )}
      <p className="text-[15px] leading-[22px] break-words whitespace-pre-wrap text-text" data-testid="oracle-reply-text">
        {thinking ? (
          <span className="text-text2 italic">Oracle is thinking…</span>
        ) : live ? (
          <>
            <ReplyBody text={text} citations={citations} live />
            <span aria-hidden className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-text align-middle" data-testid="oracle-caret" />
          </>
        ) : (
          <ReplyBody text={text} citations={citations} />
        )}
      </p>
      {msg.status === "failed" && error && (
        <p className="text-sm text-text2" data-testid="oracle-reply-error">
          {error}
        </p>
      )}
      <span className="flex gap-1">
        {live && asker && (
          <Button variant="ghost" onClick={() => void stop()}>
            Stop
          </Button>
        )}
        {!live && (msg.status === "failed" || msg.status === "cancelled") && canRetry && (
          <Button variant="ghost" onClick={() => void retry()}>
            Retry
          </Button>
        )}
      </span>
    </div>
  );
}

/**
 * Mirror to Slack… (G8): a channel the Oracle app is in, found by search, then the confirm
 * copy naming who will see the discussion from now on; Mirror links it.
 */
function MirrorDialog({ discussionId, onDone, onCancel }: { discussionId: string; onDone: () => void; onCancel: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const title = useId();
  useFocusTrap(ref, true, onCancel);
  const channels = useQuery("slack-channels|mirror", () => unwrap(api.GET("/v1/company-integrations/slack/channels", { params: { query: { mirror: true } } })));
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Channel | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = query.trim().replace(/^#/, "").toLowerCase();
  const shown = (channels.data ?? []).filter((c) => c.name.toLowerCase().includes(q));

  const mirror = async () => {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      await unwrap(api.POST("/v1/discussions/{discussion_id}/slack", { params: { path: { discussion_id: discussionId } }, body: { channel_id: picked.id } }));
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-hero/50 px-4 py-10 max-[600px]:px-2 max-[600px]:py-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title}
        tabIndex={-1}
        data-testid="mirror-to-slack"
        className="w-full max-w-md min-w-0 rounded-inspector border border-line bg-surface text-text shadow-tip outline-none"
      >
        <div className="flex min-h-14 items-center border-b border-line px-5 max-[600px]:px-4">
          <h2 id={title} className="font-display text-lg font-bold tracking-heading">
            Mirror to Slack
          </h2>
        </div>
        {!picked ? (
          <div className="flex min-w-0 flex-col gap-2 px-5 py-3.5 max-[600px]:px-4">
            <input
              type="search"
              aria-label="Find a channel"
              placeholder="Find a channel"
              data-autofocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className={INPUT}
            />
            {channels.error && <InlineError>{channels.error}</InlineError>}
            {channels.loading && !channels.data && <Loading />}
            {channels.data && (
              <ul role="listbox" aria-label="Channels" className="flex max-h-60 min-w-0 flex-col gap-0.5 overflow-y-auto">
                {shown.length === 0 && <li className="px-2 py-1.5 text-sm text-text2">No channel matches</li>}
                {shown.map((c) => (
                  <li key={c.id} className="min-w-0">
                    <button
                      type="button"
                      role="option"
                      aria-selected={false}
                      onClick={() => setPicked(c)}
                      className="flex h-9 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-surface2"
                    >
                      <span className="min-w-0 truncate font-semibold text-text">#{c.name}</span>
                      {c.is_private && <span className="flex-none text-[13px] text-text2">private</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[13px] text-text2">Invite @Product Oracle to a channel to see it here.</p>
          </div>
        ) : (
          <p className="px-5 py-3.5 text-[15px] leading-6 max-[600px]:px-4" data-testid="mirror-confirm">
            {mirrorConfirm(picked.name)}
          </p>
        )}
        {error && (
          <div className="px-5 pb-2 max-[600px]:px-4">
            <InlineError>{error}</InlineError>
          </div>
        )}
        <div className="flex justify-end gap-2 border-t border-line px-5 py-3 max-[600px]:px-4">
          {picked ? (
            <>
              <Button variant="ghost" onClick={() => (setPicked(null), setError(null))}>
                Back
              </Button>
              <Button variant="primary" data-autofocus disabled={busy} onClick={() => void mirror()}>
                Mirror to #{picked.name}
              </Button>
            </>
          ) : (
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

type Draft = { user_id: string; name: string };

/** What a page drives in the composer (B6's quick replies): send a reply, or start an @mention. */
export type ComposerHandle = { send: (text: string) => Promise<void>; mention: () => void };

/**
 * The composer: plain text, "@" opens the member picker (C2's directory; viewers show as
 * "can read"). In a private discussion only the starter brings someone new in: anyone
 * else's mention of an outsider turns amber, says so, and keeps Send disabled until it is
 * removed.
 */
function Composer({
  d,
  messages,
  onSent,
  handle,
  say,
  onSaid,
}: {
  d: Discussion;
  messages: Message[];
  onSent: () => Promise<void>;
  handle?: Ref<ComposerHandle>;
  say?: (text: string, handOff: (text: string) => Promise<void>) => Promise<ReactNode | null>;
  onSaid?: (shown: ReactNode) => void;
}) {
  const { me } = useMe();
  const [text, setText] = useState("");
  // B6 Goals interview's discussions start with "Ask Oracle" on (the entity's interview flag).
  const [askOracle, setAskOracle] = useState(!!(d.subject as { interview?: unknown }).interview);
  const others = new Set([...d.participants.map((p) => p.user_id), ...messages.flatMap((x) => (x.author_kind === "person" && x.author ? [x.author.user_id] : []))]);
  if (me?.user_id) others.delete(me.user_id);
  const solo = others.size === 0;
  const [mentions, setMentions] = useState<Draft[]>([]);
  const [query, setQuery] = useState<string | null>(null);
  const [found, setFound] = useState<Person[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const inIt = new Set(d.participants.map((p) => p.user_id));
  const blockedWhy = d.author_only ? SHARE_TO_ADD : d.visibility === "private" && !d.me.can_manage ? STARTER_ADDS : null;
  const blocked = (m: Draft) => !!blockedWhy && !inIt.has(m.user_id);
  const anyBlocked = mentions.some(blocked);

  useEffect(() => {
    if (query === null) return;
    let live = true;
    findPeople(query)
      .then((rows) => live && setFound(rows))
      .catch(() => live && setFound([]));
    return () => {
      live = false;
    };
  }, [query]);

  const onChange = (value: string, caret: number) => {
    setText(value);
    const token = /(?:^|\s)@([\w.+-]*)$/.exec(value.slice(0, caret));
    setQuery(token ? token[1] : null);
  };
  const pick = (p: Person) => {
    const caret = box.current?.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/@([\w.+-]*)$/, `@${p.name} `);
    setText(before + text.slice(caret));
    setMentions((all) => (all.some((m) => m.user_id === p.user_id) ? all : [...all, { user_id: p.user_id, name: p.name }]));
    setQuery(null);
    box.current?.focus();
  };
  const post = async (body: string, picked: Draft[]) => {
    setSending(true);
    setError(null);
    try {
      await unwrap(
        api.POST("/v1/discussions/{discussion_id}/messages", {
          params: { path: { discussion_id: d.id } },
          body: { body, mention_oracle: askOracle, mentions: picked.filter((m) => body.includes(`@${m.name}`)).map((m) => m.user_id) },
        }),
      );
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setSending(false);
    }
  };
  const send = async () => {
    if (!text.trim() || anyBlocked) return;
    if (say && !mentions.length) {
      setSending(true);
      setError(null);
      try {
        const shown = await say(text.trim(), async (later) => {
          if (await post(later, [])) await onSent();
        });
        if (shown !== null) {
          onSaid?.(shown);
          setText("");
          return;
        }
      } catch (e) {
        setError(errorMessage(e));
        return;
      } finally {
        setSending(false);
      }
    }
    if (!(await post(text.trim(), mentions))) return;
    setText("");
    setMentions([]);
    await onSent();
  };
  useImperativeHandle(handle, () => ({
    send: async (reply: string) => {
      if (await post(reply, [])) await onSent();
    },
    mention: () => {
      const next = text && !/\s$/.test(text) ? `${text} @` : `${text}@`;
      setText(next);
      setQuery("");
      requestAnimationFrame(() => {
        box.current?.focus();
        box.current?.setSelectionRange(next.length, next.length);
      });
    },
  }));

  return (
    <form
      className="relative flex min-w-0 flex-col gap-2"
      data-testid="discussion-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      {query !== null && found.length > 0 && (
        <ul
          role="listbox"
          aria-label="People to mention"
          className="flex max-h-48 min-w-0 flex-col gap-0.5 overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-tip"
        >
          {found.map((p) => (
            <li key={p.user_id} className="min-w-0">
              <button
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => pick(p)}
                className="flex h-9 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-surface2"
              >
                <span className="flex-none font-semibold text-text">{p.name}</span>
                <span className="min-w-0 truncate text-text2">{p.email}</span>
                {!p.can_write && <span className="flex-none text-[13px] text-text2">can read</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={box}
        aria-label="Message"
        rows={3}
        maxLength={8000}
        placeholder={d.visibility === "private" ? "Reply to Oracle" : "Reply to Oracle and the team"}
        value={text}
        onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
          if (e.key === "Escape") setQuery(null);
        }}
        className={TEXTAREA}
      />
      {mentions.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Mentions">
          {mentions.map((m) => (
            <li key={m.user_id} data-testid="draft-mention" data-blocked={blocked(m) ? "true" : "false"}>
              <Chip kind={blocked(m) ? "warn" : "acc"}>
                @{m.name}
                <button
                  type="button"
                  aria-label={`Remove ${m.name}`}
                  className="ml-1 font-bold"
                  onClick={() => {
                    setMentions((all) => all.filter((x) => x.user_id !== m.user_id));
                    setText((t) => t.replace(`@${m.name} `, "").replace(`@${m.name}`, ""));
                  }}
                >
                  ×
                </button>
              </Chip>
            </li>
          ))}
        </ul>
      )}
      {anyBlocked && <p className="text-sm font-medium text-warn">{blockedWhy}</p>}
      {error && <InlineError>{error}</InlineError>}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="solid" disabled={sending || !text.trim() || anyBlocked}>
          Send
        </Button>
        {/* qa-shell-14: just you and Oracle in a private chat, Oracle always replies: no box to tick. */}
        {!(solo && d.visibility === "private") && (
          <label className="inline-flex items-center gap-1.5 text-sm text-text">
            <input type="checkbox" checked={askOracle} onChange={(e) => setAskOracle(e.target.checked)} />
            Ask Oracle
          </label>
        )}
        <span className="text-[13px] text-text2" data-testid="oracle-rule">
          {solo || askOracle ? "Oracle will reply" : "Oracle replies when you @mention it"}
        </span>
      </div>
      <LiveReadsNotice alone={solo && d.visibility === "private"} />
    </form>
  );
}

function MenuItem({ onClick, disabled = false, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className="flex h-9 items-center rounded-lg px-2.5 text-left text-sm font-medium whitespace-nowrap text-text hover:bg-surface2 disabled:cursor-not-allowed disabled:text-text2 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

/**
 * One discussion: its header (title, Open / Private with what it means, its people), the
 * messages, the composer, and a ⋯ menu (Rename; Make private; Make open; People; Summary;
 * Share summary with everyone; Mirror to Slack… or Stop mirroring; Close or Reopen; Follow
 * or Leave), each as the reader may. A mirrored discussion shows its Slack chip (G8).
 * `onBack` draws "← All feedback" (or `backLabel`).
 */
export function DiscussionThread({
  id,
  onBack,
  backLabel = "All feedback",
  onChanged,
  refreshKey = 0,
  belowHeader,
  renderAfter,
  composer,
  focusChanges = false,
  inlineKinds,
  say,
}: {
  id: string;
  onBack?: () => void;
  backLabel?: string;
  /** Something about it changed (a message, its visibility): lists showing it reload. */
  onChanged?: () => void;
  /** A change made elsewhere (a version proposed or accepted): bumping it reloads the thread. */
  refreshKey?: number;
  /** Under the header (B6: the missing-field chips). */
  belowHeader?: ReactNode;
  /** Under a message (B6: Oracle's version cards and quick replies). */
  renderAfter?: (m: Message, ctx: { d: Discussion; messages: Message[] }) => ReactNode;
  /** The composer's handle (B6's quick replies send and mention through it). */
  composer?: Ref<ComposerHandle>;
  /** Opened from the Inbox's Review changes (G6): scroll to the changes card. */
  focusChanges?: boolean;
  /** Kinds the caller shows under messages (B6: goal versions); the changes card leaves them out. */
  inlineKinds?: string[];
  /**
   * The composer's line goes here first (Simple's one Ask box: S9's plan reader); what it
   * returns shows in the thread after the last message, and null posts the line as usual.
   */
  say?: (text: string, handOff: (text: string) => Promise<void>) => Promise<ReactNode | null>;
}) {
  const { me, can } = useMe();
  const myId = me?.user_id ?? null;
  const [state, setState] = useState<Loaded | null>(null);
  const [showPeople, setShowPeople] = useState(false);
  const [editing, setEditing] = useState<"title" | "summary" | null>(null);
  const [draft, setDraft] = useState("");
  const [warning, setWarning] = useState<Counts | null>(null);
  // The People list's own refusal (#710's 409 live_reads_in_chat), shown where the person was picked.
  const [peopleError, setPeopleError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // G3: bumped when a reply ends, so the changes card reloads.
  const [changesKey, setChangesKey] = useState(0);
  const [mirroring, setMirroring] = useState(false);
  // What `say` showed, each after the message that was last when it was said.
  const [said, setSaid] = useState<{ after: string | null; node: ReactNode }[]>([]);
  const router = useRouter();
  // G8: the starter or an approver may mirror an open discussion; they need the install's state.
  // A G7 panel chat never is (Share as discussion opens it), so it shows no Slack at all.
  const shownD = state?.kind === "ok" ? state.d : null;
  const mayMirror = !!shownD && shownD.status === "open" && shownD.origin !== "panel" && can("mirror_discussion_to_slack", shownD.me.can_manage);
  const slackStatus = useQuery(mayMirror ? "slack-status" : "slack-status|none", () =>
    mayMirror ? unwrap(api.GET("/v1/company-integrations/slack/status")) : Promise.resolve(null),
  );

  const reload = async () => {
    const next = await load(id);
    setState(next);
    return next;
  };
  useEffect(() => {
    let live = true;
    load(id).then((s) => live && setState(s));
    return () => {
      live = false;
    };
  }, [id, refreshKey]);
  // G2 §4: while a research run is under way, look again now and then for its answer.
  const researching = state?.kind === "ok" && state.messages.some((x) => x.research?.status === "running");
  useEffect(() => {
    if (!researching) return;
    // Backs off from 10 s to a minute, and stops after RESEARCH_POLLS looks (a reload looks again).
    let polls = 0;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      if (polls >= RESEARCH_POLLS) return;
      timer = setTimeout(() => {
        polls += 1;
        void load(id).then(setState);
        next();
      }, Math.min(RESEARCH_POLL_MS * 2 ** polls, RESEARCH_POLL_MAX_MS));
    };
    next();
    return () => clearTimeout(timer);
  }, [researching, id]);
  // Reading the thread marks it read to its last message: the Inbox's invitation and
  // mentions read past are done (G6), and the rail's count reads again.
  const lastId = state?.kind === "ok" ? state.messages.at(-1)?.id : undefined;
  const readTo = useRef<string | null>(null);
  useEffect(() => {
    if (!lastId || readTo.current === lastId) return;
    readTo.current = lastId;
    void api
      .POST("/v1/discussions/{discussion_id}/read", { params: { path: { discussion_id: id } }, body: { message_id: lastId } })
      .then(({ response }) => {
        if (!response.ok) return;
        invalidateWaiting();
        waitingChanged();
      });
  }, [id, lastId]);

  const back = onBack && (
    <Button variant="ghost" icon="chevron-left" onClick={onBack} aria-label={backLabel}>
      {backLabel}
    </Button>
  );
  if (!state) return <Loading />;
  if (state.kind !== "ok") {
    return (
      <div className="flex flex-col gap-3" data-testid="discussion-thread-unavailable">
        {back && <div>{back}</div>}
        {state.kind === "private" ? (
          <Notice testId="discussion-private">
            <span className="inline-flex items-center gap-1.5">
              <Icon name="lock" size={16} />
              This discussion is private
            </span>
          </Notice>
        ) : (
          <Notice tone="error">{state.message}</Notice>
        )}
      </div>
    );
  }
  const { d, messages } = state;
  // Said before any message, or after one no longer listed: at the top.
  const saidAfter = (id: string | null) =>
    said.flatMap((x, i) =>
      x.after === id || (id === null && x.after !== null && !messages.some((m) => m.id === x.after))
        ? [
            <li key={`said-${i}`} className="min-w-0">
              {x.node}
            </li>,
          ]
        : [],
    );
  const open = d.status === "open";
  const priv = d.visibility === "private";
  const starter = d.me.can_manage;
  // #370: the starter or an approver closes it. PATCH /v1/discussions is open to every reader
  // and its capability does not mark the approver check, so the approvers' decision on feedback
  // (PATCH /v1/feedback, approver) stands for it.
  const canClose = starter || can("update_feedback");
  const canMakeOpen = starter && priv && d.origin !== "panel" && !d.author_only;

  const patch = async (body: Omit<Schemas["DiscussionPatch"], "lock_version">) => {
    setBusy(true);
    setError(null);
    try {
      await unwrap(
        api.PATCH("/v1/discussions/{discussion_id}", { params: { path: { discussion_id: d.id } }, body: { ...body, lock_version: d.lock_version } }),
      );
      await reload();
      onChanged?.();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      await reload();
      return false;
    } finally {
      setBusy(false);
    }
  };

  const makeOpen = async (counts: Counts) => {
    setBusy(true);
    setError(null);
    const { response, error: body } = await api.PATCH("/v1/discussions/{discussion_id}", {
      params: { path: { discussion_id: d.id } },
      body: { visibility: "open", exposes: counts, lock_version: d.lock_version },
    });
    setBusy(false);
    if (response.ok) {
      setWarning(null);
      await reload();
      onChanged?.();
      return;
    }
    const conflict = body as Partial<Schemas["DiscussionExposureConflict"]> | undefined;
    if (response.status === 409 && typeof conflict?.messages === "number" && typeof conflict.people === "number") {
      // Someone wrote since the warning was drawn: draw it again with what it exposes now.
      setWarning({ messages: conflict.messages, people: conflict.people });
      await reload();
      return;
    }
    setError(typeof (body as { detail?: unknown })?.detail === "string" ? (body as { detail: string }).detail : "Could not make it open");
    await reload();
  };

  const makePrivate = async () => {
    const n = d.participants.length;
    const yes = await confirmInPage({
      action: "Make private",
      message: `${d.slack ? `${privateStopsMirror(d.slack.channel_name)} ` : ""}Make private? The ${plural(n, "person", "people")} in it keep${
        n === 1 ? "s" : ""
      } reading it. Everyone else will see only that a private discussion exists.`,
    });
    if (yes) await patch({ visibility: "private" });
  };

  const leave = async () => {
    if (!myId) return;
    setBusy(true);
    try {
      await unwrap(
        api.DELETE("/v1/discussions/{discussion_id}/participants/{user_id}", { params: { path: { discussion_id: d.id, user_id: myId } } }),
      );
      const next = await reload();
      onChanged?.();
      if (next.kind !== "ok") onBack?.();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const follow = async () => {
    if (!myId) return;
    try {
      await unwrap(api.POST("/v1/discussions/{discussion_id}/participants", { params: { path: { discussion_id: d.id } }, body: { user_ids: [myId] } }));
      await reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const people = async (op: "add" | "remove", userId: string) => {
    setError(null);
    setPeopleError(null);
    try {
      if (op === "add")
        await unwrap(
          api.POST("/v1/discussions/{discussion_id}/participants", { params: { path: { discussion_id: d.id } }, body: { user_ids: [userId] } }),
        );
      else
        await unwrap(
          api.DELETE("/v1/discussions/{discussion_id}/participants/{user_id}", { params: { path: { discussion_id: d.id, user_id: userId } } }),
        );
      await reload();
    } catch (e) {
      setPeopleError(errorMessage(e));
    }
  };

  const remove = async (m: Message) => {
    const yes = await confirmInPage({ action: "Delete message", message: "Delete this message? It will read “Message deleted”.", destructive: true });
    if (!yes) return;
    try {
      await unwrap(
        api.DELETE("/v1/discussions/{discussion_id}/messages/{message_id}", { params: { path: { discussion_id: d.id, message_id: m.id } } }),
      );
      await reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const stopMirroring = async () => {
    if (!d.slack) return;
    const yes = await confirmInPage({
      action: "Stop mirroring",
      message:
        // No thread yet (or a failed mirror): nothing was posted, and no closing line goes.
        !d.slack.thread_url
          ? `Stop mirroring to #${d.slack.channel_name}? Nothing was posted in Slack.`
          : `Stop mirroring to #${d.slack.channel_name}? Oracle posts a closing line in the Slack thread. What was posted stays in Slack.`,
    });
    if (!yes) return;
    setError(null);
    try {
      await unwrap(api.DELETE("/v1/discussions/{discussion_id}/slack", { params: { path: { discussion_id: d.id } } }));
      await reload();
      onChanged?.();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const items: { label: string; run: () => void; disabled?: boolean; tip?: string }[] = [];
  if (open && starter) items.push({ label: "Rename", run: () => (setDraft(d.title), setEditing("title")) });
  if (open && starter && !priv) items.push({ label: "Make private", run: () => void makePrivate() });
  if (open && canMakeOpen) items.push({ label: "Make open", run: () => setWarning(d.exposure ?? { messages: d.message_count, people: 0 }) });
  if (starter && priv) items.push({ label: "People", run: () => setShowPeople(true) });
  if (open && starter) items.push({ label: d.summary ? "Edit summary" : "Write summary", run: () => (setDraft(d.summary ?? ""), setEditing("summary")) });
  if (open && starter && priv && d.summary)
    items.push(
      d.summary_shared
        ? { label: "Stop sharing summary", run: () => void patch({ summary_shared: false }) }
        : { label: "Share summary with everyone", run: () => void patch({ summary_shared: true }) },
    );
  // G8 Mirror to Slack: never for a private discussion (an info tip says why instead).
  const slack = slackStatus.data ?? null;
  const owner = can("install_slack_notifications");
  let slackTip: string | null = null;
  if (mayMirror && slack) {
    if (d.slack) items.push({ label: "Stop mirroring", run: () => void stopMirroring() });
    else if (priv) slackTip = PRIVATE_STAYS;
    else if (slack.mirroring) items.push({ label: "Mirror to Slack…", run: () => setMirroring(true) });
    else if (owner)
      items.push({ label: slack.needs_reconnect ? "Reconnect Slack…" : "Connect Oracle to Slack…", run: () => router.push("/settings/notifications") });
    else items.push({ label: "Mirror to Slack", run: () => undefined, disabled: true, tip: OWNER_CONNECTS });
  }
  if (canClose) items.push({ label: open ? "Close" : "Reopen", run: () => void patch({ status: open ? "closed" : "open" }) });
  if (myId && !d.me.participant && !priv && open) items.push({ label: "Follow", run: () => void follow() });
  if (myId && d.me.participant && !(priv && starter)) items.push({ label: priv ? "Leave" : "Unfollow", run: () => void leave() });

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="discussion-thread" data-discussion-id={d.id}>
      {back && <div>{back}</div>}
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 items-start gap-2">
          <h3 className="min-w-0 flex-1 font-display text-[17px] leading-6 font-bold tracking-heading break-words">{d.title}</h3>
          {(items.length > 0 || slackTip) && (
            <Menu label="Discussion actions" icon="more" iconOnly>
              {(close) => (
                <span className="flex min-w-44 flex-col gap-0.5">
                  <span role="menu" aria-label="Discussion actions" className="flex flex-col gap-0.5">
                    {items.map((it) =>
                      it.tip ? (
                        <span key={it.label} className="flex items-center gap-1.5" title={it.tip}>
                          <MenuItem disabled={it.disabled} onClick={() => undefined}>
                            {it.label}
                          </MenuItem>
                          <InfoTip label={it.label} side="bottom">
                            {it.tip}
                          </InfoTip>
                        </span>
                      ) : (
                        <MenuItem
                          key={it.label}
                          disabled={it.disabled}
                          onClick={() => {
                            close();
                            it.run();
                          }}
                        >
                          {it.label}
                        </MenuItem>
                      ),
                    )}
                  </span>
                  {slackTip && (
                    <span className="flex h-9 items-center gap-1.5 px-2.5 text-sm text-text2" data-testid="slack-private-tip">
                      Slack
                      <InfoTip label="Slack" side="bottom">
                        {slackTip}
                      </InfoTip>
                    </span>
                  )}
                </span>
              )}
            </Menu>
          )}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[13px] text-text2">
          <span title={VISIBILITY_TIP[d.visibility]} data-testid="discussion-visibility" className="inline-flex">
            <Chip kind={priv ? "warn" : "line"}>{priv ? "Private" : "Open"}</Chip>
          </span>
          <button
            type="button"
            data-testid="discussion-people"
            aria-expanded={showPeople}
            onClick={() => setShowPeople((s) => !s)}
            className="rounded-full border border-line-strong px-2 py-0.5 text-[13px] font-medium text-text hover:bg-surface2"
          >
            {plural(d.participants.length, "person", "people")}
          </button>
          {!open && <Chip kind="na">Closed</Chip>}
          {d.slack &&
            (d.slack.thread_url ? (
              <a href={d.slack.thread_url} target="_blank" rel="noreferrer" data-testid="discussion-slack" title="Open the Slack thread" className="inline-flex">
                <Chip kind="acc">#{d.slack.channel_name}</Chip>
              </a>
            ) : (
              <span data-testid="discussion-slack" title={d.slack.status === "failed" ? "Slack mirror failed" : "Mirrored to Slack"} className="inline-flex">
                <Chip kind="acc">#{d.slack.channel_name}</Chip>
              </span>
            ))}
          {/* Named once: no line under the title when it repeats the title. */}
          {d.subject_label.trim().toLowerCase() !== d.title.trim().toLowerCase() && (
            <span className="min-w-0 truncate">{d.subject_label}</span>
          )}
        </div>
        {belowHeader}
      </div>

      {editing && (
        <form
          className="flex flex-col gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await patch(editing === "title" ? { title: draft.trim() } : { summary: draft.trim() });
            if (ok) setEditing(null);
          }}
        >
          <textarea
            aria-label={editing === "title" ? "Title" : "Summary"}
            rows={editing === "title" ? 1 : 3}
            maxLength={editing === "title" ? 200 : 1200}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className={TEXTAREA}
          />
          <div className="flex gap-2">
            <Button type="submit" variant="solid" disabled={busy || (editing === "title" && !draft.trim())}>
              Save
            </Button>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {showPeople && (
        <div className="flex flex-col gap-2 rounded-lg border border-line p-3" data-testid="discussion-people-list">
          <ul className="flex flex-col gap-1">
            {d.participants.map((p) => (
              <li key={p.user_id} className="flex min-w-0 items-center gap-2 text-sm">
                <span className="min-w-0 truncate font-semibold">{p.name}</span>
                <span className="text-text2">{p.can_write ? p.role : "can read"}</span>
                {starter && priv && p.user_id !== d.started_by.user_id && open && (
                  <Button variant="ghost" className="ml-auto" onClick={() => void people("remove", p.user_id)} aria-label={`Remove ${p.name}`}>
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {starter && priv && open && !d.author_only && (
            <PersonPicker writersOnly={false} exclude={d.participants.map((p) => p.user_id)} onPick={(p) => void people("add", p.user_id)} />
          )}
          {peopleError && <InlineError>{peopleError}</InlineError>}
        </div>
      )}

      {d.slack?.status === "failing" && d.started_by.user_id === myId && (
        <Notice tone="warn" testId="slack-failing">
          Slack mirror failing: {d.slack.error ?? "Slack did not take the last post"}
        </Notice>
      )}
      {d.slack?.status === "failed" && d.started_by.user_id === myId && (
        <Notice tone="warn" testId="slack-failed">
          Slack mirror failed: {d.slack.error ?? "Slack did not take the first post"}. Stop mirroring to mirror it again.
        </Notice>
      )}

      {error && <InlineError>{error}</InlineError>}

      <ol className="flex min-w-0 flex-col gap-3" aria-label="Messages">
        {messages.length === 0 && !said.length && <li className="text-sm text-text2">No messages yet</li>}
        {saidAfter(null)}
        {messages.flatMap((m) => [

          m.author_kind === "system" && m.research ? (
            <ResearchLine key={m.id} m={m} />
          ) : m.author_kind === "system" ? (
            <li key={m.id} data-testid="discussion-system-line" className="text-center text-[13px] text-text2">
              {m.body}
            </li>
          ) : (
            <li key={m.id} data-testid="discussion-message" data-author-kind={m.author_kind} className="min-w-0">
              <p className="flex flex-wrap items-baseline gap-x-2 text-[13px] text-text2">
                <span className="font-semibold text-text">{m.author?.name ?? "Oracle"}</span>
                <span className="tnum">{formatDateTime(m.created_at)}</span>
                {m.edited_at && !m.deleted && <span>edited</span>}
                {m.via === "slack" && (
                  <span data-testid="via-slack" className="text-[12px]">
                    via Slack
                  </span>
                )}
                {m.author_kind === "oracle" && m.research && (
                  <span data-testid="research-answer">
                    <Chip>From research</Chip>
                  </span>
                )}
              </p>
              {m.author_kind === "oracle" && !m.deleted ? (
                <OracleReply
                  m={m}
                  discussionId={d.id}
                  asker={!!myId && messages.some((x) => x.id === m.reply_to && x.author?.user_id === myId)}
                  onEnded={() => setChangesKey((k) => k + 1)}
                />
              ) : (
                <p className="text-[15px] leading-[22px] break-words whitespace-pre-wrap text-text">
                  {m.deleted ? <span className="text-text2 italic">Message deleted</span> : <Body m={m} />}
                </p>
              )}
              {!m.deleted && open && d.me.can_write && m.author_kind === "person" && m.author?.user_id && (
                <OwnMessageActions m={m} discussionId={d.id} onDelete={() => void remove(m)} onSaved={() => void reload()} />
              )}
              {!m.deleted &&
                open &&
                m.author_kind === "person" &&
                can("research_discussion_message", d.me.can_research) &&
                !messages.some((x) => x.reply_to === m.id && x.research?.status === "running") && (
                  <ResearchThis m={m} d={d} onStarted={() => void reload().then(() => onChanged?.())} />
                )}
              {renderAfter?.(m, { d, messages })}
            </li>
          ),
          saidAfter(m.id),
        ])}
      </ol>

      {d.me.private_findings && (
        <Notice testId="private-findings-notice">
          {d.me.private_findings.count} of your private findings bear on this. Share them to let Oracle use them here.{" "}
          <a className="font-semibold text-accent-ink hover:underline" href={`/intakes/${d.me.private_findings.intake_id}`}>
            Review sharing
          </a>
        </Notice>
      )}

      {!open ? (
        <p className="text-sm text-text2">This discussion is closed.</p>
      ) : d.me.can_write ? (
        <Composer
          d={d}
          messages={messages}
          handle={composer}
          say={say}
          onSaid={(node) => setSaid((all) => [...all, { after: messages.at(-1)?.id ?? null, node }])}
          onSent={async () => {
            await reload();
            onChanged?.();
          }}
        />
      ) : null}

      <ChangesCard
        d={d}
        refreshKey={changesKey + refreshKey}
        focus={focusChanges}
        leaveOut={inlineKinds}
        onThreadChanged={() => void reload().then(() => onChanged?.())}
      />

      {mirroring && (
        <MirrorDialog
          discussionId={d.id}
          onCancel={() => setMirroring(false)}
          onDone={() => {
            setMirroring(false);
            void reload();
            onChanged?.();
          }}
        />
      )}

      {warning && (
        <MakeOpenWarning
          text={makeOpenWarning(d.subject_label, warning)}
          busy={busy}
          error={error}
          onOpen={() => void makeOpen(warning)}
          onKeep={() => {
            setWarning(null);
            setError(null);
          }}
        />
      )}
    </div>
  );
}

/** How often the thread looks for a research run's answer while it runs: first after 10 s, doubling to a minute, at most 30 looks. */
const RESEARCH_POLL_MS = 10_000;
const RESEARCH_POLL_MAX_MS = 60_000;
const RESEARCH_POLLS = 30;

/**
 * Research this (G2 §4) under a person's message, for an approver or owner who can write in
 * the discussion: the run's estimated cost first, then Start research. Oracle's answer comes
 * back into the thread when the run ends.
 */
function ResearchThis({ m, d, onStarted }: { m: Message; d: Discussion; onStarted: () => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const begin = async () => {
    setBusy(true);
    setError(null);
    try {
      await unwrap(api.POST("/v1/discussions/{discussion_id}/research", { params: { path: { discussion_id: d.id } }, body: { message_id: m.id } }));
      setAsking(false);
      onStarted();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  if (!asking)
    return (
      <span className="mt-1 flex gap-1">
        <Button variant="ghost" onClick={() => setAsking(true)}>
          Research this
        </Button>
      </span>
    );
  return (
    <div className="mt-1 flex flex-col gap-2 rounded-button border border-line bg-surface p-3" role="group" aria-label="Research this" data-testid="research-confirm">
      <p className="text-sm text-text">
        One research run · <CostFigure usd={d.me.research_usd} est />
      </p>
      <p className="text-sm text-text2">Oracle posts what it finds here, with its sources.</p>
      {error && <InlineError>{error}</InlineError>}
      <span className="flex gap-2">
        <Button variant="solid" disabled={busy} onClick={() => void begin()}>
          Start research
        </Button>
        <Button variant="ghost" onClick={() => setAsking(false)}>
          Cancel
        </Button>
      </span>
    </div>
  );
}

/** The line a research run leaves in the thread: who asked, where it stands, and its run. */
function ResearchLine({ m }: { m: Message }) {
  const r = m.research!;
  const where =
    r.status === "running"
      ? "Oracle is researching…"
      : r.status === "done"
        ? "Research done"
        : r.error
          ? `Research didn't start: ${r.error} Research this to try again.`
          : "Research didn't finish. Research this to try again.";
  return (
    <li data-testid="research-line" data-status={r.status} className="text-center text-[13px] text-text2">
      {m.body} · {where} ·{" "}
      <a className="font-semibold text-accent-ink hover:underline" href={`/runs/${r.run_id}`}>
        See the run
      </a>
    </li>
  );
}

/** Edit and Delete on the reader's own message. */
function OwnMessageActions({
  m,
  discussionId,
  onDelete,
  onSaved,
}: {
  m: Message;
  discussionId: string;
  onDelete: () => void;
  onSaved: () => void;
}) {
  const { me } = useMe();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(m.body);
  const [error, setError] = useState<string | null>(null);
  if (!me || me.user_id !== m.author?.user_id) return null;
  if (!editing)
    return (
      <span className="mt-1 flex gap-1">
        <Button variant="ghost" onClick={() => setEditing(true)} aria-label="Edit message">
          Edit
        </Button>
        <Button variant="ghost" onClick={onDelete} aria-label="Delete message">
          Delete
        </Button>
      </span>
    );
  return (
    <form
      className="mt-1 flex flex-col gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await unwrap(
            api.PATCH("/v1/discussions/{discussion_id}/messages/{message_id}", {
              params: { path: { discussion_id: discussionId, message_id: m.id } },
              body: { body: text },
            }),
          );
          setEditing(false);
          onSaved();
        } catch (err) {
          setError(errorMessage(err));
        }
      }}
    >
      <textarea aria-label="Edit message" rows={2} maxLength={8000} value={text} onChange={(e) => setText(e.target.value)} className={TEXTAREA} />
      {error && <InlineError>{error}</InlineError>}
      <span className="flex gap-2">
        <Button type="submit" variant="solid" disabled={!text.trim()}>
          Save
        </Button>
        <Button variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </span>
    </form>
  );
}
