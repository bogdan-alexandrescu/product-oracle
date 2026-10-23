"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";

import { Button, Chip, Inspector, InspectorRow, InspectorSection } from "@/components/ds";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
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
  presetOf,
  scheduleOf,
  whenText,
  zoneTime,
  type Member,
  type Preset,
  type Ritual,
  type Schedule,
} from "./lib";

function zones(current: string): string[] {
  const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return [...new Set(["UTC", current, ...all])];
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
      {label}
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
 * A ritual's inspector: its schedule, length, lead time, owner and attendees (owners edit,
 * everyone else reads), its recent occurrences, and the owner's Pause or Resume, Prepare now
 * and Delete (custom rituals only; built-ins pause).
 */
export function RitualInspector({
  ritual,
  members,
  canEdit,
  onChanged,
}: {
  ritual: Ritual;
  members: Member[] | undefined;
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
            schedule,
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
          <InspectorRow value={saved.timezone}>Time zone</InspectorRow>
          <InspectorRow value={`${ritual.duration_min} min`}>Length</InspectorRow>
          <InspectorRow value={`${ritual.prep_hours} h before`}>Pre-read ready</InspectorRow>
          <InspectorRow value={ritual.next_due_at ? <span title={zoneTime(ritual.next_due_at, saved.timezone)}>{localTime(ritual.next_due_at)}</span> : "—"}>
            Next
          </InspectorRow>
        </InspectorSection>
        <InspectorSection label="People">
          <InspectorRow value={memberName(members, ritual.owner_id)}>Owner</InspectorRow>
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
            <input type="time" required className={INPUT} value={schedule.time} onChange={(e) => set({ time: e.target.value })} />
          </Field>
          <Field label="Time zone">
            <select className={INPUT} value={schedule.timezone} onChange={(e) => set({ timezone: e.target.value })}>
              {zones(schedule.timezone).map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Length (minutes)">
            <input type="number" min={5} max={480} required className={INPUT} value={duration} onChange={(e) => setDuration(e.target.value)} />
          </Field>
          <Field label="Pre-read lead time (hours)">
            <input type="number" min={0} max={168} required className={INPUT} value={prep} onChange={(e) => setPrep(e.target.value)} />
          </Field>
          <Field label="Owner">
            <select className={INPUT} value={owner} onChange={(e) => setOwner(e.target.value)}>
              {active.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.email}
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
                  <span className="truncate">{m.email}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="col-span-2 flex flex-wrap gap-2 max-[600px]:col-span-1">
            <Button type="submit" variant="solid" disabled={busy}>
              Save
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                act(async () => {
                  const o = await unwrap(api.POST("/v1/rituals/{ritual_id}/prepare", path));
                  await onChanged();
                  router.push(`/company/rituals/${o.id}`);
                })
              }
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
