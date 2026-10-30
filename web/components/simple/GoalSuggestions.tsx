"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { Button, Sheet, toast } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { askWith } from "@/components/hop/open-state";
import { useCompanyZone, zoneDateTime } from "@/lib/dates";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import { FlowDetail } from "./Flow";

/**
 * Simple S7: Oracle's suggested features for a goal, wherever a goal shows (the roadmap's
 * tray and goal headers, Home's goal band, Priorities' goal buckets). Each suggestion shows
 * its title, outcome, why, the evidence with how sure Oracle is, its flow and the items it
 * looks like; Accept adds it as a draft on the goal (an add_item change: editors apply with
 * Undo, others propose), Reject asks an optional reason. "Suggest features" asks Oracle for
 * more; the list says "Oracle is suggesting features…" until they arrive. Roles only through
 * can() and the suggestions' own can_accept / can_reject.
 */

export type GoalSuggestion = Schemas["SimpleGoalSuggestion"];
export type GoalSuggestionsOut = Schemas["SimpleGoalSuggestionsOut"];
export type GoalBrief = Schemas["SimpleGoalBrief"];

const PHONE = "(max-width: 640px)";
function usePhone(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const q = window.matchMedia(PHONE);
    const on = () => setPhone(q.matches);
    on();
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return phone;
}

function detailOf(error: unknown): string {
  const d = (error as { detail?: unknown } | undefined)?.detail;
  if (typeof d === "string") return d;
  if (d && typeof d === "object" && "message" in d) return String((d as { message: unknown }).message);
  return "Oracle could not do that";
}

export interface GoalSuggestionsApi {
  data: GoalSuggestionsOut | undefined;
  error: string | null;
  reload: () => Promise<void>;
  suggest: (goal: GoalBrief) => Promise<void>;
  accept: (s: GoalSuggestion) => Promise<void>;
  reject: (s: GoalSuggestion, reason: string) => Promise<void>;
}

/** Every goal's open suggestions; polls while a goal's suggest job runs. `onChanged` runs after an accept or its undo. */
export function useGoalSuggestions(onChanged?: () => unknown): GoalSuggestionsApi {
  const q = useQuery("simple-goal-suggestions", () => unwrap(api.GET("/v1/simple/goal-suggestions", { params: { query: { status: "open" } } })), { keepPrevious: true });
  const pending = !!q.data?.goals.some((g) => g.pending);
  const { reload } = q;
  useEffect(() => {
    if (!pending) return;
    const t = window.setTimeout(() => void reload(), 700);
    return () => window.clearTimeout(t);
  }, [pending, q.data, reload]);

  const after = async () => {
    await q.reload();
    await onChanged?.();
  };

  return {
    data: q.data,
    error: q.error,
    reload: async () => {
      await q.reload();
    },
    suggest: async (goal) => {
      const r = await api.POST("/v1/simple/goals/{goal_id}/suggest", { params: { path: { goal_id: goal.id } } });
      toast({ message: r.data ? `Oracle is suggesting features for ${goal.title}` : detailOf(r.error) });
      await q.reload();
    },
    accept: async (s) => {
      const r = await api.POST("/v1/simple/goal-suggestions/{suggestion_id}/accept", { params: { path: { suggestion_id: s.id } }, body: {} });
      if (!r.data) {
        toast({ message: detailOf(r.error) });
        await after();
        return;
      }
      const c = r.data.change;
      if (c.status === "applied")
        toast({
          message: `Added ${s.title} as a draft`,
          action: c.can_undo
            ? {
                label: "Undo",
                onClick: () =>
                  void api.POST("/v1/simple/changes/{change_id}/undo", { params: { path: { change_id: c.id } } }).then(async (u) => {
                    toast({ message: u.data ? "Undone" : detailOf(u.error) });
                    await after();
                  }),
              }
            : undefined,
        });
      else {
        const decider = q.data?.goals.find((g) => g.goal.id === s.goal.id || g.goal.key === s.goal.key)?.decider_name;
        toast({ message: `Proposed ${s.title}: ${decider ? `${decider} decides` : "the company's owners decide"}` });
      }
      await after();
    },
    reject: async (s, reason) => {
      const r = await api.POST("/v1/simple/goal-suggestions/{suggestion_id}/reject", { params: { path: { suggestion_id: s.id } }, body: { reason: reason.trim() || null } });
      toast({ message: r.data ? `Rejected ${s.title}: Oracle will not suggest it again` : detailOf(r.error) });
      await q.reload();
    },
  };
}

