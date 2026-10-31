"use client";

import { useCallback, useEffect, useState } from "react";

import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatInZone, useCompanyZone } from "@/lib/dates";
import { meetingSay, meetingThread, setChatMode, type ChangeMode, type ChatRules, type ChatThread } from "@/lib/api/simple-chat";
import { errorMessage } from "@/lib/use-query";

import { ChatThreadView, usePendingPoll } from "./ChatThread";

const POLL_MS = 2000;
// qa-simple-decide-7: the same words as the start sheet and the meeting's header.
// qa-simple-decide-25: viewers only ask, whatever the mode.
const MODE_WORDS: Record<ChangeMode, string> = { everyone: "Everyone except viewers", presenter: "Only the presenter", named: "Presenter plus one or two people" };
const detail = (e: unknown) => errorMessage(e).replace(/ \(\d{3}\)$/, "");

/** meet-chat-right-prd: who ended the meeting, or that it ended by itself once its time ran out, and when. */
function endedWords(r: ChatRules, zone: string): string {
  const when = r.ended_at ? `, ${formatInZone(r.ended_at, zone, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}` : "";
  if (r.ended_by_itself) return `Ended by itself after its time ran out${when}`;
  if (r.ended_by) return `Ended by ${r.ended_by.name}${when}`;
  return "The meeting has ended";
}

function rulesLine(r: ChatRules): string {
  if (r.change_mode === "named") return `Presenter plus ${r.change_people.length ? r.change_people.map((p) => p.name).join(", ") : "no one named yet"}`;
  return MODE_WORDS[r.change_mode];
}

/**
 * A meeting's shared change-by-chat thread (Simple S9): every attendee's lines and Oracle's
 * cards, polled so each tab sees the others; the rules line (who may apply) and, for the
 * presenter, the control that changes it. Viewers ask questions only. `onCardChanged`: a card
 * here was applied, discarded or undone (the host reads its meeting again).
 */
export function MeetingChat({
  meetingId,
  sessionId,
  onCardChanged,
  rulesControl = true,
  scroll = false,
  heading = true,
}: {
  meetingId: string;
  sessionId: string;
  onCardChanged?: () => void;
  /** The presenter's "who changes things" control; the meeting screen sets it in its attendee bar instead. */
  rulesControl?: boolean;
  /** The lines scroll inside the card (the meeting screen's right column). */
  scroll?: boolean;
  /** The card's own title; the chat's own page has it as the page title. */
  heading?: boolean;
}) {
  const [thread, setThread] = useState<ChatThread | null>(null);
  const zone = useCompanyZone();
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
      {heading && <h2 className="simple-h2">Meeting chat</h2>}
      {error && !thread && (
        <p role="alert" className="simple-small text-crit">
          {error}
        </p>
      )}
      {rules && (
        <div className="flex flex-col gap-2 border-b border-line pb-3">
          {/* qa-simple-decide-10: the presenter's control states the setting; everyone else reads the line. */}
          {!(rulesControl && rules.is_presenter && !rules.ended) && <p className="simple-small" data-testid="chat-rules">
            Who changes things: <strong>{rulesLine(rules)}</strong>
            {rules.ended && <span data-testid="chat-ended"> · {endedWords(rules, zone)}</span>}
          </p>}
          {rulesControl && rules.is_presenter && !rules.ended && <ModeControl meetingId={meetingId} rules={rules} onSaved={(r) => setThread((t) => (t ? { ...t, rules: r } : t))} />}
        </div>
      )}
      {thread && (
        <ChatThreadView
          testId="meeting-chat-thread"
          thread={thread}
          // qa-simple-decide-3: this chat makes changes and notes; questions go to Ask Oracle.
          placeholder={rules?.ask_only ? "Ask a question about what is on screen" : "Ask for a change, or type “note: …”"}
          hint={rules?.ask_only ? "Viewers ask questions here; the presenter makes changes and notes." : "For a question about the plan, use Ask Oracle."}
          scroll={scroll ? "max-h-[50vh]" : undefined}
          send={async (text) => setThread(await meetingSay(meetingId, text))}
          onCardChanged={() => {
            void load();
            // The meeting screen reads the meeting again: its notes, agenda and decisions follow the card.
            onCardChanged?.();
          }}
          onThread={(t) => {
            setThread(t);
            // Apply all (and a picked choice) change cards too: the meeting screen follows them.
            onCardChanged?.();
          }}
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
        Who changes things
        <select
          aria-label="Who changes things"
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
