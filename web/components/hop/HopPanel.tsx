"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { DiscussionThread } from "@/components/discuss/DiscussionThread";
import { isHidden, type DiscussionRow, type DiscussionSummary } from "@/components/discuss/DiscussionList";
import { Button, Icon, InfoTip, Mark, Notice, SegmentedControl } from "@/components/ds";
import { InlineError, TEXTAREA } from "@/components/review/parts";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { GENERAL, subjectKey, useCurrentScreenSubject, type ScreenSubject } from "@/lib/screen-subject";
import { errorMessage } from "@/lib/use-query";

type View = { kind: "list" } | { kind: "thread"; id: string } | { kind: "share"; id: string };

const detail = (e: unknown) => errorMessage(e).replace(/ \(\d{3}\)$/, "");

/** Chats on this subject ("Here") and the reader's own panel chats ("Recent", the last 10). */
function useLists(subject: ScreenSubject, tick: number) {
  const [here, setHere] = useState<DiscussionRow[] | null>(null);
  const [recent, setRecent] = useState<DiscussionSummary[] | null>(null);
  const key = subjectKey(subject);
  const runId = subject.kind === "checkpoint" ? String(subject.subject.run_id) : null;
  useEffect(() => {
    let live = true;
    Promise.all([
      key || runId
        ? unwrap(api.GET("/v1/discussions", { params: { query: key ? { subject_key: key } : { run_id: runId! } } })).then((p) => p.items)
        : Promise.resolve([]),
      unwrap(api.GET("/v1/discussions", { params: { query: { mine: true, origin: "panel", limit: 10 } } })).then((p) =>
        p.items.filter((x): x is DiscussionSummary => !isHidden(x)),
      ),
    ])
      .then(([h, r]) => {
        if (!live) return;
        setHere(h);
        setRecent(r);
      })
      .catch(() => {
        if (!live) return;
        setHere([]);
        setRecent([]);
      });
    return () => {
      live = false;
    };
  }, [key, runId, tick]);
  return { here, recent };
}

function ChatRow({ row, onOpen }: { row: DiscussionRow; onOpen: (id: string) => void }) {
  if (isHidden(row))
    return (
      <li className="flex min-h-10 items-center gap-2 px-2 text-[15px] text-text2" data-testid="hop-hidden-row">
        <Icon name="lock" size={16} />
        Private discussion
      </li>
    );
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(row.id)}
        data-testid="hop-chat-row"
        className="flex min-h-10 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-[15px] text-text hover:bg-surface2"
      >
        {row.visibility === "private" && <Icon name="lock" size={16} />}
        <span className="min-w-0 flex-1 truncate font-medium">{row.title}</span>
        <span className="flex-none text-[13px] text-text2 tnum">{row.message_count}</span>
      </button>
    </li>
  );
}

