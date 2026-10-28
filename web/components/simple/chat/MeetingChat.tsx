"use client";

import { useCallback, useEffect, useState } from "react";

import { api, unwrap, type Schemas } from "@/lib/api/client";
import { meetingSay, meetingThread, setChatMode, type ChangeMode, type ChatRules, type ChatThread } from "@/lib/api/simple-chat";
import { errorMessage } from "@/lib/use-query";

import { ChatThreadView, usePendingPoll } from "./ChatThread";

const POLL_MS = 2000;
const MODE_WORDS: Record<ChangeMode, string> = { everyone: "Everyone", presenter: "Only the presenter", named: "Presenter + named people" };
const detail = (e: unknown) => errorMessage(e).replace(/ \(\d{3}\)$/, "");

function rulesLine(r: ChatRules): string {
  if (r.change_mode === "named") return `Presenter + ${r.change_people.length ? r.change_people.map((p) => p.name).join(", ") : "no one named yet"}`;
  return MODE_WORDS[r.change_mode];
}

/**
 * A meeting's shared change-by-chat thread (Simple S9): every attendee's lines and Oracle's
 * cards, polled so each tab sees the others; the rules line (who may apply) and, for the
 * presenter, the control that changes it. Viewers ask questions only.
 */
export function MeetingChat({ meetingId, sessionId }: { meetingId: string; sessionId: string }) {
  const [thread, setThread] = useState<ChatThread | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setThread(await meetingThread(meetingId));
      setError(null);
    } catch (e) {
      setError(detail(e));
    }
  }, [meetingId]);
  // Polled, so every attendee's tab sees the others' lines and cards.
  useEffect(() => {
    let live = true;
    let timer = 0;
    const tick = () => {
      meetingThread(meetingId)
        .then((t) => {
          if (!live) return;
          setThread(t);
          setError(null);
        })
        .catch((e) => live && setError(detail(e)))
        .finally(() => {
          if (live) timer = window.setTimeout(tick, POLL_MS);
        });
    };
    tick();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [meetingId]);

  // chat-reader: a line Oracle's reader is reading is read again sooner than the shared poll.
  usePendingPoll(thread, load);

  const rules = thread?.rules ?? null;
  return (
    <section aria-label="Meeting chat" data-testid="meeting-chat" data-session={sessionId || undefined} className="simple-card flex min-h-0 flex-col gap-3 max-[600px]:mb-[76px]">
      <h2 className="simple-h2">Meeting chat</h2>
      {error && !thread && (
        <p role="alert" className="simple-small text-crit">
          {error}
        </p>
      )}
      {rules && (
        <div className="flex flex-col gap-2 border-b border-line pb-3">
          <p className="simple-small" data-testid="chat-rules">
            Who may apply: <strong>{rulesLine(rules)}</strong>
            {rules.ended && " · The meeting has ended"}
          </p>
          {rules.is_presenter && !rules.ended && <ModeControl meetingId={meetingId} rules={rules} onSaved={(r) => setThread((t) => (t ? { ...t, rules: r } : t))} />}
        </div>
      )}
      {thread && (
        <ChatThreadView
          testId="meeting-chat-thread"
          thread={thread}
          placeholder={rules?.ask_only ? "Ask a question about the plan…" : "Ask a question or ask for a change…"}
          hint={rules?.ask_only ? "You can ask questions here; viewers don't change the plan." : undefined}
          send={async (text) => setThread(await meetingSay(meetingId, text))}
          onCardChanged={() => void load()}
          onThread={setThread}
        />
      )}
    </section>
  );
}

/** The presenter's control: who may apply (everyone, only the presenter, or the presenter and up to two people). */
function ModeControl({ meetingId, rules, onSaved }: { meetingId: string; rules: ChatRules; onSaved: (r: ChatRules) => void }) {
  const [mode, setMode] = useState<ChangeMode>(rules.change_mode);
  const [named, setNamed] = useState<string[]>(rules.change_people.map((p) => p.id));
  const [people, setPeople] = useState<Schemas["PersonOut"][]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (mode !== "named" || people.length) return;
    unwrap(api.GET("/v1/people", { params: { query: {} } }))
      .then((rows) => setPeople(rows.filter((p) => p.user_id !== rules.presenter.id)))
      .catch(() => setPeople([]));
  }, [mode, people.length, rules.presenter.id]);

  const save = async (m: ChangeMode, ids: string[]) => {
    setError(null);
    try {
      onSaved(await setChatMode(meetingId, m, m === "named" ? ids : []));
    } catch (e) {
      setError(detail(e));
    }
  };

  return (
    <div className="flex flex-col gap-2" data-testid="chat-mode">
      <label className="simple-small flex flex-wrap items-center gap-2">
        Change who may apply
        <select
          aria-label="Who may apply"
          value={mode}
          onChange={(e) => {
            const m = e.target.value as ChangeMode;
            setMode(m);
            if (m !== "named" || named.length) void save(m, named);
          }}
          className="h-10 rounded-lg border border-line-strong bg-surface px-2 text-text"
        >
          {(Object.keys(MODE_WORDS) as ChangeMode[]).map((m) => (
            <option key={m} value={m}>
              {MODE_WORDS[m]}
            </option>
          ))}
        </select>
      </label>
      {mode === "named" && (
        <fieldset className="flex flex-wrap gap-3">
          <legend className="simple-small">Name up to two people</legend>
          {people.map((p) => {
            const on = named.includes(p.user_id);
            return (
              <label key={p.user_id} className="simple-small flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!on && named.length >= 2}
                  onChange={() => {
                    const ids = on ? named.filter((x) => x !== p.user_id) : [...named, p.user_id];
                    setNamed(ids);
                    void save("named", ids);
                  }}
                />
                {p.name}
              </label>
            );
          })}
        </fieldset>
      )}
      {error && (
        <p role="alert" className="simple-small text-crit">
          {error}
        </p>
      )}
    </div>
  );
}

export default MeetingChat;
