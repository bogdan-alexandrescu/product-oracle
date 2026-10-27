"use client";

import { useEffect, useState } from "react";

import { Button, Sheet, toast } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import { FlowDetail, FlowThumb } from "./Flow";

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
      else toast({ message: `Proposed ${s.title}: it waits for the decider` });
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
      <div className="flex flex-wrap items-start gap-3">
        {s.flow ? (
          <button type="button" aria-label={`Open the flow for ${s.title}`} onClick={() => setWide(!wide)} className="flex-none rounded-md border border-line bg-surface p-1" data-testid="flow-thumb">
            <FlowThumb flow={s.flow} />
          </button>
        ) : (
          <span className="flex-none rounded-md border border-dashed border-line px-2 py-1 text-text2" data-testid="flow-none">
            No flow yet
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2">
            <span className="text-[length:var(--simple-text)] font-semibold text-text">{s.title}</span>
            <span className="rounded-full bg-surface2 px-2 text-text2">{s.origin === "auto" ? "Oracle suggested" : "Asked for"}</span>
          </p>
          <p data-testid="suggestion-outcome">{s.outcome}</p>
          <p className="text-text2" data-testid="suggestion-why">
            Why: {s.why}
          </p>
          {s.evidence.length > 0 && (
            <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1" data-testid="suggestion-evidence" aria-label="Evidence">
              {s.evidence.map((e) => (
                <li key={e.label} className="flex items-center gap-1.5">
                  {e.url ? (
                    <a href={e.url} className="text-accent-ink underline">
                      {e.label}
                    </a>
                  ) : (
                    <span>{e.label}</span>
                  )}
                  <span className={`rounded-full px-1.5 text-xs ${CONFIDENCE[e.confidence] ?? ""}`}>{e.confidence} confidence</span>
                </li>
              ))}
            </ul>
          )}
          {s.looks_like.map((m) => (
            <p key={m.id} className="mt-1 text-warn" data-testid="suggestion-looks-like">
              Looks like {m.code} {m.title}
            </p>
          ))}
        </div>
        {(s.can_accept || s.can_reject) && (
          <span className="flex flex-none gap-2">
            {s.can_accept && (
              <Button variant="solid" disabled={busy} onClick={() => void run(() => a.accept(s))}>
                Accept
              </Button>
            )}
            {s.can_reject && (
              <Button disabled={busy} onClick={() => setRejecting(true)}>
                Reject
              </Button>
            )}
          </span>
        )}
      </div>
      {wide && !phone && s.flow && <FlowDetail flow={s.flow} />}
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

/** One goal's open suggestions, its "Suggest features" button and the pending line. */
export function GoalSuggestionList({ goal, api: a, emptyWords }: { goal: GoalBrief; api: GoalSuggestionsApi; emptyWords?: string }) {
  const { can } = useMe();
  const state = a.data?.goals.find((g) => g.goal.id === goal.id || g.goal.key === goal.key);
  const rows = (a.data?.suggestions ?? []).filter((s) => s.goal.id === goal.id || s.goal.key === goal.key);
  const [asking, setAsking] = useState(false);
  return (
    <div data-testid="goal-suggestions" data-goal={goal.key} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[length:var(--simple-small)] text-text2">
          {rows.length ? `${rows.length} suggested ${rows.length === 1 ? "feature" : "features"}` : (emptyWords ?? "No suggested features.")}
          {state?.empty && " · no items yet"}
        </span>
        {can("create_simple_change") && (
          <Button
            className="ml-auto"
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
            Suggest features
          </Button>
        )}
      </div>
      {state?.pending && (
        <p role="status" data-testid="suggest-pending" className="text-[length:var(--simple-small)] text-accent-ink">
          Oracle is suggesting features…
        </p>
      )}
      {rows.length > 0 && (
        <ul className="flex flex-col gap-2">
          {rows.map((s) => (
            <SuggestionCard key={s.id} s={s} api={a} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** A goal's suggestions in a panel: a side panel on a desktop, a bottom sheet on a phone. */
export function GoalPanel({ goal, api: a, onClose }: { goal: GoalBrief; api: GoalSuggestionsApi; onClose: () => void }) {
  const phone = usePhone();
  const title = `Suggested features · ${goal.title}`;
  if (phone)
    return (
      <Sheet open title={title} onClose={onClose} testId="goal-panel">
        <div className="p-4">
          <GoalSuggestionList goal={goal} api={a} />
        </div>
      </Sheet>
    );
  return (
    <aside role="dialog" aria-label={title} data-testid="goal-panel" className="fixed top-0 right-0 bottom-0 z-50 w-[480px] overflow-y-auto border-l border-line bg-surface p-4 text-text shadow-tip">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="flex-1 text-lg font-semibold">{title}</h2>
        <button type="button" aria-label="Close" onClick={onClose} className="h-8 w-8 rounded text-text2 hover:bg-surface2">
          ×
        </button>
      </div>
      <GoalSuggestionList goal={goal} api={a} />
    </aside>
  );
}
