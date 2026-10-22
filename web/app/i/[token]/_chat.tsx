"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";

import { LIMITS, publicCall, type PublicInterview, type PublicMessage, type PublicProgress, type PublicTurn } from "@/lib/api/interviews";

type Refusal = "used" | "expired" | "withdrawn" | "unreachable";
type Phase = { at: "loading" } | { at: "intro" } | { at: "chat" } | { at: "done" } | { at: "refused"; why: Refusal };

const BUTTON =
  "inline-flex h-11 items-center justify-center rounded-button px-4 text-[15px] font-semibold whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-60";
const PRIMARY = `${BUTTON} bg-accent text-on-accent hover:brightness-110`;
const QUIET = `${BUTTON} border border-line-strong bg-surface text-text hover:bg-surface2`;

/** The refusal of a public call's status and reason (404 reads as expired: a guess learns nothing). */
function refusalOf(status: number, reason: string | null): Refusal | null {
  if (status === 404) return "expired";
  if (status !== 410) return null;
  return reason === "used" || reason === "withdrawn" ? reason : "expired";
}

/**
 * The customer's side of an interview: the company's name and the disclosure, Hi and the
 * intro, Start; then the conversation, one approved question at a time, with Skip this question
 * and Send my answers (finish) at any time; then the thank-you. A used, expired or withdrawn
 * link shows a one-line page. Phone first: the input is a sticky footer.
 */
