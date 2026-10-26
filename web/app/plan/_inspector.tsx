"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

import { AskTeammate } from "@/components/AskTeammate";
import { DateBasisDialog, shortDay, useDateRights } from "@/components/DateBasisDialog";
import { DiscussSubject, type DiscussionSubject } from "@/components/discuss/StartDiscussion";
import { Button, Chip, CodeChip, Inspector, InspectorSection, LinkButton, Notice, Sheet, ToGo } from "@/components/ds";
import { peopleByIds } from "@/components/PersonPicker";
import { RequestSpecDialog, SPEC_STATE, specFor, specHref, useSpecs } from "@/components/RequestSpec";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatDay } from "@/lib/format";
import { useMe } from "@/lib/me";
import { acceptTrackAlertDate, alertDay, alertSentence, keepTrackAlert, listTrackAlerts, reopenTrackAlert, type TrackAlertOut } from "@/lib/api/track-alerts";
import { errorMessage, useQuery } from "@/lib/use-query";

import { WaiveForm } from "../company/strategy/_components/DriftList";
import { shortDate } from "../company/strategy/_components/lib";
import { assess, type GoalView, type Point } from "../home/_goals";
import { dateBasis, HORIZON_LABEL, roadmapHref, stateChip, whoLabel, type PlanDrift, type PlanItem } from "./_lib";