/** The first chat on the open subject: a private panel chat, then the message, then Oracle's streamed reply. */
function NewChat({ subject, onStarted }: { subject: ScreenSubject; onStarted: (id: string) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const d = await unwrap(
        api.POST("/v1/discussions", {
          body: { subject_kind: subject.kind, subject: subject.subject, origin: "panel", visibility: "private" },
        }),
      );
      await unwrap(api.POST("/v1/discussions/{discussion_id}/messages", { params: { path: { discussion_id: d.id } }, body: { body: text.trim(), mention_oracle: false } }));
      setText("");
      onStarted(d.id);
    } catch (e) {
      setError(detail(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex flex-col gap-2"
      data-testid="hop-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <textarea
        aria-label="Ask Oracle"
        rows={3}
        maxLength={8000}
        placeholder={`Ask about ${subject.label}…`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
        }}
        className={TEXTAREA}
      />
      {error && <InlineError>{error}</InlineError>}
      <div>
        <Button type="submit" variant="solid" disabled={busy || !text.trim()}>
          Send
        </Button>
      </div>
    </form>
  );
}

/** Share as discussion (G7 3.1): the chat's summary, edited, opens an open discussion on the same subject. */
function ShareForm({ id, onShared, onCancel }: { id: string; onShared: (id: string) => void; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all([
      unwrap(api.GET("/v1/discussions/{discussion_id}", { params: { path: { discussion_id: id } } })),
      unwrap(api.GET("/v1/discussions/{discussion_id}/messages", { params: { path: { discussion_id: id }, query: { limit: 200 } } })),
    ])
      .then(([d, page]) => {
        if (!live) return;
        const lastReply = [...page.items].reverse().find((m) => m.author_kind === "oracle" && m.body && !m.deleted);
        setTitle(d.title);
        setText(d.summary ?? lastReply?.body ?? "");
      })
      .catch((e) => live && setError(detail(e)));
    return () => {
      live = false;
    };
  }, [id]);
  const post = async () => {
    if (!text?.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const d = await unwrap(
        api.POST("/v1/discussions/{discussion_id}/share", { params: { path: { discussion_id: id } }, body: { title: title.trim() || null, first_message: text.trim() } }),
      );
      onShared(d.id);
    } catch (e) {
      setError(detail(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex flex-col gap-2"
      data-testid="hop-share-form"
      onSubmit={(e) => {
        e.preventDefault();
        void post();
      }}
    >
      <h3 className="font-display text-[17px] font-bold">Share as discussion</h3>
      <label className="flex flex-col gap-1 text-sm font-semibold">
        Title
        <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} className={`${TEXTAREA} h-10`} />
      </label>
      <label className="flex flex-col gap-1 text-sm font-semibold">
        First message
        <textarea rows={5} maxLength={8000} value={text ?? ""} disabled={text === null} onChange={(e) => setText(e.target.value)} className={TEXTAREA} />
      </label>
      {error && <InlineError>{error}</InlineError>}
      <div className="flex gap-2">
        <Button type="submit" variant="solid" disabled={busy || !text?.trim()}>
          Post
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The thread's own subject and starter, for the header's About chip and Share as discussion. */
function useDiscussion(id: string | null, tick: number) {
  const [d, setD] = useState<Schemas["DiscussionOut"] | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    unwrap(api.GET("/v1/discussions/{discussion_id}", { params: { path: { discussion_id: id } } }))
      .then((x) => live && setD(x))
      .catch(() => live && setD(null));
    return () => {
      live = false;
    };
  }, [id, tick]);
  return id && d?.id === id ? d : null;
}

/**
 * The head-of-product panel (G7): "Ask Oracle", what it is about (this page or General),
 * the chats here and the reader's recent ones, a new chat, and a chat's thread with Share
 * as discussion. Panel chats are private: just the reader and Oracle. The thread carries
 * G3's changes card and its actions (Stage, Suggest, Edit, Dismiss…) as anywhere else.
 */
export function HopPanel({ onClose, closeLabel = "Close Ask Oracle", showHeader = true }: { onClose?: () => void; closeLabel?: string; showHeader?: boolean }) {
  const { can } = useMe();
  const page = useCurrentScreenSubject();
  const [general, setGeneral] = useState(false);
  const [view, setView] = useState<View>({ kind: "list" });
  const [tick, setTick] = useState(0);
  const [shared, setShared] = useState(false);
  const subject = general ? GENERAL : page;
  const { here, recent } = useLists(subject, tick);
  const threadId = view.kind === "list" ? null : view.id;
  const d = useDiscussion(threadId, tick);
  const writes = can("create_discussion");
  const isPanelChat = d?.origin === "panel";

  const about = d ? { label: d.subject_label, url: d.subject_url } : { label: subject.label, url: subject.kind === "screen" ? String(subject.subject.path) : null };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-surface text-text" data-testid="hop-panel">
      {showHeader && (
        <div className="flex min-h-14 flex-none items-center gap-2 border-b border-line px-4">
          <Mark size={22} tone="current" className="flex-none text-accent" />
          <h2 className="min-w-0 flex-1 font-display text-lg font-bold tracking-heading">Ask Oracle</h2>
          {onClose && (
            <button type="button" aria-label={closeLabel} onClick={onClose} className="flex size-9 items-center justify-center rounded-lg text-text hover:bg-surface2">
              <Icon name="x" />
            </button>
          )}
        </div>
      )}
      <div className="flex flex-none flex-col gap-2 border-b border-line px-4 py-3">
        <p className="flex min-w-0 items-center gap-1.5 text-[15px]" data-testid="hop-about">
          <span className="min-w-0 truncate rounded-full bg-accent-soft px-2.5 py-0.5 font-semibold text-accent-ink">
            {about.url ? (
              <Link href={about.url} className="hover:underline">
                About: {about.label}
              </Link>
            ) : (
              <>About: {about.label}</>
            )}
          </span>
        </p>
        {view.kind === "list" && (
          <SegmentedControl
            label="About"
            size="sm"
            value={general ? "general" : "page"}
            onChange={(v) => setGeneral(v === "general")}
            items={[
              { value: "page", label: "This page" },
              { value: "general", label: "General" },
            ]}
          />
        )}
        {(view.kind === "list" || isPanelChat) && (
          <p className="flex items-center gap-1 text-[15px] text-text" data-testid="hop-visibility">
            <Icon name="lock" size={16} />
            Just you and Oracle
            <InfoTip label="Just you and Oracle" align="start" side="bottom">
              Only you can read this chat. Share it as a discussion to bring others in.
            </InfoTip>
          </p>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-3">
        {view.kind === "list" && (
          <>
            {writes ? (
              <NewChat
                subject={subject}
                onStarted={(id) => {
                  setView({ kind: "thread", id });
                  setTick((t) => t + 1);
                }}
              />
            ) : null}
            {here !== null && here.length === 0 && recent !== null && recent.length === 0 && (
              <p className="text-[15px] text-text2" data-testid="hop-empty">
                Ask why something is ranked, what to cut, or what is missing.
              </p>
            )}
            {!!here?.length && (
              <section aria-label="Here" className="flex flex-col gap-1">
                <h3 className="text-[13px] font-semibold tracking-wide text-text2 uppercase">Here</h3>
                <ul className="flex flex-col">{here.map((row) => <ChatRow key={row.id} row={row} onOpen={(id) => setView({ kind: "thread", id })} />)}</ul>
              </section>
            )}
            {!!recent?.length && (
              <section aria-label="Recent" className="flex flex-col gap-1">
                <h3 className="text-[13px] font-semibold tracking-wide text-text2 uppercase">Recent</h3>
                <ul className="flex flex-col">{recent.map((row) => <ChatRow key={row.id} row={row} onOpen={(id) => setView({ kind: "thread", id })} />)}</ul>
              </section>
            )}
          </>
        )}
        {view.kind === "thread" && (
          <>
            {shared && <Notice testId="hop-shared">Shared as an open discussion</Notice>}
            <DiscussionThread
              key={view.id}
              id={view.id}
              backLabel="New chat"
              onBack={() => {
                setView({ kind: "list" });
                setShared(false);
                setTick((t) => t + 1);
              }}
              onChanged={() => setTick((t) => t + 1)}
            />
            {isPanelChat && d.me.can_manage && writes && (
              <div>
                <Button variant="ghost" icon="comment" onClick={() => setView({ kind: "share", id: view.id })}>
                  Share as discussion
                </Button>
              </div>
            )}
          </>
        )}
        {view.kind === "share" && (
          <ShareForm
            id={view.id}
            onCancel={() => setView({ kind: "thread", id: view.id })}
            onShared={(id) => {
              setShared(true);
              setView({ kind: "thread", id });
              setTick((t) => t + 1);
            }}
          />
        )}
      </div>
    </div>
  );
}
