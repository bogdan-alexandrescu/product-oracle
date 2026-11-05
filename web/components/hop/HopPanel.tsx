"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type RefObject } from "react";

import { DiscussionThread } from "@/components/discuss/DiscussionThread";
import { isHidden, type DiscussionRow, type DiscussionSummary } from "@/components/discuss/DiscussionList";
import { Button, Icon, InfoTip, Mark, Notice, SegmentedControl } from "@/components/ds";
import { InlineError, TEXTAREA } from "@/components/review/parts";
import { SimpleAskPanel } from "@/components/simple/chat/SimpleAsk";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { GENERAL, subjectKey, useCurrentScreenSubject, type ScreenSubject } from "@/lib/screen-subject";
import { errorMessage } from "@/lib/use-query";

type View = { kind: "list" } | { kind: "thread"; id: string } | { kind: "share"; id: string };

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

/** Starts a private panel chat on the subject with the person's line; Oracle's reply streams in it. */
async function startChat(subject: ScreenSubject, text: string): Promise<string> {
  const d = await unwrap(
    api.POST("/v1/discussions", {
      body: { subject_kind: subject.kind, subject: subject.subject, origin: "panel", visibility: "private" },
    }),
  );
  await unwrap(api.POST("/v1/discussions/{discussion_id}/messages", { params: { path: { discussion_id: d.id } }, body: { body: text.trim(), mention_oracle: false } }));
  return d.id;
}

/**
 * The first chat on the open subject: a private panel chat, then the message, then Oracle's
 * streamed reply. Simple's box (qa-shell-12): pinned under the chat, Send beside it, Enter
 * sends and Shift+Enter adds a line (qa-shell-15).
 */