export function InterviewChat({ token }: { token: string }) {
  const [phase, setPhase] = useState<Phase>({ at: "loading" });
  const [info, setInfo] = useState<PublicInterview | null>(null);
  const [messages, setMessages] = useState<PublicMessage[]>([]);
  const [progress, setProgress] = useState<PublicProgress>({ asked: 0, total: 0 });
  const [text, setText] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let live = true;
    publicCall<PublicInterview>("GET", token).then((res) => {
      if (!live) return;
      if (res.data) {
        setInfo(res.data);
        setMessages(res.data.messages);
        setProgress(res.data.progress);
        // Back on the page mid-interview: straight to the conversation.
        setPhase({ at: res.data.messages.some((m) => m.role === "customer") ? "chat" : "intro" });
        return;
      }
      setPhase({ at: "refused", why: refusalOf(res.status, res.reason) ?? "unreachable" });
    });
    return () => {
      live = false;
    };
  }, [token]);

  useEffect(() => {
    if (phase.at === "chat") end.current?.scrollIntoView({ block: "end" });
  }, [messages, waiting, phase.at]);

  /** A refused or failed turn: a refusal page, "Please wait a moment", or the API's reason. */
  function failed(res: { status: number; reason: string | null; detail: string | null }) {
    const why = refusalOf(res.status, res.reason);
    if (why) return setPhase({ at: "refused", why });
    if (res.status === 429) return setNote("Please wait a moment, then send again.");
    if (res.status === 422) return setNote(res.detail ?? "Write your answer first.");
    setNote("That did not go through. Check your connection and try again.");
  }

  async function turn(action: "messages" | "skip", body?: string) {
    setNote(null);
    setWaiting(true);
    const before = messages;
    if (body) setMessages([...before, { role: "customer", body, at: new Date().toISOString() }]);
    const res = await publicCall<PublicTurn>("POST", token, action, body === undefined ? undefined : { body });
    setWaiting(false);
    if (!res.data) {
      setMessages(before);
      if (body) setText(body);
      return failed(res);
    }
    const turnOut = res.data;
    // Our own message is already on screen: the turn's first message echoes it.
    setMessages([...before, ...turnOut.messages]);
    setProgress(turnOut.progress);
    if (turnOut.done) setPhase({ at: "done" });
    else input.current?.focus();
  }

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const body = text.trim();
    if (!body || waiting) return;
    setText("");
    await turn("messages", body);
  }

  async function finish() {
    setNote(null);
    setWaiting(true);
    const res = await publicCall<{ done: boolean }>("POST", token, "finish");
    setWaiting(false);
    if (res.data?.done) return setPhase({ at: "done" });
    failed(res);
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
  }

  const company = info?.company ?? null;

  if (phase.at === "loading") {
    return (
      <Frame company={null}>
        <p role="status" className="py-8 text-center text-[15px] text-text2">
          Loading…
        </p>
      </Frame>
    );
  }
  if (phase.at === "refused") {
    const line =
      phase.why === "used"
        ? `This link has already been used. ${company ? `Ask ${company} for a new one.` : "Ask the team that sent it for a new one."}`
        : phase.why === "withdrawn"
          ? "This link was withdrawn."
          : phase.why === "expired"
            ? "This link has expired."
            : "We could not open this link. Check your connection and reload the page.";
    return (
      <Frame company={company}>
        <p data-testid="interview-refused" className="py-10 text-center text-lg font-semibold">
          {line}
        </p>
      </Frame>
    );
  }
  if (phase.at === "done") {
    return (
      <Frame company={company}>
        <p data-testid="interview-thanks" className="py-10 text-center text-lg font-semibold">
          {`Thank you. Your answers went to ${company}'s product team.`}
        </p>
      </Frame>
    );
  }

  const disclosure = (
    <p data-testid="interview-disclosure" className="rounded-panel bg-accent-soft px-4 py-3 text-[15px] text-accent-ink">
      {`You're talking with an AI assistant working for ${company}'s product team. What you write goes to that team.`}
    </p>
  );

  if (phase.at === "intro") {
    return (
      <Frame company={company}>
        <div className="flex flex-col gap-4 py-6">
          {disclosure}
          <h2 className="font-display text-2xl font-bold tracking-heading">Hi {info?.interviewee_name}</h2>
          {info?.intro && <p className="text-[17px] leading-7">{info.intro}</p>}
          <div>
            <button type="button" className={PRIMARY} onClick={() => setPhase({ at: "chat" })}>
              Start
            </button>
          </div>
        </div>
      </Frame>
    );
  }

  return (
    <Frame
      company={company}
      footer={
        <form onSubmit={send} className="flex flex-col gap-2" aria-label="Your answer">
          {note && (
            <p role="status" data-testid="interview-note" className="rounded-button bg-warn-bg px-3 py-2 text-sm font-medium text-warn">
              {note}
            </p>
          )}
          <div className="flex items-end gap-2">
            <label className="min-w-0 flex-1">
              <span className="sr-only">Your answer</span>
              <textarea
                ref={input}
                data-testid="interview-input"
                rows={2}
                value={text}
                maxLength={LIMITS.message}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKey}
                placeholder="Type your answer"
                className="block max-h-40 min-h-11 w-full resize-y rounded-lg border border-line-strong bg-surface px-3 py-2 text-[16px] text-text"
              />
            </label>
            <button type="submit" className={PRIMARY} disabled={waiting || !text.trim()}>
              Send
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span data-testid="interview-progress" className="tnum text-sm font-semibold text-text2">
              {progress.asked} of {progress.total}
            </span>
            {text.length > LIMITS.message - 200 && (
              <span className="tnum text-sm text-text2">
                {text.length} / {LIMITS.message}
              </span>
            )}
            <span className="flex-1" />
            <button type="button" className={QUIET} disabled={waiting} onClick={() => turn("skip")}>
              Skip this question
            </button>
            <button type="button" className={QUIET} disabled={waiting} onClick={finish}>
              Send my answers
            </button>
          </div>
        </form>
      }
    >
      <div className="flex flex-col gap-3 py-4">
        {disclosure}
        <ol aria-label="Conversation" className="flex flex-col gap-3">
          {messages.map((m, i) => (
            <li
              key={`${m.at}-${i}`}
              data-testid={m.role === "oracle" ? "msg-oracle" : "msg-customer"}
              className={`flex max-w-[85%] min-w-0 flex-col gap-0.5 ${m.role === "customer" ? "self-end items-end" : "self-start"}`}
            >
              <span className="text-[13px] font-semibold text-text2">{m.role === "oracle" ? "Assistant" : "You"}</span>
              <p
                data-testid="msg-body"
                className={`rounded-panel px-3.5 py-2.5 text-[16px] leading-6 break-words whitespace-pre-wrap ${
                  m.role === "customer" ? "bg-accent text-on-accent" : "border border-line bg-surface text-text"
                }`}
              >
                {m.body}
              </p>
            </li>
          ))}
        </ol>
        {waiting && (
          <p role="status" data-testid="interview-typing" className="self-start text-sm text-text2">
            <span aria-hidden className="mr-1 inline-flex gap-1 align-middle">
              {[0, 1, 2].map((d) => (
                <span key={d} className="size-1.5 animate-pulse rounded-full bg-current" style={{ animationDelay: `${d * 150}ms` }} />
              ))}
            </span>
            The assistant is typing…
          </p>
        )}
        <div ref={end} />
      </div>
    </Frame>
  );
}

/** The page frame: the company's name on top, the content, and an optional sticky footer. */
function Frame({ company, footer, children }: { company: string | null; footer?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh min-w-0 flex-col bg-bg text-text">
      <header className="border-b border-line bg-surface px-4 py-3">
        <h1 data-testid="interview-company" className="mx-auto max-w-2xl truncate font-display text-xl font-bold tracking-heading">
          {company ?? "Interview"}
        </h1>
      </header>
      <div className="mx-auto w-full max-w-2xl min-w-0 flex-1 px-4">{children}</div>
      {footer && (
        <div
          data-testid="interview-footer"
          className="sticky bottom-0 border-t border-line bg-surface px-4 pt-3 pb-[calc(12px+env(safe-area-inset-bottom))]"
        >
          <div className="mx-auto w-full max-w-2xl min-w-0">{footer}</div>
        </div>
      )}
    </div>
  );
}