const CONFIDENCE: Record<string, string> = { high: "bg-pass-bg text-pass", medium: "bg-warn-bg text-warn", low: "bg-na-bg text-na" };

/** The optional reason before a reject. */
function RejectDialog({ s, onReject, onClose }: { s: GoalSuggestion; onReject: (reason: string) => void; onClose: () => void }) {
  const [reason, setReason] = useState("");
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 p-4 sm:items-center" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Reject ${s.title}`}
        className="w-full max-w-md rounded-[var(--simple-card-radius)] border border-line bg-surface p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[length:var(--simple-h2)] leading-[var(--simple-h2-leading)] font-semibold">Reject {s.title}</h2>
        <p className="mb-2 text-[length:var(--simple-small)] text-text2">Oracle will not suggest it again for {s.goal.title}. Saying why is optional.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onReject(reason);
          }}
        >
          <label className="block text-[length:var(--simple-small)] font-medium" htmlFor={`reject-${s.id}`}>
            Why (optional)
          </label>
          <input
            id={`reject-${s.id}`}
            autoFocus
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 text-[length:var(--simple-small)]"
          />
          <div className="mt-3 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="danger">
              Reject
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** One suggestion: title, outcome, why, evidence, flow, looks-like; Accept / Reject by its own can_* fields. */
export function SuggestionCard({ s, api: a }: { s: GoalSuggestion; api: GoalSuggestionsApi }) {
  const { can } = useMe();
  // PER_ITEM says owners; the suggestion's own can_accept / can_reject (its decider, an approver too) decides.
  const accepts = s.can_accept && can("accept_goal_suggestion", true);
  const rejects = s.can_reject && can("reject_goal_suggestion", true);
  const phone = usePhone();
  const [wide, setWide] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    try {
      await f();
    } catch (e) {
      toast({ message: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li
      data-testid="goal-suggestion"
      data-title={s.title}
      data-wide={wide && !phone ? "true" : "false"}
      className="rounded-[var(--simple-card-radius)] border border-dashed border-accent bg-accent-soft/40 p-3 text-[length:var(--simple-small)]"
    >
      {/* The text takes the card's full width; the actions sit on their own row under it (no thumbnail glyph). */}
      <div className="flex flex-col gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <span className="text-[length:var(--simple-text)] font-semibold text-text">{s.title}</span>
            <span className="rounded-full bg-surface2 px-2 text-text2" data-testid="oracle-suggested">
              ✦ Oracle suggested
            </span>
          </p>
          <p data-testid="suggestion-outcome">{s.outcome}</p>
          <p className="text-text2" data-testid="suggestion-why">
            Why: {s.why}
          </p>
          {s.evidence.length > 0 && (
            <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1" data-testid="suggestion-evidence" aria-label="Sources">
              <li className="text-text2">Sources:</li>
              {s.evidence.map((e) => (
                <li key={e.label} className="flex items-center gap-1.5">
                  {e.url ? (
                    <a href={e.url} className="text-accent-ink underline">
                      {e.label}
                    </a>
                  ) : (
                    <span>{e.label}</span>
                  )}
                  <span data-testid="confidence" className={`whitespace-nowrap rounded-full px-1.5 text-xs ${CONFIDENCE[e.confidence] ?? ""}`}>
                    {e.confidence} confidence
                  </span>
                </li>
              ))}
            </ul>
          )}
          {s.looks_like.map((m) => (
            <LooksLike key={m.id} m={m} merges={rejects} busy={busy} onMerge={() => void run(() => a.reject(s, `Same as ${`${m.code} ${m.title}`.trim()}`))} />
          ))}
        </div>
        {(accepts || rejects || s.flow) && (
          <span className="flex flex-wrap items-center gap-2">
            {accepts && (
              <Button variant="solid" disabled={busy} onClick={() => void run(() => a.accept(s))}>
                Accept
              </Button>
            )}
            {rejects && (
              <Button disabled={busy} onClick={() => setRejecting(true)}>
                Reject
              </Button>
            )}
            {s.flow && (
              <button type="button" aria-expanded={wide} onClick={() => setWide(!wide)} className="font-semibold text-accent-ink hover:underline" data-testid="flow-open">
                {wide ? "Hide the flow" : "Show the flow"}
              </button>
            )}
          </span>
        )}
      </div>
      {wide && !phone && s.flow && (
        // qa-simple-plan-36: the opened flow scrolls into view.
        <div ref={(el) => el?.scrollIntoView({ block: "nearest", behavior: "smooth" })} data-testid="flow-detail-wrap">
          <FlowDetail flow={s.flow} />
        </div>
      )}
      {phone && s.flow && (
        <Sheet open={wide} title={s.flow.title} onClose={() => setWide(false)} full testId="flow-sheet">
          <div className="p-4">
            <FlowDetail flow={s.flow} />
          </div>
        </Sheet>
      )}
      {rejecting && (
        <RejectDialog
          s={s}
          onClose={() => setRejecting(false)}
          onReject={(reason) => {
            setRejecting(false);
            void run(() => a.reject(s, reason));
          }}
        />
      )}
    </li>
  );
}

/**
 * qa-simple-plan-34: a look-alike feature, linked to its own row in the Ranked list (marked
 * there), and for whoever decides "Same as this: decline the suggestion" (it is declined as the
 * same as that feature; nothing is merged).
 */
function LooksLike({ m, merges, busy, onMerge }: { m: GoalSuggestion["looks_like"][number]; merges: boolean; busy: boolean; onMerge: () => void }) {
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-2 text-warn" data-testid="suggestion-looks-like">
      <span>
        Looks like{" "}
        <Link href={`/simple/priorities?tab=ranked&show=${encodeURIComponent(m.id)}`} className="font-semibold underline" data-testid="looks-like-link">
          {`${m.code} ${m.title}`.trim()}
        </Link>
      </span>
      {merges && (
        <button type="button" disabled={busy} onClick={onMerge} className="font-semibold text-accent-ink underline" data-testid="looks-like-merge">
          Same as this: decline the suggestion
        </button>
      )}
    </p>
  );
}

/** A goal's open suggestions: people's (origin "person") and Oracle's. */
export function goalRows(a: GoalSuggestionsApi, goal: GoalBrief): { people: GoalSuggestion[]; oracle: GoalSuggestion[] } {
  const rows = (a.data?.suggestions ?? []).filter((s) => s.goal.id === goal.id || s.goal.key === goal.key);
  return { people: rows.filter((s) => s.origin === "person"), oracle: rows.filter((s) => s.origin !== "person") };
}

function goalState(a: GoalSuggestionsApi, goal: GoalBrief) {
  return a.data?.goals.find((g) => g.goal.id === goal.id || g.goal.key === goal.key);
}

/**
 * A goal's one button (Home's goal cards, Priorities' goal buckets): "Suggestions · N", just
 * "Suggestions" at 0. While Oracle suggests it says so, and the count changes when it is done
 * (never under the reader without a reason).
 */
export function SuggestionsButton({ goal, api: a, onOpen, className = "", label = "Suggestions" }: { goal: GoalBrief; api: GoalSuggestionsApi; onOpen: (g: GoalBrief) => void; className?: string; label?: string }) {
  const state = goalState(a, goal);
  if (!state) return null;
  const { people, oracle } = goalRows(a, goal);
  const n = people.length + oracle.length;
  return (
    <button
      type="button"
      data-testid="goal-suggestions-open"
      data-goal={state.goal.key}
      aria-label={`Suggestions for ${state.goal.title}`}
      onClick={() => onOpen(state.goal)}
      className={`simple-small rounded-lg border border-line bg-surface px-3 py-1.5 font-semibold text-accent-ink hover:bg-surface2 ${className}`}
    >
      {state.pending ? "Oracle is suggesting..." : n ? `${label} · ${n}` : label}
    </button>
  );
}

/** "Suggest a feature": name, what it does and for whom, the goal set, who decides; folded to
 * one line (a button, "+ Suggest a feature") for the decider. `open` and `onOpen` are the
 * parent's, so the empty state's "Suggest the first feature" can open the same form. */
function SuggestForm({ goal, decider, decides = false, open, onOpen, focus = false, onSent }: { goal: GoalBrief; decider: string | null; decides?: boolean; open: boolean; onOpen: () => void; focus?: boolean; onSent: () => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [outcome, setOutcome] = useState("");
  const [busy, setBusy] = useState(false);
  if (!open)
    return (
      <Button variant="secondary" data-testid="suggest-form-open" onClick={onOpen} className="self-start">
        + Suggest a feature
      </Button>
    );
  return (
    <form
      data-testid="suggest-form"
      aria-label="Suggest a feature"
      className="flex flex-col gap-2 rounded-[var(--simple-card-radius)] border border-line bg-surface2/40 p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const r = await api.POST("/v1/simple/goals/{goal_id}/suggestions", { params: { path: { goal_id: goal.id } }, body: { title: title.trim(), outcome: outcome.trim() } });
          if (!r.data) {
            toast({ message: detailOf(r.error) });
            return;
          }
          toast({ message: `Sent: ${r.data.title}` });
          setTitle("");
          setOutcome("");
          await onSent();
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3 className="font-semibold">Suggest a feature</h3>
      <label className="simple-small font-medium" htmlFor={`suggest-title-${goal.key}`}>
        Feature name
      </label>
      <input id={`suggest-title-${goal.key}`} autoFocus={focus} required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} className="rounded-lg border border-line bg-bg px-3 py-2" />
      <label className="simple-small font-medium" htmlFor={`suggest-outcome-${goal.key}`}>
        What it does, and for whom
      </label>
      <textarea id={`suggest-outcome-${goal.key}`} required rows={2} maxLength={1000} value={outcome} onChange={(e) => setOutcome(e.target.value)} className="rounded-lg border border-line bg-bg px-3 py-2" />
      <p className="simple-small text-text2" data-testid="suggest-goal">
        Goal: {goal.title}
      </p>
      <p className="simple-small text-text2" data-testid="suggest-decider">
        {/* qa-simple-plan-33: the decider is not told someone else reviews their own suggestion. */}
        {decides ? "You decide on this goal's suggestions: once sent, you can accept it below." : decider ? `${decider} will review your suggestion.` : "The company's owners will review your suggestion."}
      </p>
      <Button type="submit" variant="solid" className="self-start" disabled={busy || !title.trim() || !outcome.trim()}>
        Send suggestion
      </Button>
    </form>
  );
}

/** A person's suggestion: who sent it and when, what it does, the look-alikes; Accept / Reject for the decider. */
function PersonCard({ s, api: a }: { s: GoalSuggestion; api: GoalSuggestionsApi }) {
  const { can } = useMe();
  // PER_ITEM says owners; the suggestion's own can_accept / can_reject (its decider, an approver too) decides.
  const accepts = s.can_accept && can("accept_goal_suggestion", true);
  const rejects = s.can_reject && can("reject_goal_suggestion", true);
  const zone = useCompanyZone();
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    try {
      await f();
    } catch (e) {
      toast({ message: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li data-testid="person-suggestion" data-title={s.title} className="rounded-[var(--simple-card-radius)] border border-line bg-surface p-3 text-[length:var(--simple-small)]">
      <div className="flex flex-col gap-2">
        <div className="min-w-0">
          <p className="text-[length:var(--simple-text)] font-semibold text-text">{s.title}</p>
          <p data-testid="suggestion-outcome">{s.outcome}</p>
          <p className="text-text2" data-testid="suggestion-by">
            From {s.proposed_by_name ?? "someone"} · {zoneDateTime(s.created_at, zone)}
          </p>
          {s.looks_like.map((m) => (
            <LooksLike key={m.id} m={m} merges={rejects} busy={busy} onMerge={() => void run(() => a.reject(s, `Same as ${`${m.code} ${m.title}`.trim()}`))} />
          ))}
        </div>
        {(accepts || rejects) && (
          <span className="flex flex-wrap gap-2">
            {accepts && (
              <Button variant="solid" disabled={busy} onClick={() => void run(() => a.accept(s))}>
                Accept
              </Button>
            )}
            {rejects && (
              <Button disabled={busy} onClick={() => setRejecting(true)}>
                Reject
              </Button>
            )}
          </span>
        )}
      </div>
      {rejecting && (
        <RejectDialog
          s={s}
          onClose={() => setRejecting(false)}
          onReject={(reason) => {
            setRejecting(false);
            void run(() => a.reject(s, reason));
          }}
        />
      )}
    </li>
  );
}

/** Where the drawer opens: the form open (a goal card's "+ Suggest a feature") or Oracle's tab ("✦ Ask Oracle to suggest"). */
export type GoalPanelStart = "form" | "oracle";

/** The drawer's body: the form on top, "Suggest from the chat", then the People and Oracle tabs. */
export function GoalSuggestionList({ goal, api: a, onChat, start }: { goal: GoalBrief; api: GoalSuggestionsApi; onChat?: () => void; start?: GoalPanelStart }) {
  const { can } = useMe();
  const state = goalState(a, goal);
  const { people, oracle } = goalRows(a, goal);
  // qa-simple-plan-10: opened without a start, on the tab that holds the suggestions.
  const [tab, setTab] = useState<"people" | "oracle">(start === "oracle" || (start !== "form" && !people.length && oracle.length > 0) ? "oracle" : "people");
  const [asking, setAsking] = useState(false);
  // qa-simple-roadmap-24/44: "+ Suggest a feature" starts folded the same way it always did;
  // lifted here (not SuggestForm's own state) so the empty state's "Suggest the first feature"
  // can open the same form.
  const [formOpen, setFormOpen] = useState(() => !(start !== "form" && !!state?.can_decide));
  const suggests = can("create_goal_suggestion");
  const tabs = [
    { key: "people" as const, label: `People · ${people.length}` },
    { key: "oracle" as const, label: `✦ Oracle · ${oracle.length}` },
  ];
  return (
    <div data-testid="goal-suggestions" data-goal={goal.key} className="flex flex-col gap-3">
      {suggests && (
        <>
          <SuggestForm goal={state?.goal ?? goal} decider={state?.decider_name ?? null} decides={!!state?.can_decide} open={formOpen} onOpen={() => setFormOpen(true)} focus={start === "form"} onSent={async () => {
            await a.reload();
            setTab("people");
          }} />
          <Button
            variant="secondary"
            data-testid="suggest-from-chat"
            onClick={() => {
              onChat?.();
              askWith(`Suggest a feature for ${(state?.goal ?? goal).title}: `);
            }}
            className="self-start"
          >
            Ask Oracle in the chat
          </Button>
        </>
      )}
      <div role="tablist" aria-label="Who suggested" className="flex gap-1 border-b border-line">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            data-testid={`suggestions-tab-${t.key}`}
            onClick={() => setTab(t.key)}
            className={`-mb-px border-b-2 px-3 py-2 font-semibold ${tab === t.key ? "border-accent text-text" : "border-transparent text-text2 hover:text-text"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "people" ? (
        <div role="tabpanel" aria-label="People's suggestions" className="flex flex-col gap-2">
          {people.length ? (
            <ul className="flex flex-col gap-2">
              {people.map((s) => (
                <PersonCard key={s.id} s={s} api={a} />
              ))}
            </ul>
          ) : (
            <p className="simple-small text-text2">
              No one has suggested a feature for {goal.title} yet.{" "}
              {/* qa-simple-plan-35: "+ Suggest a feature" above is the one control that opens the form. */}
            </p>
          )}
        </div>
      ) : (
        <div role="tabpanel" aria-label="Oracle's suggestions" className="flex flex-col gap-2">
          {suggests && (
            <Button
              className="self-start"
              disabled={asking || !!state?.pending}
              onClick={async () => {
                setAsking(true);
                try {
                  await a.suggest(state?.goal ?? goal);
                } finally {
                  setAsking(false);
                }
              }}
            >
              ✦ Ask Oracle for more
            </Button>
          )}
          {state?.pending && (
            <p role="status" data-testid="suggest-pending" className="simple-small text-accent-ink">
              Oracle is suggesting features…
            </p>
          )}
          {oracle.length ? (
            <ul className="flex flex-col gap-2">
              {oracle.map((s) => (
                <SuggestionCard key={s.id} s={s} api={a} />
              ))}
            </ul>
          ) : (
            !state?.pending && <p className="simple-small text-text2">Oracle suggests only when asked.</p>
          )}
        </div>
      )}
    </div>
  );
}

/** A goal's suggestions drawer: a side panel on a desktop, a bottom sheet on a phone. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The desktop drawer is modal: focus moves into it, Tab and Shift+Tab stay inside it (a dialog
 * opened from it, portalled outside, keeps its own keys), and on close focus goes back.
 */
function useDrawerFocus(open: boolean) {
  const ref = useRef<HTMLElement>(null);
  // The opener as it was before the drawer's own autofocus moved focus in (read while rendering).
  const [first] = useState(() => (typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null));
  useEffect(() => {
    if (!open) return;
    const opener = first;
    const p = ref.current;
    if (p && !p.contains(document.activeElement)) (p.querySelector<HTMLElement>("[autofocus], [data-autofocus]") ?? p).focus();
    const onKey = (e: KeyboardEvent) => {
      const at = document.activeElement;
      if (e.key !== "Tab" || !p) return;
      if (at && at !== document.body && !p.contains(at) && at.closest('[role="dialog"], [role="alertdialog"]')) return;
      const els = [...p.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.checkVisibility());
      if (els.length === 0) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && (at === first || !p.contains(at) || at === p)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || !p.contains(at))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, [open, first]);
  return ref;
}

/**
 * qa-simple-plan-9/36: Escape closes the drawer (a dialog opened over it closes first), focus
 * goes back to the button that opened it (phone and desktop), and the page behind does not scroll
 * (one scrollbar).
 */
function useDrawerClose(onClose: () => void, lock: boolean) {
  const [opener] = useState(() => (typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // A dialog over the drawer (Reject) has its own Escape.
      if (document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length > 1) return;
      e.preventDefault();
      close.current();
    };
    document.addEventListener("keydown", onKey);
    // On <body>, not <html>: a Sheet (the phone's drawer, the chat) saves and restores <html>'s own.
    const body = document.body.style;
    const overflow = body.overflow;
    if (lock) body.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      if (lock) body.overflow = overflow;
      // Back to the opener, unless what closed it (Ask Oracle in the chat) moved focus into another dialog.
      requestAnimationFrame(() => {
        const at = document.activeElement;
        if (opener?.isConnected && (!at || at === document.body)) opener.focus();
      });
    };
  }, [opener, lock]);
}

export function GoalPanel({ goal, api: a, onClose, start }: { goal: GoalBrief; api: GoalSuggestionsApi; onClose: () => void; start?: GoalPanelStart }) {
  const phone = usePhone();
  const drawer = useDrawerFocus(!phone);
  useDrawerClose(onClose, !phone);
  const title = `Suggestions · ${goal.title}`;
  if (phone)
    return (
      <Sheet open title={title} onClose={onClose} testId="goal-panel">
        <div className="p-4">
          <GoalSuggestionList goal={goal} api={a} onChat={onClose} start={start} />
        </div>
      </Sheet>
    );
  return (
    <>
    {/* The page behind dims, as under the move dialog; a click on it closes the drawer. */}
    <div data-testid="goal-panel-backdrop" aria-hidden className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />
    <aside ref={drawer} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} data-testid="goal-panel" className="fixed top-0 right-0 focus:outline-none bottom-0 z-50 w-[480px] max-w-full overflow-y-auto border-l border-line bg-surface p-4 text-text shadow-tip">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="flex-1 text-lg font-semibold">{title}</h2>
        <button type="button" aria-label="Close" onClick={onClose} className="h-8 w-8 rounded text-text2 hover:bg-surface2">
          ×
        </button>
      </div>
      <GoalSuggestionList goal={goal} api={a} onChat={onClose} start={start} />
    </aside>
    </>
  );
}
