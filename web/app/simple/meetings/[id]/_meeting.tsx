"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/ds";
import { MeetingChat } from "@/components/simple/chat/MeetingChat";
import { OnePager } from "@/components/simple/OnePager";
import { QuestionRow, sourceName, useQuestionActions } from "@/components/simple/questions/Questions";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import type { MeetingAgenda, MeetingNote } from "@/lib/api/simple-chat";
import { calendarDay, formatInZone, useCompanyZone } from "@/lib/dates";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import { opWords } from "../../roadmap/_card";
import { DecidedItem } from "../_flow";

// Chat actions (notes, open questions, the agenda's next and skipped items): optional until schema.d.ts carries them.
type Meeting = Schemas["SimpleMeetingOut"] & { notes?: MeetingNote[]; agenda?: MeetingAgenda };
type Mode = Meeting["change_mode"];

const STEPS = ["One-pager", "Roadmap", "Decisions"] as const;
const MODE_WORDS: Record<Mode, string> = { everyone: "Everyone", presenter: "Only the presenter", named: "Presenter plus named people" };

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** How often a live meeting's screen reads the meeting again (other screens' Approve, Undo, changes). */
const LIVE_POLL_MS = 5_000;

/** "published" only when the draft's version is; else what still holds it (the API's waiting_on and blocked_by). */
function publishedWords(d: Meeting["drafts"][number], name: (id: string) => string): string {
  if (d.status === "approved") return "published";
  const names = d.waiting_on.map(name);
  const who = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  const why = [...(names.length ? [`Waiting on ${who}'s approval`] : []), ...d.blocked_by];
  return `not yet published: ${why.join(" · ") || "its review is not complete"}`;
}

/** While Oracle drafts the minutes, how often the end screen reads the meeting again. */
const MINUTES_POLL_MS = 3_000;

/** Names for ids, from the meeting's attendees and the people its drafts wait on (who need not be attendees). */
const namer = (m: Meeting) => (id: string) => [...m.attendees, ...m.waiting_people].find((a) => a.id === id)?.name ?? "a reviewer";

/**
 * Simple S8 (#723): one review meeting, full screen (direction A). Live: the steps
 * (one-pager, the PRD's roadmap slice, its open decisions and proposals), a clock over the
 * meeting's length, attendees with presence, the presenter's change mode, Approve and End;
 * the chat and every decision taken stay open on the right. Ended: Oracle's minutes, what
 * waits on whom and the delivery (the end screen). What a person may do is the API's `can`.
 */
export function MeetingScreen({ id }: { id: string }) {
  const q = useQuery(`simple-meeting|${id}`, () => unwrap(api.GET("/v1/simple/meetings/{meeting_id}", { params: { path: { meeting_id: id } } })));
  if (q.loading && !q.data) return <div className="px-6 py-8"><Loading /></div>;
  if (q.error || !q.data) return <div className="px-6 py-8"><ErrorNote>{q.error ?? "Not found"}</ErrorNote></div>;
  return (
    <div className="fixed inset-0 z-40 overflow-auto bg-bg text-[length:var(--simple-body)] text-text" data-testid="meeting-screen">
      {q.data.status === "ended" ? <EndScreen m={q.data} reload={q.reload} /> : <LiveScreen m={q.data} reload={q.reload} />}
    </div>
  );
}

function useAct(reload: () => Promise<unknown>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      await reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, act };
}