function History({ item }: { item: PlanItem }) {
  const q = useQuery(`plan|history|${item.roadmap.slug}|${item.key}`, () =>
    unwrap(api.GET("/v1/plan/items/history", { params: { query: { roadmap: item.roadmap.slug, item: item.key } } })),
  );
  if (q.error) return <span className="text-text2">{q.error}</span>;
  if (!q.data) return <span className="text-text2">…</span>;
  // One line per import (the API groups and limits them; the tracker's own status name is left out).
  const events = q.data.tracker_events;
  const older = q.data.tracker_events_older;
  if (q.data.versions.length === 0 && events.length === 0) return <span className="text-text2">—</span>;
  return (
    <div className="flex flex-col gap-2">
      {q.data.versions.length > 0 && (
        <ol className="flex flex-col gap-1 text-[15px]">
          {q.data.versions.map((v) => (
            <li key={v.version} className="tnum">
              PRD v{v.prd_version ?? "?"} {HORIZON_LABEL[v.horizon]}
              {v.approved_at ? ` · approved ${formatDay(v.approved_at)}` : ""}
            </li>
          ))}
        </ol>
      )}
      {older > 0 && (
        <p data-testid="plan-tracker-older" className="text-[15px] text-text2">
          {older} earlier tracker {older === 1 ? "update isn't" : "updates aren't"} shown.
        </p>
      )}
      {events.length > 0 && (
        <ol aria-label="Tracker history" className="flex flex-col gap-1 text-[15px]">
          {events.map((e) => (
            <li key={`${e.record_id}|${e.observed_at}|${e.changes.map((c) => c.field).join()}`} data-testid="plan-tracker-event" className="tnum">
              {trackerEventLine(e)}
              <span className="text-text2"> · {formatDay(e.observed_at)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** F2 §2: what one import changed on an issue, in plain words ("ENG-405: Open → In progress, date Nov 30 → Dec 9"). */
function trackerEventLine(e: Schemas["ItemTrackerEvent"]): string {
  return `${e.external_ref}: ${e.changes.map(changeWords).join(", ")}`;
}

function changeWords(c: Schemas["TrackerFieldChange"]): string {
  if (c.field === "target_date") {
    const from = alertDay(c.before);
    const to = alertDay(c.after);
    if (from && to) return `date ${from} → ${to}`;
    if (to) return `date ${to}`;
    return from ? `date removed (was ${from})` : "no date";
  }
  if (c.field === "state") {
    const word = (v: string | null) => (v && v in RECORD_STATE ? RECORD_STATE[v as keyof typeof RECORD_STATE] : (v ?? "none"));
    return `${word(c.before)} → ${word(c.after)}`;
  }
  return `estimate ${c.before ?? "none"} → ${c.after ?? "none"}`;
}

/**
 * F3: the item's date and what it rests on: "Nov 30 ✓ ENG-412, verified by <name>", "Nov 30 ·
 * unverified" with Verify date, or the struck date, "date withdrawn" and the reason with Re-verify date.
 */
function DateLine({ item, onChanged }: { item: PlanItem; onChanged?: () => void }) {
  const { date, date_status } = item.engineering;
  const prd = item.prd?.id;
  const bases = useQuery(`schedule-bases|prd|${prd}`, () => unwrap(api.GET("/v1/schedule-bases", { params: { query: { prd } } })));
  const rights = useDateRights();
  const basis = dateBasis(item, bases.data ?? []);
  const by = basis && (date_status === "withdrawn" ? basis.withdrawn_by : basis.verified_by);
  const [name, setName] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!by) return;
    peopleByIds([by])
      .then((people) => setName(people.get(by)?.name ?? null))
      .catch(() => setName(null));
  }, [by]);
  if (!date) return null;
  const day = shortDay(date);
  const may = !!rights.data?.rights && !!prd;
  const action = date_status === "unverified" ? "Verify date" : date_status === "withdrawn" ? "Re-verify date" : null;
  return (
    <InspectorSection label="Date" testId="plan-date">
      <div className="flex flex-col gap-2 text-[15px]">
        {date_status === "withdrawn" ? (
          <p>
            <s className="tnum">{day}</s> <span className="font-semibold text-warn">date withdrawn</span>
            {basis?.withdrawn_reason && (
              <span className="block text-text2">
                {basis.reference}: {basis.withdrawn_reason}
              </span>
            )}
          </p>
        ) : date_status === "verified" ? (
          <p className="tnum">
            {day} ✓{basis && ` ${basis.reference}, verified by ${name ?? "a member"}`}
          </p>
        ) : (
          <p className="tnum">
            {day} · {date_status ?? "no basis"}
          </p>
        )}
        {action && may && (
          <div>
            <Button onClick={() => setOpen(true)}>{action}</Button>
          </div>
        )}
      </div>
      {open && rights.data && (
        <DateBasisDialog
          prefill={{ prd, supports_date: date, item_key: item.key }}
          rights={rights.data}
          onClose={() => setOpen(false)}
          onSaved={async () => {
            setOpen(false);
            await bases.reload();
            onChanged?.();
          }}
        />
      )}
    </InspectorSection>
  );
}

const RECORD_STATE: Record<PlanItem["engineering"]["records"][number]["state"], string> = {
  todo: "Open",
  in_progress: "In progress",
  done: "Done",
  cancelled: "Cancelled",
  unknown: "Unknown",
};

/** F7 What the actions need: set only for approvers, owners and engineering leads. */
export type PlanLinks = {
  /** Opens Link issue for the item; `term` pre-fills its search (an alert's issue, F2 Link to item). */
  onLink: (item: PlanItem, term?: string) => void;
  onChanged: () => Promise<void> | void;
};

/** The item's tracker issues, one per line; Link issue and Unlink for those who may (F7). */
function Engineering({ item, links }: { item: PlanItem; links?: PlanLinks }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const records = item.engineering.records;
  async function unlink(id: string) {
    setBusy(id);
    setError(null);
    try {
      await unwrap(api.DELETE("/v1/tracker/links/{record_id}", { params: { path: { record_id: id } } }));
      await links?.onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="flex flex-col gap-2">
      {records.length === 0 && <span className="text-[15px] text-text2">No tracker issue</span>}
      {records.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {records.map((r) => (
            <li key={`${r.tracker}|${r.external_ref}`} data-testid="plan-record" className="flex min-w-0 items-center gap-2 text-[15px]">
              <span className="tnum min-w-0 flex-1 truncate">
                {r.url ? (
                  <a href={r.url} target="_blank" rel="noopener noreferrer" className="font-semibold underline-offset-2 hover:underline">
                    {r.external_ref}
                  </a>
                ) : (
                  <b className="font-semibold">{r.external_ref}</b>
                )}
                <span className="text-text2">
                  {` · ${RECORD_STATE[r.state]} · ${r.target_date ? formatDay(r.target_date) : "no date"}`}
                </span>
              </span>
              {links && r.tracker === "github" && r.id && (
                <Button className="flex-none" disabled={busy === r.id} onClick={() => unlink(r.id!)}>
                  Unlink
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {links && item.prd && (
        <Button variant="ghost" className="self-start" onClick={() => links.onLink(item)}>
          + Link issue
        </Button>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

/**
 * F2: one card per open or kept track alert of the item, the alert in one sentence, then the
 * actions the caller may take now (a viewer gets none, so the card has no buttons). Kept
 * alerts say who kept them and why, with Reopen.
 */
function AlertCards({
  item,
  onChanged,
  links,
  track = false,
}: {
  item: PlanItem;
  onChanged?: () => Promise<void> | void;
  links?: PlanLinks;
  /** The track's own alerts (no item: an issue no item names, a newer PRD) instead of the item's. */
  track?: boolean;
}) {
  const trackId = item.track_id;
  const q = useQuery(`plan|alerts|${trackId ?? "none"}`, () => (trackId ? listTrackAlerts({ state: "all", track_id: trackId }) : Promise.resolve([])));
  const shown = (q.data ?? []).filter((a) => (track ? !a.item_key : a.item_key === item.key) && (a.state === "open" || a.state === "kept"));
  if (!trackId || shown.length === 0) return null;
  const cards = shown.map((a) => (
    <AlertCard
      key={`${a.id}-${a.state}`}
      a={a}
      item={item}
      links={links}
      onChanged={async () => {
        await Promise.all([q.reload(), onChanged?.()]);
      }}
    />
  ));
  if (!track) return <>{cards}</>;
  return (
    <InspectorSection label="On this track" testId="plan-track-alerts">
      <div className="flex flex-col gap-2">{cards}</div>
    </InspectorSection>
  );
}

/** G1: what Discuss is about: the item (by its PRD version), else the alert's track. */
function discussionOf(a: TrackAlertOut, item: PlanItem): { subject: DiscussionSubject; key: string; title: string } {
  const prd = item.prd;
  if (a.item_key && prd?.id && prd.version != null) {
    return {
      subject: { kind: "roadmap_item", subject: { document_id: prd.id, version: prd.version, item_key: item.key }, label: `${prd.title} · ${item.title}` },
      key: `roadmap_item:${prd.id}:${item.key}`,
      title: `Discuss ${item.title}`,
    };
  }
  return { subject: { kind: "track", subject: { track_id: a.track_id }, label: a.prd.title }, key: `track:${a.track_id}`, title: `Discuss ${a.prd.title}` };
}

function AlertCard({ a, item, links, onChanged }: { a: TrackAlertOut; item: PlanItem; links?: PlanLinks; onChanged: () => Promise<void> }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keeping, setKeeping] = useState(false);
  const [asking, setAsking] = useState(false);
  const [discussing, setDiscussing] = useState(false);
  const [note, setNote] = useState("");
  const fieldId = useId();
  const blocker = typeof a.data.blocker_id === "string" ? a.data.blocker_id : null;
  const ref = typeof a.data.tracker_ref === "string" ? a.data.tracker_ref : undefined;
  const prdId = item.prd?.id;
  const discussion = discussionOf(a, item);
  async function run(call: () => Promise<unknown>, after?: (out: unknown) => void) {
    setBusy(true);
    setError(null);
    try {
      const out = await call();
      if (after) after(out);
      else await onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const has = (x: TrackAlertOut["actions"][number]) => a.actions.includes(x);
  return (
    <div data-testid="plan-alert" data-kind={a.kind} data-state={a.state} className="flex flex-col gap-2 rounded-lg border border-line bg-surface2 px-3 py-2 text-[15px]">
      <span data-testid="plan-alert-detail">{alertSentence(a)}</span>
      {a.state === "kept" && (
        <span data-testid="plan-alert-kept" className="text-text2">
          Kept by {a.kept_by_name ?? "someone"}
          {a.note ? ` · ${a.note}` : ""}
        </span>
      )}
      {keeping ? (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => keepTrackAlert(a.id, note.trim() || null));
          }}
        >
          <label htmlFor={fieldId} className="text-[13px] leading-4 font-semibold text-text2">
            Note (optional)
          </label>
          <input
            id={fieldId}
            autoFocus
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setKeeping(false)}
            className="h-8 w-full min-w-0 rounded-lg border border-line-strong bg-surface px-2 text-sm"
          />
          <span className="flex flex-wrap gap-1.5">
            <Button type="submit" disabled={busy}>
              Keep watching
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setKeeping(false)}>
              Cancel
            </Button>
          </span>
        </form>
      ) : (
        a.actions.length > 0 && (
          <span className="flex flex-wrap gap-1.5">
            {has("accept_date") && (
              <Button disabled={busy} onClick={() => void run(() => acceptTrackAlertDate(a.id))}>
                Accept new date
              </Button>
            )}
            {has("replan") && (
              <Button
                disabled={busy}
                onClick={() =>
                  void run(
                    () => unwrap(api.POST("/v1/tracks/{track_id}/roadmap-run", { params: { path: { track_id: a.track_id } } })),
                    (r) => router.push(`/runs/${(r as { id: string }).id}`),
                  )
                }
              >
                Re-plan
              </Button>
            )}
            {(has("review") || has("reconcile")) && (
              <Button
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    unwrap(
                      api.POST("/v1/roadmaps/{doc}/items/staleness", {
                        params: { path: { doc: item.roadmap.slug } },
                        body: { action: "review", item_keys: [item.key] },
                      }),
                    ),
                  )
                }
              >
                Review
              </Button>
            )}
            {has("open_blocker") && blocker && (
              <LinkButton href={`/baseline?tab=blockers&blocker=${encodeURIComponent(blocker)}`}>Open blocker</LinkButton>
            )}
            {has("link") && links && item.prd && (
              <Button disabled={busy} onClick={() => links.onLink(item, ref)}>
                Link to item
              </Button>
            )}
            {has("ask") && a.item_key && prdId && (
              <Button disabled={busy} aria-expanded={asking} onClick={() => setAsking((on) => !on)}>
                Ask
              </Button>
            )}
            {has("discuss") && (
              <Button disabled={busy} onClick={() => setDiscussing(true)}>
                Discuss
              </Button>
            )}
            {has("keep") && (
              <Button variant="ghost" disabled={busy} onClick={() => setKeeping(true)}>
                Keep watching
              </Button>
            )}
            {has("reopen") && (
              <Button variant="ghost" disabled={busy} onClick={() => void run(() => reopenTrackAlert(a.id))}>
                Reopen
              </Button>
            )}
          </span>
        )
      )}
      {asking && a.item_key && prdId && (
        <AskTeammate
          subject={{ kind: "roadmap_item", document_id: prdId, item_key: item.key }}
          context={item.title}
          person={a.suggested_assignee}
          onClose={() => setAsking(false)}
        />
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {/* Over the whole page, not inside the inspector's column (the rail would cover it). */}
      {discussing &&
        createPortal(
          <Sheet open title={discussion.title} onClose={() => setDiscussing(false)} testId="plan-discuss-sheet">
            <div className="px-4 py-3">
              <DiscussSubject subject={discussion.subject} subjectKey={discussion.key} />
            </div>
          </Sheet>,
          document.body,
        )}
    </div>
  );
}

/**
 * H4 §5: the item's drift against the approved product strategy, one card per finding. An open
 * finding of an approved item is waived here with a reason (owners; approvers for Outside the
 * strategy); a draft item's is measured on the draft and is waived once the roadmap is approved.
 */
function DriftCards({ item, onChanged }: { item: PlanItem; onChanged?: () => Promise<void> | void }) {
  const drift = item.drift ?? [];
  if (drift.length === 0) return null;
  return (
    <InspectorSection label="Strategy" testId="plan-drift">
      <div className="flex flex-col gap-2">
        {drift.map((d) => (
          <DriftCard key={`${d.kind}-${d.status}`} d={d} onChanged={onChanged} />
        ))}
        <p className="text-sm text-text2">
          Drift is advisory: nothing waits on it.{" "}
          <Link href="/company/strategy" className="font-semibold text-accent-ink underline-offset-2 hover:underline">
            Open the strategy
          </Link>
        </p>
      </div>
    </InspectorSection>
  );
}

/** H1 entry point: who may record a decision records one about this Plan item. */
function RecordDecision({ item }: { item: PlanItem }) {
  const { can } = useMe();
  if (!can("create_decision")) return null;
  const subject = encodeURIComponent(`roadmap_item:${item.id}`);
  return (
    <InspectorSection label="Decisions" testId="plan-decisions">
      <p className="flex flex-wrap gap-3 text-[15px]">
        <Link href={`/company/decisions?subject=${subject}&ref=${encodeURIComponent(item.title)}&propose=1`} className="font-medium text-accent-ink hover:underline">
          Record a decision
        </Link>
        <Link href={`/company/decisions?subject=${subject}&class=all`} className="font-medium text-accent-ink hover:underline">
          Decisions about this item
        </Link>
      </p>
    </InspectorSection>
  );
}

/**
 * F5 lane 3: an approved item's engineering spec: its state and Open, or Request spec for
 * those who may (approvers and owners).
 */
function SpecLine({ item }: { item: PlanItem }) {
  const { can } = useMe();
  const q = useSpecs(item.prd?.slug);
  const [open, setOpen] = useState(false);
  if (!item.prd) return null;
  const spec = q.data ? specFor(q.data, item) : null;
  const state = spec ? SPEC_STATE[spec.state] : null;
  return (
    <InspectorSection label="Engineering spec" testId="plan-spec">
      {q.error ? (
        <span className="text-[15px] text-text2">{q.error}</span>
      ) : !q.data ? (
        <span className="text-text2">…</span>
      ) : spec && state ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-[15px]">
          <Chip kind={state.kind} dot>
            {state.label}
          </Chip>
          <span className="min-w-0 flex-1 break-words">{spec.request.title}</span>
          <LinkButton href={specHref(spec)}>Open</LinkButton>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-[15px]">
          <span className="flex-1 text-text2">No engineering spec yet</span>
          {can("create_spec_request") && <Button onClick={() => setOpen(true)}>Request spec</Button>}
        </div>
      )}
      {open && (
        <RequestSpecDialog
          prd={item.prd.slug}
          items={[{ key: item.key, title: item.title, feature: item.feature, requirements: item.requirements }]}
          initialKey={item.key}
          onClose={() => setOpen(false)}
        />
      )}
    </InspectorSection>
  );
}

function DriftCard({ d, onChanged }: { d: PlanDrift; onChanged?: () => Promise<void> | void }) {
  const { can } = useMe();
  const [waiving, setWaiving] = useState(false);
  const may = d.status === "open" && d.finding_id != null && can("waive_strategy_finding", d.kind === "outside_strategy");
  return (
    <div data-testid="plan-drift-card" data-kind={d.kind} data-state={d.status} className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface2 px-3 py-2 text-[15px]">
      <span>
        <Chip kind={d.status === "waived" ? "na" : d.severity === "high" ? "crit" : "warn"} wrap>
          {d.status === "waived" ? `Waived · ${d.label}` : d.label}
        </Chip>
      </span>
      <span>{d.text}</span>
      {d.status === "waived" && d.waive_reason && (
        <span data-testid="plan-drift-waived" className="text-text2">
          Waived {shortDate(d.waived_at)}: {d.waive_reason}
        </span>
      )}
      {d.status === "open" && d.finding_id == null && <span className="text-sm text-text2">Measured on the draft roadmap. It can be waived once the roadmap is approved.</span>}
      {may && !waiving && (
        <span>
          <Button onClick={() => setWaiving(true)}>Waive…</Button>
        </span>
      )}
      {waiving && d.finding_id && (
        <WaiveForm
          finding={{ id: d.finding_id }}
          onCancel={() => setWaiving(false)}
          onWaived={async () => {
            setWaiving(false);
            await onChanged?.();
          }}
        />
      )}
    </div>
  );
}

/** The selected item (F1 §8): why it needs someone, its history, its goals, and where to open it. */
export function PlanInspector({
  item,
  goals,
  history,
  me,
  onChanged,
  links,
}: {
  item: PlanItem;
  goals: Map<string, GoalView>;
  history: Map<string, Point[]>;
  me: string | null | undefined;
  /** The plan changed from the inspector (F3: a date basis recorded; F2: an alert's
   * action such as Accept new date): the plan reloads. */
  onChanged?: () => Promise<void> | void;
  links?: PlanLinks;
}) {
  const state = stateChip(item);
  const served = item.goal_ids.map((id) => goals.get(id)).filter((g): g is GoalView => !!g);
  const record = item.engineering.records[0];
  const who = whoLabel(item.next.who, me);
  const version = item.prd?.version;
  return (
    <Inspector
      eyebrow="Item · selected"
      title={item.title}
      label={`Item ${item.title}`}
      testId="plan-inspector"
      chips={
        <>
          <Chip hero kind={item.horizon === "now" ? "now" : "na"}>
            {HORIZON_LABEL[item.horizon]}
          </Chip>
          <Chip hero>{state.label}</Chip>
          {version != null && <Chip hero>{item.prd?.approved ? `PRD v${version}` : `Draft ${version}`}</Chip>}
        </>
      }
    >
      <InspectorSection label="Why it needs you" testId="plan-why">
        <div className="flex flex-col gap-2">
          <AlertCards item={item} onChanged={onChanged} links={links} />
          {item.reasons.map((r, n) => (
            <div key={n} className="rounded-lg border border-line bg-surface2 px-3 py-2 text-[15px]">
              {r.detail}
            </div>
          ))}
          {item.next.action ? (
            <p className="text-[15px]">
              <b className="font-semibold">{item.next.label}</b>
              {who && <span className="text-text2"> · {who}</span>}
            </p>
          ) : (
            item.reasons.length === 0 && <p className="text-[15px] text-text2">Nothing to decide</p>
          )}
        </div>
      </InspectorSection>
      <DriftCards item={item} onChanged={onChanged} />
      <AlertCards item={item} onChanged={onChanged} links={links} track />
      <InspectorSection label="Engineering" testId="plan-item-engineering">
        <Engineering item={item} links={links} />
      </InspectorSection>
      {item.origin === "approved" && item.prd?.approved && <SpecLine key={`${item.roadmap.slug}|${item.key}`} item={item} />}
      <DateLine item={item} onChanged={onChanged} />
      <InspectorSection label="History" testId="plan-history">
        <History key={`${item.roadmap.slug}|${item.key}`} item={item} />
      </InspectorSection>
      <InspectorSection label="Goal" testId="plan-item-goal">
        {served.length === 0 ? (
          <span className="font-semibold text-warn">No goal</span>
        ) : (
          <ul className="flex flex-col gap-2">
            {served.map((g) => {
              const p = assess(g, history.get(g.id));
              return (
                <li key={g.id} className="flex min-w-0 items-center gap-2 text-[15px]">
                  <span className="flex min-w-0 flex-1">
                    <CodeChip kind="goal" entityId={g.id} title={g.title} proposed={g.proposed} />
                  </span>
                  <span className="flex-none text-text2">{p.state === "togo" ? <ToGo amount={p.amount!} unit={p.unit} /> : p.text}</span>
                </li>
              );
            })}
          </ul>
        )}
      </InspectorSection>
      <RecordDecision item={item} />
      <InspectorSection>
        <div className="flex flex-wrap gap-2">
          {item.prd?.link && <LinkButton href={item.prd.link}>Open in PRD</LinkButton>}
          <LinkButton href={roadmapHref(item)}>Open in roadmap</LinkButton>
          {record?.url && (
            <a
              href={record.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-10 items-center rounded-button border border-line-strong px-3.5 text-[15px] font-semibold hover:bg-surface2"
            >
              Tracker ↗
            </a>
          )}
        </div>
      </InspectorSection>
    </Inspector>
  );
}
