"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";

import { Button, Chip, Inspector, InspectorRow, InspectorSection, confirmInPage } from "@/components/ds";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { formatMoney } from "@/lib/format";
import { errorMessage, useQuery } from "@/lib/use-query";

import {
  MONTHS,
  PRESETS,
  STATE_KIND,
  STATE_LABEL,
  WEEKDAYS,
  WEEKS,
  localDate,
  localTime,
  memberName,
  personEmail,
  personName,
  presetOf,
  ruleOf,
  scheduleOf,
  whenText,
  timeOptions,
  zoneText,
  zoneTime,
  type Member,
  type Person,
  type Preset,
  type Ritual,
  type Schedule,
} from "./lib";

/** A labelled input; labels sit at the top and the inputs at the bottom of their row, so a label that wraps does not push its input below its neighbour's (qa-company-26). */
function Field({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <label className={`flex flex-col justify-between gap-1 text-sm font-semibold text-text2 ${wide ? "col-span-2 max-[600px]:col-span-1" : ""}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}

/** A schedule from the picker's preset and fields. */
function withPreset(s: Schedule, preset: Preset): Schedule {
  if (preset === "every_2_weeks") return { ...s, freq: "every_n_weeks", interval: 2 };
  if (preset === "every_n_weeks") return { ...s, freq: "every_n_weeks", interval: s.interval >= 2 ? s.interval : 3 };
  if (preset === "quarterly") return { ...s, freq: preset, month: Math.min(s.month, 3) };
  return { ...s, freq: preset };
}

/**
 * What Prepare now does, asked before it does it (qa-company-1), when it spends money (the
 * baseline build, or a summary on Every pre-read) or the ritual is paused; else null.
 */
export function prepareAsk(r: Ritual): string | null {
  const usd = r.prepare_usd ?? null;
  const paused = r.status !== "active";
  if (!usd && !paused) return null;
  const what = r.kind === "baseline_rebuild" ? "starts the baseline build" : "writes its summary";
  const cost = usd ? `, then ${what}: one Oracle run of about ${formatMoney(usd)}` : "";
  const still = paused ? `${r.title} is paused; it stays paused. ` : "";
  const waits = usd && r.kind === "baseline_rebuild" && usd > 50 ? " Over $50 it waits for an owner's approval." : "";
  return `${still}Oracle builds the pre-read now and puts it in the attendees' Inbox${cost}.${waits}`;
}

/**
 * A ritual's inspector: its schedule, length, lead time, owner and attendees (owners edit,
 * everyone else reads), its recent occurrences, and the owner's Pause or Resume, Prepare now
 * and Delete (custom rituals only; built-ins pause).
 */
export function RitualInspector({
  ritual,
  members,
  people,
  zoneDefault = false,
  canEdit,
  onChanged,
}: {
  ritual: Ritual;
  members: Member[] | undefined;
  people: Person[] | undefined;
  /** No owner chose the Company time zone yet: the default is used meanwhile (qa-company-24). */
  zoneDefault?: boolean;
  canEdit: boolean;
  onChanged: (r?: Ritual) => Promise<void>;
}) {
  const router = useRouter();
  const saved = useMemo(() => scheduleOf(ritual.schedule), [ritual.schedule]);
  const [schedule, setSchedule] = useState<Schedule>(saved);
  const [duration, setDuration] = useState(String(ritual.duration_min));
  const [prep, setPrep] = useState(String(ritual.prep_hours));
  const [owner, setOwner] = useState(ritual.owner_id);
  const [attendees, setAttendees] = useState<string[]>(ritual.attendee_ids);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const occurrencesQ = useQuery(`ritual-occurrences|${ritual.id}|${ritual.lock_version}`, () =>
    unwrap(api.GET("/v1/rituals/{ritual_id}/occurrences", { params: { path: { ritual_id: ritual.id }, query: { limit: 20 } } })),
  );
  const active = (members ?? []).filter((m) => m.status !== "disabled");
  const preset = presetOf(schedule);
  const set = (patch: Partial<Schedule>) => setSchedule((s) => ({ ...s, ...patch }));
  // Save is offered once something changed (qa-company-30): until then it says so.
  const edits = (sc: Schedule, d: string, p: string, o: typeof owner, a: string[]) => JSON.stringify([ruleOf(sc), d, p, o, [...a].sort()]);
  const changed =
    edits(schedule, duration, prep, owner, attendees) !==
    edits(saved, String(ritual.duration_min), String(ritual.prep_hours), ritual.owner_id, ritual.attendee_ids);

  async function act(call: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await call();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const path = { params: { path: { ritual_id: ritual.id } } };

  const save = () =>
    act(async () => {
      const r = await unwrap(
        api.PATCH("/v1/rituals/{ritual_id}", {
          ...path,
          body: {
            lock_version: ritual.lock_version,
            schedule: ruleOf(schedule),
            duration_min: Number(duration),
            prep_hours: Number(prep),
            owner_id: owner,
            attendee_ids: attendees,
          },
        }),
      );
      await onChanged(r);
    });

  const recent = (
    <InspectorSection label="Recent occurrences" testId="ritual-occurrences">
      {occurrencesQ.data?.length === 0 && <p className="text-sm text-text2">No pre-read yet</p>}
      <ul className="flex flex-col">
        {(occurrencesQ.data ?? []).map((o) => (
          <li key={o.id}>
            <InspectorRow
              value={
                <Chip kind={STATE_KIND[o.status]} dot>
                  {STATE_LABEL[o.status]}
                </Chip>
              }
            >
              <Link href={`/company/rituals/${o.id}`} className="hover:underline" title={zoneTime(o.due_at, saved.timezone)}>
                {localDate(o.due_at)}
              </Link>
            </InspectorRow>
          </li>
        ))}
      </ul>
    </InspectorSection>
  );

  const chips = (
    <Chip hero kind={ritual.status === "active" ? "now" : "na"}>
      {ritual.status === "active" ? "On" : "Paused"}
    </Chip>
  );

  if (!canEdit) {
    return (
      <Inspector eyebrow="Ritual · selected" title={ritual.title} chips={chips} testId="ritual-inspector">
        <InspectorSection label="Schedule">
          <InspectorRow value={whenText(saved)}>When</InspectorRow>
          <InspectorRow value={<span data-testid="ritual-zone">{zoneText(saved.timezone, zoneDefault)}</span>}>Time zone</InspectorRow>
          <InspectorRow value={`${ritual.duration_min} min`}>Length</InspectorRow>
          <InspectorRow value={`${ritual.prep_hours} h before`}>Pre-read ready</InspectorRow>
          <InspectorRow value={ritual.next_due_at ? <span title={zoneTime(ritual.next_due_at, saved.timezone)}>{localTime(ritual.next_due_at)}</span> : "—"}>
            Next
          </InspectorRow>
        </InspectorSection>
        <InspectorSection label="People">
          <InspectorRow value={<span title={personEmail(people, ritual.owner_id)}>{personName(people, ritual.owner_id)}</span>}>Owner</InspectorRow>
          <InspectorRow value={ritual.attendee_ids.length}>Attendees</InspectorRow>
        </InspectorSection>
        {recent}
      </Inspector>
    );
  }

  const weekField = preset === "monthly" || preset === "quarterly" || preset === "yearly";
  return (
    <Inspector
      eyebrow="Ritual · selected"
      title={ritual.title}
      chips={chips}
      testId="ritual-inspector"
      action={
        <Button
          variant="hero"
          disabled={busy}
          onClick={() =>
            act(async () => {
              const r = await unwrap(api.POST(ritual.status === "active" ? "/v1/rituals/{ritual_id}/pause" : "/v1/rituals/{ritual_id}/resume", path));
              await onChanged(r);
            })
          }
        >
          {ritual.status === "active" ? "Pause" : "Resume"}
        </Button>
      }
    >
      {error && (
        <div className="px-5 pt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      <InspectorSection label="Schedule">
        <form
          aria-label="Schedule"
          className="grid grid-cols-2 gap-3 max-[600px]:grid-cols-1"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field label="Repeats">
            <select className={INPUT} value={preset} onChange={(e) => setSchedule((s) => withPreset(s, e.target.value as Preset))}>
              {PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
          {preset === "every_n_weeks" && (
            <Field label="Every N weeks">
              <input type="number" min={2} max={12} className={INPUT} value={schedule.interval} onChange={(e) => set({ interval: Number(e.target.value) })} />
            </Field>
          )}
          {weekField && (
            <Field label="Week of the month">
              <select className={INPUT} value={schedule.week_of_month} onChange={(e) => set({ week_of_month: Number(e.target.value) })}>
                {WEEKS.map((w) => (
                  <option key={w.value} value={w.value}>
                    {w.label}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Day">
            <select className={INPUT} value={schedule.weekday} onChange={(e) => set({ weekday: Number(e.target.value) })}>
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </Field>
          {preset === "quarterly" && (
            <Field label="Month of the quarter">
              <select className={INPUT} value={schedule.month} onChange={(e) => set({ month: Number(e.target.value) })}>
                {["First", "Second", "Third"].map((m, i) => (
                  <option key={m} value={i + 1}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {preset === "yearly" && (
            <Field label="Month">
              <select className={INPUT} value={schedule.month} onChange={(e) => set({ month: Number(e.target.value) })}>
                {MONTHS.map((m, i) => (
                  <option key={m} value={i + 1}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Time">
            {/* The page's one time format, "9:00 AM" (qa-company-25), not the browser's "09:00 AM". */}
            <select required aria-label="Time" className={INPUT} value={schedule.time} onChange={(e) => set({ time: e.target.value })}>
              {timeOptions(schedule.time).map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          {/* One zone (owner decision 2026-10-22): every ritual is in the Company time zone. */}
          <p className="col-span-2 self-center text-sm text-text2 max-[600px]:col-span-1">
            Company time zone: <span data-testid="ritual-zone">{zoneText(saved.timezone, zoneDefault)}</span>{" "}
            <Link href="/settings/company#timezone" className="font-semibold text-accent-ink hover:underline">
              Change
            </Link>
          </p>
          <Field label="Length (minutes)">
            <input type="number" min={5} max={480} required className={INPUT} value={duration} onChange={(e) => setDuration(e.target.value)} />
          </Field>
          <Field label="Pre-read lead time (hours)">
            <input type="number" min={0} max={168} required className={INPUT} value={prep} onChange={(e) => setPrep(e.target.value)} />
          </Field>
          {/* Names, as the table's Owner column has them; the email second (qa-company-26/28). */}
          <Field label="Owner" wide>
            <select className={INPUT} value={owner} onChange={(e) => setOwner(e.target.value)}>
              {active.map((m) => (
                <option key={m.id} value={m.id}>
                  {memberName(m)} · {m.email}
                </option>
              ))}
            </select>
          </Field>
          <fieldset className="col-span-2 max-[600px]:col-span-1">
            <legend className="mb-1 text-sm font-semibold text-text2">Attendees</legend>
            <div className="flex flex-col gap-1">
              {active.map((m) => (
                <label key={m.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={attendees.includes(m.id)}
                    onChange={(e) => setAttendees((a) => (e.target.checked ? [...a, m.id] : a.filter((x) => x !== m.id)))}
                  />
                  <span className="min-w-0 break-words">
                    {memberName(m)} <span className="text-text2">· {m.email}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="col-span-2 flex flex-wrap gap-2 max-[600px]:col-span-1">
            <span className="flex items-center gap-2">
              <Button type="submit" variant="solid" disabled={busy || !changed} title={changed ? undefined : "No changes to save"}>
                Save
              </Button>
              {!changed && (
                <span className="text-sm text-text2" data-testid="ritual-no-changes">
                  No changes
                </span>
              )}
            </span>
            <Button
              disabled={busy}
              onClick={async () => {
                // qa-company-1: a Prepare now that spends money, or on a paused ritual, asks first.
                const ask = prepareAsk(ritual);
                if (ask && !(await confirmInPage({ action: "Prepare now", message: ask }))) return;
                await act(async () => {
                  const o = await unwrap(api.POST("/v1/rituals/{ritual_id}/prepare", path));
                  await onChanged();
                  router.push(`/company/rituals/${o.id}`);
                });
              }}
            >
              Prepare now
            </Button>
            {!ritual.builtin && (
              <Button
                variant="danger"
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    await unwrap(api.DELETE("/v1/rituals/{ritual_id}", path));
                    await onChanged();
                  })
                }
              >
                Delete
              </Button>
            )}
          </div>
        </form>
      </InspectorSection>
      {recent}
    </Inspector>
  );
}