function NewChat({ subject, onStarted }: { subject: ScreenSubject; onStarted: (id: string) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const id = await startChat(subject, text);
      setText("");
      onStarted(id);
    } catch (e) {
      setError(errorMessage(e));
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
      <div className="flex items-end gap-2">
        <textarea
          aria-label="Ask Oracle"
          rows={1}
          maxLength={8000}
          placeholder={`Ask about ${subject.label}…`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          className="max-h-40 min-h-10 min-w-0 flex-1 resize-none rounded-[10px] border border-line-strong bg-surface px-3 py-2 text-[15px] leading-[22px] text-text [field-sizing:content] placeholder:text-text-faint"
        />
        <Button type="submit" variant="primary" className="flex-none" disabled={busy || !text.trim()}>
          Send
        </Button>
      </div>
      {error && <InlineError>{error}</InlineError>}
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
      .catch((e) => live && setError(errorMessage(e)));
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
      setError(errorMessage(e));
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
 * the chats here and the reader's Recent chats, a new chat, and a chat's thread with Share
 * as discussion. Panel chats are private: just the reader and Oracle. The thread carries
 * G3's changes card and its actions (Stage, Suggest, Edit, Dismiss…) as anywhere else.
 */
export function HopPanel({ mark, ...props }: { onClose?: () => void; closeLabel?: string; showHeader?: boolean; mark?: boolean }) {
  // ask-fresh: Simple's pages get Simple's own Ask panel (a clean chat each time it opens); Detailed has its own chats in the same layout.
  const pathname = usePathname() ?? "";
  return pathname.startsWith("/simple") ? <SimpleAskPanel {...props} mark={mark} /> : <DetailedPanel {...props} />;
}

function DetailedPanel({ onClose, closeLabel = "Close Ask Oracle", showHeader = true }: { onClose?: () => void; closeLabel?: string; showHeader?: boolean }) {
  const { can } = useMe();
  const page = useCurrentScreenSubject();
  const [general, setGeneral] = useState(false);
  const [view, setView] = useState<View>({ kind: "list" });
  const [tick, setTick] = useState(0);
  const [shared, setShared] = useState(false);
  const [recentOpen, setRecentOpen] = useState(false);
  const subject = general ? GENERAL : page;
  const { here, recent } = useLists(subject, tick);
  const threadId = view.kind === "list" ? null : view.id;
  const d = useDiscussion(threadId, tick);
  const writes = can("create_discussion");
  const isPanelChat = d?.origin === "panel";
  const started = (id: string) => {
    setView({ kind: "thread", id });
    setTick((t) => t + 1);
  };
  const open = (id: string) => {
    setRecentOpen(false);
    setView({ kind: "thread", id });
  };
  const newChat = () => {
    setView({ kind: "list" });
    setShared(false);
    setRecentOpen(false);
    setTick((t) => t + 1);
  };
  const trigger = useRef<HTMLButtonElement>(null);

  // qa-shell-12: Simple's layout (the owner's pick): the head with New chat, the This page |
  // General switch with "Just you and Oracle", "New chat about Home" with Recent chats, the
  // chat, and the box pinned at the bottom with Send beside it.
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-surface text-text" data-testid="hop-panel">
      {showHeader && (
        <div className="flex min-h-14 flex-none items-center gap-2 border-b border-line pr-3 pl-4">
          <Mark size={22} tone="current" className="flex-none text-accent" />
          <h2 className="min-w-0 flex-1 font-display text-lg font-bold tracking-heading">Ask Oracle</h2>
          <Button icon="plus" className="flex-none" data-testid="ask-new-chat" onClick={newChat}>
            New chat
          </Button>
          {onClose && (
            <button type="button" aria-label={closeLabel} onClick={onClose} className="flex size-9 flex-none items-center justify-center rounded-lg text-text hover:bg-surface2">
              <Icon name="x" />
            </button>
          )}
        </div>
      )}
      <div className="flex flex-none flex-wrap items-center gap-2.5 border-b border-line px-4 py-2.5">
        <SegmentedControl
          label="About"
          size="sm"
          value={general ? "general" : "page"}
          onChange={(v) => {
            setGeneral(v === "general");
            newChat();
          }}
          items={[
            { value: "page", label: "This page" },
            { value: "general", label: "General" },
          ]}
        />
        {(view.kind === "list" || isPanelChat) && (
          <p className="ml-auto flex min-w-0 items-center gap-1 text-sm text-text2" data-testid="hop-visibility">
            <Icon name="lock" size={16} />
            Just you and Oracle
            <InfoTip label="Just you and Oracle" align="end" side="bottom">
              Only you can read this chat. Share it as a discussion to bring others in.
            </InfoTip>
          </p>
        )}
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-3">
          {view.kind === "list" && (
            <>
              {/* In a thread its own header names the subject (qa-shell-20): this line is for a new chat. Plain words, never a link to the page you are on (qa-shell-15). */}
              <p className="flex min-w-0 items-center gap-2 text-sm text-text2">
                <span className="min-w-0 truncate" data-testid="hop-about" title={`New chat about ${subject.label}`}>
                  New chat about {subject.label}
                </span>
                <button
                  ref={trigger}
                  type="button"
                  data-testid="ask-recent"
                  aria-expanded={recentOpen}
                  aria-haspopup="true"
                  onClick={() => setRecentOpen((o) => !o)}
                  className="ml-auto inline-flex flex-none items-center gap-0.5 rounded font-semibold whitespace-nowrap text-accent-ink hover:underline"
                >
                  Recent chats
                  <Icon name="chevron-down" size={16} />
                </button>
              </p>
              {!!here?.length && (
                <section aria-label="Here" className="flex flex-col gap-1">
                  <h3 className="text-[13px] font-semibold tracking-wide text-text2 uppercase">Here</h3>
                  <ul className="flex flex-col">{here.map((row) => <ChatRow key={row.id} row={row} onOpen={open} />)}</ul>
                </section>
              )}
              {here !== null && here.length === 0 && (
                <p className="px-2 pt-7 pb-3 text-center text-[15px] text-text2" data-testid="hop-empty">
                  <b className="mb-1 block text-[17px] font-semibold text-text">Nothing yet</b>
                  {writes ? "Ask why something is ranked, what to cut, or what is missing." : "Chats here show for you to read."}
                </p>
              )}
            </>
          )}
          {view.kind === "thread" && (
            <>
              {shared && <Notice testId="hop-shared">Shared as an open discussion</Notice>}
              <DiscussionThread
                key={view.id}
                id={view.id}
                // With the panel's head, its New chat goes back; the phone's sheet has no head of the panel's own.
                {...(showHeader ? {} : { backLabel: "New chat", onBack: newChat })}
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
        {view.kind === "list" && recentOpen && <RecentMenu items={recent} trigger={trigger} onOpen={open} onClose={() => setRecentOpen(false)} />}
      </div>
      {view.kind === "list" && (
        <div className="flex-none border-t border-line px-4 pt-2.5 pb-3.5">
          {writes ? (
            <NewChat subject={subject} onStarted={started} />
          ) : (
            // qa-shell-3: a viewer reads chats but does not start one: said where the box would be.
            <p className="text-sm text-text2" data-testid="hop-cannot">
              You can read chats here, but starting one needs comment access. Ask an owner for it.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Recent chats, the small menu over the chat (as Simple's): the reader's last panel chats by
 * title and what they are about. Escape, a click outside it or the trigger closes it.
 */
function RecentMenu({
  items,
  trigger,
  onOpen,
  onClose,
}: {
  items: DiscussionSummary[] | null;
  trigger: RefObject<HTMLButtonElement | null>;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const menu = useRef<HTMLElement>(null);
  const shut = useRef(onClose);
  useEffect(() => {
    shut.current = onClose;
  });
  useEffect(() => {
    // Escape closes the menu only, not the panel: first, on the window.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      shut.current();
      trigger.current?.focus();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menu.current?.contains(t) || trigger.current?.contains(t)) return;
      shut.current();
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [trigger]);
  return (
    <section
      ref={menu}
      aria-label="Recent chats"
      data-testid="ask-recent-list"
      className="absolute top-[37px] right-3 z-10 flex max-h-[calc(100%-50px)] w-[340px] max-w-[calc(100%-24px)] flex-col overflow-y-auto rounded-xl border border-line bg-surface p-1.5 shadow-tip"
    >
      <h3 className="px-2 py-1.5 text-xs font-semibold tracking-[.06em] text-text2 uppercase">Your recent chats</h3>
      {items !== null && items.length === 0 ? (
        <p className="px-2 py-2 text-[13px] text-text2">No chats yet.</p>
      ) : (
        <ul className="flex flex-col">
          {(items ?? []).map((c) => (
            <li key={c.id}>
              <button
                type="button"
                data-testid="hop-chat-row"
                onClick={() => onOpen(c.id)}
                className="flex w-full flex-col rounded-lg p-2 text-left outline-none hover:bg-surface2 focus:bg-surface2 focus-visible:ring-2 focus-visible:ring-[var(--focus-ring,var(--accent))]"
              >
                <b className="text-[15px] font-semibold text-text [overflow-wrap:anywhere]">{c.title}</b>
                <span className="text-[13px] text-text2 [overflow-wrap:anywhere]">{c.subject_label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