function LiveScreen({ m, reload }: { m: Meeting; reload: () => Promise<unknown> }) {
  const zone = useCompanyZone();
  const [step, setStep] = useState(0);
  const [notApproved, setNotApproved] = useState<Meeting["not_approved"]>([]);
  const [now, setNow] = useState(() => Date.now());
  const { busy, error, act } = useAct(reload);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  // Every screen on the meeting follows it (the production walk: Approve on the decider's
  // screen left the others on the old version and its draft bar): read it again every
  // LIVE_POLL_MS, and the one-pager with it when its decisions or drafts move on.
  useEffect(() => {
    const t = window.setInterval(() => void reload(), LIVE_POLL_MS);
    return () => window.clearInterval(t);
  }, [reload]);
  const path = { params: { path: { meeting_id: m.id } } };
  const rules = (body: Schemas["SimpleMeetingRulesIn"]) => act(() => unwrap(api.PATCH("/v1/simple/meetings/{meeting_id}/rules", { ...path, body })));
  const absent = m.attendees.filter((a) => !a.present).map((a) => a.id);
  const name = namer(m);
  const { me, can } = useMe();
  const joined = m.attendees.some((a) => a.id === me?.user_id);
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-surface px-4 py-3" aria-label="Meeting">
        <Link href="/simple/meetings" className="text-base underline">Meetings</Link>
        <h1 className="text-xl font-semibold">{m.title}</h1>
        <nav aria-label="Steps" className="flex flex-wrap gap-1">
          {STEPS.map((s, i) => (
            <button
              key={s}
              type="button"
              aria-pressed={step === i}
              onClick={() => setStep(i)}
              className={`rounded-full border px-3 py-1 text-base ${step === i ? "border-accent bg-accent text-white" : "border-border"}`}
            >
              {i + 1} {s}
            </button>
          ))}
        </nav>
        <span role="timer" aria-label="Meeting clock" className="font-semibold tabular-nums">
          {clock(now - Date.parse(m.started_at))} / {m.length_min}:00
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          {!joined && can("join_simple_meeting") && <Button variant="primary" disabled={busy} onClick={() => act(() => unwrap(api.POST("/v1/simple/meetings/{meeting_id}/join", path)))}>Join</Button>}
          {m.can.approve && (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  const r = await unwrap(api.POST("/v1/simple/meetings/{meeting_id}/approve", path));
                  setNotApproved(r.not_approved);
                })
              }
            >
              Approve
            </Button>
          )}
          {m.can.end && <Button disabled={busy} onClick={() => act(() => unwrap(api.POST("/v1/simple/meetings/{meeting_id}/end", path)))}>End meeting</Button>}
        </div>
      </header>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border px-4 py-2 text-base">
        <ul aria-label="Attendees" className="flex flex-wrap gap-2">
          {m.attendees.map((a) => (
            <li key={a.id} data-present={a.present ? "true" : "false"} className={`rounded-full border border-border px-3 py-0.5 ${a.present ? "" : "opacity-60 line-through"}`}>
              {m.can.set_rules && a.id !== m.presenter.id ? (
                <button
                  type="button"
                  aria-pressed={a.present}
                  disabled={busy}
                  aria-label={`${a.name} is here`}
                  title={a.present ? "Here: press to mark absent" : "Absent: press to mark here"}
                  onClick={() => rules({ absent_ids: a.present ? [...absent, a.id] : absent.filter((x) => x !== a.id) })}
                >
                  <span aria-hidden className={`mr-1 inline-block h-2.5 w-2.5 rounded-full ${a.present ? "bg-accent" : "border border-text-faint"}`} />
                  {a.name}
                </button>
              ) : (
                <span>{a.name}</span>
              )}
              {a.roles.length > 0 && <span className="text-sm text-text-faint"> · {a.roles.join(", ")}</span>}
              {!a.present && <span className="sr-only"> (absent)</span>}
            </li>
          ))}
        </ul>
        {m.can.set_rules ? (
          <ChangeMode m={m} busy={busy} onSave={rules} />
        ) : (
          <p data-testid="change-mode">Changes: {MODE_WORDS[m.change_mode]}{m.change_mode === "named" ? ` (${m.change_people.map((p) => p.name).join(", ")})` : ""}</p>
        )}
      </div>
      {m.drafts.filter((d) => d.decider_approved).map((d) => (
        <p key={d.id} role="status" data-testid="approved-banner" className="border-b border-border bg-[var(--simple-edited)] px-4 py-2 text-base">
          Approved in {m.title} · {publishedWords(d, name)}
        </p>
      ))}
      {notApproved.map((x) => (
        <p key={x.draft_id} role="status" data-testid="not-approved" className="border-b border-border px-4 py-2 text-base">
          {x.document.title} is not approved: {x.reason}
        </p>
      ))}
      {error && <div className="px-4 pt-2"><ErrorNote>{error}</ErrorNote></div>}
      <AgendaStrip agenda={m.agenda} />
      <div className="grid flex-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <main aria-label="Stage" className="min-w-0">
          {/* Read again whenever the meeting moves on (Approve, Undo, a change by chat): its
              version and its draft bar follow what was published. */}
          {step === 0 && (
            <OnePager
              doc={m.prd.slug}
              sessionId={m.session_id}
              refresh={`${m.meeting_decisions.length}|${m.drafts.map((d) => `${d.status}-${d.waiting_on.length}-${d.changes}`).join()}`}
              onChanged={() => void reload()}
            />
          )}
          {step === 1 && <RoadmapSlice m={m} reload={reload} />}
          {step === 2 && <DecisionsStep m={m} reload={reload} />}
        </main>
        <aside aria-label="Chat column" className="flex min-w-0 flex-col gap-4">
          <MeetingChat meetingId={m.id} sessionId={m.session_id} onCardChanged={() => void reload()} />
          <NotesSoFar notes={m.notes ?? []} />
          <section aria-label="All decisions" className="simple-card">
            <h2 className="simple-h2">All decisions</h2>
            {m.meeting_decisions.length === 0 ? (
              <p className="simple-small">None yet.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {m.meeting_decisions.map((d) => (
                  <li key={d.id} data-testid="meeting-decision">
                    <strong>D-{d.number}</strong> {d.title}
                    <span className="block text-sm text-text-faint">{d.approver.name} · {formatInZone(d.at, zone, { hour: "numeric", minute: "2-digit" })}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

/** The agenda as the meeting's chat changed it ("next: …", "skip …"): every attendee sees it. */
function AgendaStrip({ agenda }: { agenda?: MeetingAgenda }) {
  if (!agenda || (!agenda.next && agenda.skipped.length === 0)) return null;
  return (
    <div role="status" aria-label="Agenda" data-testid="agenda-strip" className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-border px-4 py-2 text-base [overflow-wrap:anywhere]">
      {agenda.next && (
        <p data-testid="agenda-next">
          <span className="font-semibold">Next:</span> {agenda.next.title}
        </p>
      )}
      {agenda.skipped.length > 0 && (
        <p data-testid="agenda-skipped" className="text-text2">
          <span className="font-semibold">Skipped:</span> {agenda.skipped.map((x) => x.title).join(", ")}
        </p>
      )}
    </div>
  );
}

/** The notes and open questions typed in the chat so far (they go into the minutes when the meeting ends). */
function NotesSoFar({ notes }: { notes: MeetingNote[] }) {
  return (
    <section aria-label="Notes so far" className="simple-card" data-testid="meeting-notes">
      <h2 className="simple-h2">Notes so far</h2>
      {notes.length === 0 ? (
        <p className="simple-small">None yet. Type “note: …” or “open question: …” in the chat.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {notes.map((n) => (
            <li key={n.card_id} data-testid="meeting-note" data-kind={n.kind} className="[overflow-wrap:anywhere]">
              <span className="font-semibold">{n.kind === "question" ? "Open question:" : "Note:"}</span> {n.text}
              <span className="block text-sm text-text-faint">{n.by_name}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ChangeMode({ m, busy, onSave }: { m: Meeting; busy: boolean; onSave: (b: Schemas["SimpleMeetingRulesIn"]) => void }) {
  const named = m.change_people.map((p) => p.id);
  const others = m.attendees.filter((a) => a.id !== m.presenter.id);
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="change-mode">
      <label className="flex items-center gap-2">
        <span>Who changes things</span>
        <select
          className="rounded border border-border bg-transparent p-1"
          value={m.change_mode}
          disabled={busy}
          onChange={(e) => {
            const mode = e.target.value as Mode;
            if (mode !== "named") onSave({ change_mode: mode });
            else if (named.length) onSave({ change_mode: mode, change_people: named });
            else if (others[0]) onSave({ change_mode: mode, change_people: [others[0].id] });
          }}
        >
          {(Object.keys(MODE_WORDS) as Mode[]).map((k) => <option key={k} value={k}>{MODE_WORDS[k]}</option>)}
        </select>
      </label>
      {m.change_mode === "named" &&
        others.map((a) => {
          const on = named.includes(a.id);
          return (
            <button
              key={a.id}
              type="button"
              aria-pressed={on}
              className={`rounded-full border px-2 ${on ? "border-accent" : "border-border"}`}
              disabled={busy || (!on && named.length >= 2) || (on && named.length === 1)}
              onClick={() => onSave({ change_mode: "named", change_people: on ? named.filter((x) => x !== a.id) : [...named, a.id] })}
            >
              {a.name} changes things
            </button>
          );
        })}
    </div>
  );
}

const HORIZONS = ["now", "next", "later"] as const;

function RoadmapSlice({ m, reload }: { m: Meeting; reload: () => Promise<unknown> }) {
  const q = useQuery(`simple-meeting-roadmap|${m.prd.slug}`, () => unwrap(api.GET("/v1/simple/roadmap", { params: { query: { prd: m.prd.slug } } })));
  const { busy, error, act } = useAct(async () => {
    await q.reload();
    await reload();
  });
  const [said, setSaid] = useState<string | null>(null);
  const change = (body: Schemas["SimpleChangeIn"]) =>
    act(async () => {
      const r = await unwrap(api.POST("/v1/simple/changes", { body: { ...body, session_id: m.session_id } }));
      setSaid(r.change.status === "proposed" ? "Proposed: it waits on its decider" : "Done");
    });
  if (q.loading && !q.data) return <Loading />;
  if (q.error || !q.data) return <ErrorNote>{q.error ?? "Not found"}</ErrorNote>;
  const items = q.data.items;
  return (
    <section aria-label="Roadmap slice" className="simple-card">
      <h2 className="simple-h2">{m.prd.title} on the roadmap</h2>
      {said && <p role="status" className="simple-small">{said}</p>}
      {error && <ErrorNote>{error}</ErrorNote>}
      {items.length === 0 && <p className="simple-small">No roadmap items for this PRD yet.</p>}
      <ul className="mt-2 divide-y divide-border">
        {items.map((i) => (
          <li key={i.id} data-item={i.key} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>
              <strong>{i.title}</strong> · {i.status === "cut" ? "Cut" : i.horizon[0].toUpperCase() + i.horizon.slice(1)} · {i.start.date} – {i.end.date}
            </span>
            {m.can.change && i.status !== "cut" && (
              <span className="flex flex-wrap gap-2">
                {HORIZONS.filter((h) => h !== i.horizon).map((h) => (
                  <Button key={h} disabled={busy} aria-label={`Move ${i.title} to ${h[0].toUpperCase() + h.slice(1)}`} onClick={() => change({ op: "change_horizon", target: { item_id: i.id }, before: { horizon: i.horizon }, after: { horizon: h } })}>
                    Move to {h[0].toUpperCase() + h.slice(1)}
                  </Button>
                ))}
                <Button variant="ghost" disabled={busy} aria-label={`Cut ${i.title}`} onClick={() => change({ op: "cut", target: { item_id: i.id }, before: { cut: false }, after: {} })}>Cut</Button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function DecisionsStep({ m, reload }: { m: Meeting; reload: () => Promise<unknown> }) {
  const { busy, error, act } = useAct(reload);
  const [text, setText] = useState("");
  const decide = (id: string, how: "accept" | "decline") =>
    act(() =>
      how === "accept"
        ? unwrap(api.POST("/v1/simple/changes/{change_id}/accept", { params: { path: { change_id: id } }, body: { session_id: m.session_id } }))
        : unwrap(api.POST("/v1/simple/changes/{change_id}/decline", { params: { path: { change_id: id } }, body: { session_id: m.session_id } })),
    );
  return (
    <div className="space-y-4">
      {error && <ErrorNote>{error}</ErrorNote>}
      <DecisionsDue m={m} reload={reload} />
      {/* prd-decisions A3: the agenda above holds the PRD's questions; other open decisions only when there are some. */}
      {m.open_decisions.length > 0 && (
        <section aria-label="Open decisions" className="simple-card">
          <h2 className="simple-h2">Open decisions</h2>
          <ul className="mt-2 space-y-1">
            {m.open_decisions.map((d) => (
              <li key={d.id}>
                <Link className="font-semibold text-accent-ink hover:underline" href={`/simple/decisions#d-${d.number}`}>D-{d.number}</Link> {d.title}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-label="Pending proposals" className="simple-card">
        <h2 className="simple-h2">Pending proposals</h2>
        {m.pending_proposals.length === 0 && <p className="simple-small">No proposal waits.</p>}
        <ul className="mt-2 space-y-2">
          {m.pending_proposals.map((c) => (
            <li key={c.id} data-change={c.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {c.by_name} proposes: {opWords(c.op)}
                {c.op === "change_horizon" ? ` to ${String(c.after.horizon)}` : c.op === "edit_line" ? ` “${String(c.after.line ?? "")}”` : ""}
              </span>
              {c.can_decide && (
                <span className="flex gap-2">
                  <Button variant="primary" disabled={busy} onClick={() => decide(c.id, "accept")}>Accept</Button>
                  <Button disabled={busy} onClick={() => decide(c.id, "decline")}>Decline</Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section aria-label="Comment in the meeting" className="simple-card">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await unwrap(api.POST("/v1/simple/meetings/{meeting_id}/comments", { params: { path: { meeting_id: m.id } }, body: { text, subjects: [] } }));
              setText("");
            });
          }}
          className="space-y-2"
        >
          <label className="flex flex-col gap-1">
            <span className="simple-h2">Comment</span>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} className="rounded border border-border bg-transparent p-2" />
          </label>
          <Button type="submit" disabled={busy || !text.trim()}>Add comment</Button>
        </form>
      </section>
    </div>
  );
}

// action_item_id: one recorded in the meeting, kept so Send does not add it again.
type ActionRow = { title: string; owner_id: string; due_date: string; action_item_id?: string | null };

function EndScreen({ m, reload }: { m: Meeting; reload: () => Promise<unknown> }) {
  const zone = useCompanyZone();
  const { busy, error, act } = useAct(reload);
  const minutes = m.minutes;
  const editable = m.can.end && m.minutes_state !== "sent";
  const [summary, setSummary] = useState(minutes?.summary ?? "");
  const [questions, setQuestions] = useState((minutes?.open_questions ?? []).join("\n"));
  const [actions, setActions] = useState<ActionRow[]>((minutes?.action_items ?? []).map((a) => ({ title: a.title, owner_id: a.owner_id ?? "", due_date: a.due_date ?? "", action_item_id: a.action_item_id ?? null })));
  const [dirty, setDirty] = useState(false);
  // Oracle's minutes landing (Draft again, a slow job) fill the fields a person has not touched.
  const written = `${minutes?.written_by ?? ""}|${minutes?.summary ?? ""}`;
  const [shown, setShown] = useState(written);
  if (written !== shown && !dirty) {
    setShown(written);
    setSummary(minutes?.summary ?? "");
    setQuestions((minutes?.open_questions ?? []).join("\n"));
    setActions((minutes?.action_items ?? []).map((a) => ({ title: a.title, owner_id: a.owner_id ?? "", due_date: a.due_date ?? "", action_item_id: a.action_item_id ?? null })));
  }
  // Until the minutes job ends, read again every few seconds and when the tab comes back
  // (a hidden tab's timers are throttled): it answers (the minutes, Send), slows down or
  // fails (Draft again), with no reload (production walk: "Drafting…" stayed until one).
  const drafting = m.minutes_state === "drafting" && m.minutes_job !== "failed";
  useEffect(() => {
    if (!drafting) return;
    const read = () => {
      if (document.visibilityState === "visible") void reload();
    };
    const t = window.setInterval(read, MINUTES_POLL_MS);
    document.addEventListener("visibilitychange", read);
    window.addEventListener("focus", read);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", read);
      window.removeEventListener("focus", read);
    };
  }, [drafting, reload]);
  const [email, setEmail] = useState(false);
  const [slack, setSlack] = useState(false);
  const path = { params: { path: { meeting_id: m.id } } };
  const slackReady = m.slack.connected && !!m.slack.channel;
  const owner = (id: string | null | undefined) => m.attendees.find((a) => a.id === id)?.name;
  const minutesIn = (): Schemas["SimpleMinutesIn"] => ({
    summary,
    open_questions: questions.split("\n").map((x) => x.trim()).filter(Boolean),
    action_items: actions.filter((a) => a.title.trim()).map((a) => ({ title: a.title.trim(), owner_id: a.owner_id || null, due_date: a.due_date || null, action_item_id: a.action_item_id ?? null })),
  });
  const save = () => act(async () => {
    await unwrap(api.PUT("/v1/simple/meetings/{meeting_id}/minutes", { ...path, body: minutesIn() }));
    setDirty(false);
  });
  const send = () => act(async () => {
    if (dirty) await unwrap(api.PUT("/v1/simple/meetings/{meeting_id}/minutes", { ...path, body: minutesIn() }));
    await unwrap(api.POST("/v1/simple/meetings/{meeting_id}/send", { ...path, body: { email, slack } }));
  });
  const edit = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setDirty(true);
  };
  const d = m.delivery;
  return (
    <div className="mx-auto max-w-[1180px] space-y-4 p-4" data-testid="end-screen">
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <Link href="/simple/meetings" className="text-base underline">Meetings</Link>
        <h1 className="text-2xl font-semibold">{m.title}</h1>
        <span className="text-base text-text-faint">
          Ended {m.ended_at ? formatInZone(m.ended_at, zone, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""} · {m.attendees.map((a) => a.name).join(", ")}
        </span>
      </header>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <section aria-label="Minutes" className="simple-card space-y-3">
          <h2 className="simple-h2">Oracle&apos;s minutes</h2>
          {m.minutes_job === "drafting" && <p role="status">Drafting…</p>}
          {m.minutes_job === "slow" && (
            <p role="status" data-testid="minutes-slow">Oracle is still drafting the minutes. Send what is written, or wait for its draft.</p>
          )}
          {m.minutes_job === "failed" && (
            <div role="alert" data-testid="minutes-failed" className="flex flex-wrap items-center gap-3">
              <span>Oracle could not draft the minutes. Send what is written, or draft again.</span>
              {m.can.redraft && (
                <Button disabled={busy} onClick={() => act(() => unwrap(api.POST("/v1/simple/meetings/{meeting_id}/minutes/redraft", path)))}>Draft again</Button>
              )}
            </div>
          )}
          {editable ? (
            <>
              <label className="flex flex-col gap-1">
                <span className="font-semibold">Summary</span>
                <textarea rows={4} value={summary} onChange={(e) => edit(setSummary)(e.target.value)} className="rounded border border-border bg-transparent p-2" />
              </label>
              <label className="flex flex-col gap-1">
                <span className="font-semibold">Open questions</span>
                <textarea rows={3} value={questions} onChange={(e) => edit(setQuestions)(e.target.value)} className="rounded border border-border bg-transparent p-2" />
                <span className="simple-small">One per line</span>
              </label>
              <fieldset className="space-y-2">
                <legend className="font-semibold">Action items</legend>
                {actions.map((a, i) => (
                  <div key={i} className="flex flex-wrap gap-2" data-testid="action-item">
                    <input aria-label={`Action item ${i + 1}`} value={a.title} onChange={(e) => edit(setActions)(actions.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} className="min-w-0 flex-1 rounded border border-border bg-transparent p-2" />
                    <select aria-label={`Owner of action item ${i + 1}`} value={a.owner_id} onChange={(e) => edit(setActions)(actions.map((x, j) => (j === i ? { ...x, owner_id: e.target.value } : x)))} className="rounded border border-border bg-transparent p-2">
                      <option value="">Who?</option>
                      {m.attendees.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                    <input type="date" aria-label={`Due date of action item ${i + 1}`} value={a.due_date} onChange={(e) => edit(setActions)(actions.map((x, j) => (j === i ? { ...x, due_date: e.target.value } : x)))} className="rounded border border-border bg-transparent p-2" />
                  </div>
                ))}
                <Button onClick={() => edit(setActions)([...actions, { title: "", owner_id: "", due_date: "" }])}>Add action item</Button>
              </fieldset>
              <Button disabled={busy || !dirty} onClick={save}>Save minutes</Button>
            </>
          ) : (
            <>
              <p data-testid="minutes-summary">{minutes?.summary || "No summary."}</p>
              <h3 className="font-semibold">Open questions</h3>
              {minutes?.open_questions.length ? <ul className="list-disc pl-5">{minutes.open_questions.map((x) => <li key={x}>{x}</li>)}</ul> : <p className="simple-small">None.</p>}
              <h3 className="font-semibold">Action items</h3>
              {minutes?.action_items.length ? (
                <ul className="list-disc pl-5">
                  {minutes.action_items.map((a, i) => <li key={i}>{a.title} · {a.owner_name ?? owner(a.owner_id) ?? "no owner"}{a.due_date ? ` · by ${a.due_date}` : ""}</li>)}
                </ul>
              ) : (
                <p className="simple-small">None.</p>
              )}
            </>
          )}
          <h3 className="font-semibold">Decisions taken</h3>
          {m.meeting_decisions.length ? (
            <ul aria-label="Decisions taken" className="space-y-1">
              {m.meeting_decisions.map((x) => (
                <DecidedItem key={x.id} flow={x.flow}>
                  <span><strong>D-{x.number}</strong> {x.title} · {x.approver.name}</span>
                </DecidedItem>
              ))}
            </ul>
          ) : (
            <p className="simple-small">No decision was taken.</p>
          )}
        </section>
        <div className="flex flex-col gap-4">
          <section aria-label="What still waits" className="simple-card">
            <h2 className="simple-h2">What still waits on whom</h2>
            {minutes?.waits.length ? (
              <ul className="mt-2 space-y-1">
                {minutes.waits.map((w, i) => <li key={i}>{w.what}{w.on.length ? ` · on ${w.on.map((p) => p.name).join(", ")}` : ""}</li>)}
              </ul>
            ) : (
              <p className="simple-small">Nothing waits.</p>
            )}
          </section>
          <section aria-label="Delivery" className="simple-card space-y-2">
            <h2 className="simple-h2">Delivery</h2>
            {m.minutes_state === "sent" && d ? (
              <div role="status" aria-label="Sent" className="space-y-1">
                <p className="font-semibold">Sent</p>
                <ul className="space-y-1">
                  <li>Decisions page · posted</li>
                  <li>Each attendee&apos;s Inbox · posted</li>
                  <li>Email · {d.email ? (d.email_status ?? "queued") : "not chosen"}</li>
                  <li>Slack · {d.slack ? `${d.slack_status ?? "queued"}${d.slack_channel ? ` to ${d.slack_channel}` : ""}` : "not chosen"}</li>
                </ul>
                <Link className="font-semibold text-accent-ink hover:underline" href={`/simple/decisions?meeting=${m.id}`}>Open the Decisions page</Link>
              </div>
            ) : m.can.end ? (
              <>
                <label className="flex items-center gap-2"><input type="checkbox" checked disabled /> Decisions page</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked disabled /> Each attendee&apos;s Inbox</label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={email} disabled={!m.email_available} onChange={(e) => setEmail(e.target.checked)} /> Email the attendees
                  {!m.email_available && <span className="simple-small"> · Email isn&apos;t set up</span>}
                </label>
                {slackReady ? (
                  <label className="flex items-center gap-2"><input type="checkbox" checked={slack} onChange={(e) => setSlack(e.target.checked)} /> Post to {m.slack.channel}</label>
                ) : (
                  <label className="flex items-center gap-2"><input type="checkbox" disabled checked={false} onChange={() => undefined} /> Post to Slack <span className="simple-small"> · {m.slack.connected ? "No channel set" : "Not connected"}</span></label>
                )}
                <Button variant="primary" disabled={busy} onClick={send}>Send</Button>
              </>
            ) : (
              <p className="simple-small">The minutes are not sent yet.</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/** The agenda shows this many questions before "N more: <codes>". */
const AGENDA_FIRST = 4;

/** A calendar day ("2026-11-13") as "Fri Nov 13". */
const dayWords = (day: string) => `${calendarDay(day, { weekday: "short" })} ${calendarDay(day)}`;

/**
 * prd-questions, kept to the owner's pick A (frame A3): the Decisions step's "On the agenda":
 * the PRD's open questions due by the end of the milestone the soonest one blocks, whoever
 * decides them, soonest first ("Due by Fri Nov 13 · 8 decisions · from <PRD> draft 3"), the
 * first four and "N more: <codes>". Decide passes the meeting's session_id so the decision
 * lands in its minutes; a question decided here stays on the list with Undo.
 */
function DecisionsDue({ m, reload }: { m: Meeting; reload: () => Promise<unknown> }) {
  const actions = useQuestionActions(reload, m.session_id);
  const [all, setAll] = useState(false);
  const due = m.decisions_due ?? [];
  const source = sourceName(due);
  const by = due
    .map((q) => q.due_on)
    .filter((d): d is string => !!d)
    .sort()
    .at(-1);
  const rest = due.slice(AGENDA_FIRST);
  return (
    <section aria-label="On the agenda" data-testid="decisions-due" className="simple-card">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="simple-h2 min-w-0 flex-1">On the agenda</h2>
        {due.length > 0 && (
          <span className="simple-meta" data-testid="decisions-due-summary">
            {[by && `Due by ${dayWords(by)}`, `${due.length} ${due.length === 1 ? "decision" : "decisions"}`, source && `from ${source}`].filter(Boolean).join(" · ")}
          </span>
        )}
      </header>
      {due.length === 0 ? (
        <p className="simple-meta">No decision is due.</p>
      ) : (
        <ul>
          {(all ? due : due.slice(0, AGENDA_FIRST)).map((q) => (
            <QuestionRow key={q.id} q={q} mode="due" actions={actions} />
          ))}
        </ul>
      )}
      {!all && rest.length > 0 && (
        <button type="button" className="simple-more" onClick={() => setAll(true)}>
          {rest.length} more: {rest.map((q) => q.code).join(", ")}
        </button>
      )}
    </section>
  );
}
