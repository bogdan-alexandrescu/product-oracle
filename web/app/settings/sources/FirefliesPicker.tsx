"use client";

import { type ReactNode, useEffect, useId, useMemo, useState } from "react";

import { Button, Chip, InfoTip, Label, Notice, SegmentedControl } from "@/components/ds";
import { api, type Schemas, unwrap } from "@/lib/api/client";
import { errorMessage, useAuthRedirect, useQuery } from "@/lib/use-query";

import { INPUT } from "../_components/fields";

type Meeting = Schemas["FirefliesMeetingOut"];
type Series = Schemas["FirefliesSeriesOut"];

/** A Fireflies source's config as the picker saves it (api: oracle/sources/connectors/fireflies.py). */
export type FirefliesConfig = {
  mode: "all" | "selected";
  date_from?: string;
  date_to?: string;
  series: string[];
  meetings: string[];
  /** What the picker showed for each picked series key and meeting id. */
  labels?: Record<string, string>;
};

// The most a source picks, and the longest label kept (as the API checks them:
// MAX_SERIES, MAX_MEETINGS and MAX_LABEL in oracle/sources/connectors/fireflies.py).
export const MAX_SERIES = 200;
export const MAX_MEETINGS = 2000;
const MAX_LABEL = 500;

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "") : [];
}

/**
 * Reads a source's config. One saved before the picker (no `mode`) is a title rule:
 * all meetings since `from_date` whose title contains one of the strings. It opens on
 * choosing with nothing picked, so saving it as it opens cannot widen it to every meeting.
 */
export function readFirefliesConfig(config: Record<string, unknown>): { value: FirefliesConfig; titleRule: string[] | null } {
  if (config.mode === "all" || config.mode === "selected") {
    return {
      value: {
        mode: config.mode,
        date_from: typeof config.date_from === "string" ? config.date_from : undefined,
        date_to: typeof config.date_to === "string" ? config.date_to : undefined,
        series: strings(config.series),
        meetings: strings(config.meetings),
        labels: (config.labels as Record<string, string> | undefined) ?? {},
      },
      titleRule: null,
    };
  }
  const rule = [...strings(config.title_contains), ...strings(config.meetings)];
  return {
    value: {
      mode: rule.length ? "selected" : "all",
      date_from: typeof config.from_date === "string" ? config.from_date.slice(0, 10) : undefined,
      series: [],
      meetings: [],
      labels: {},
    },
    titleRule: rule.length ? rule : null,
  };
}

/** The config to save: empty dates dropped, labels only for what is picked. */
export function firefliesConfigToSave(c: FirefliesConfig): Record<string, unknown> {
  const picked = c.mode === "selected";
  const keep = new Set(picked ? [...c.series, ...c.meetings] : []);
  return {
    mode: c.mode,
    ...(c.date_from ? { date_from: c.date_from } : {}),
    ...(c.date_to ? { date_to: c.date_to } : {}),
    series: picked ? c.series : [],
    meetings: picked ? c.meetings : [],
    labels: Object.fromEntries(Object.entries(c.labels ?? {}).filter(([k]) => keep.has(k))),
  };
}

export function firefliesReady(c: FirefliesConfig): boolean {
  if (c.mode === "all") return true;
  const picked = c.series.length + c.meetings.length;
  return picked > 0 && c.series.length <= MAX_SERIES && c.meetings.length <= MAX_MEETINGS;
}

function shortDay(day: string): string {
  const d = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear();
  // A no-break space keeps "Sep 1" on one line.
  return d
    .toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" })
    .replace(" ", "\u00a0");
}

/** "Sep 1 – Oct 31" · "since Sep 1" · "until Oct 31" · "". */
export function firefliesRange(c: Pick<FirefliesConfig, "date_from" | "date_to">): string {
  if (c.date_from && c.date_to) return `${shortDay(c.date_from)} – ${shortDay(c.date_to)}`;
  if (c.date_from) return `since ${shortDay(c.date_from)}`;
  if (c.date_to) return `until ${shortDay(c.date_to)}`;
  return "";
}

/** "All meetings since Sep 1" · "2 series, 5 meetings, since Sep 1". */
export function firefliesSummary(c: FirefliesConfig): string {
  const range = firefliesRange(c);
  if (c.mode === "all") return range ? `All meetings ${range}` : "All meetings";
  const parts = [
    ...(c.series.length ? [`${c.series.length} series`] : []),
    ...(c.meetings.length ? [`${c.meetings.length} meeting${c.meetings.length === 1 ? "" : "s"}`] : []),
  ];
  if (!parts.length) return "Nothing picked yet";
  return [...parts, ...(range ? [range] : [])].join(", ");
}

function dayHeading(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
}

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

type MeetingState = { key: string; rows: Meeting[]; next: string | null; loading: boolean; error: string | null };

/** Pages of the connection's meetings for the current search and range. */
function useMeetings(connectionId: string, search: string, from?: string, to?: string, enabled = true) {
  const onAuth = useAuthRedirect();
  const key = `${connectionId}|${search}|${from ?? ""}|${to ?? ""}`;
  const [state, setState] = useState<MeetingState>({ key: "", rows: [], next: null, loading: false, error: null });

  async function load(cursor: string | null, reset: boolean) {
    setState((s) => ({ ...s, key, loading: true, error: null, ...(reset ? { rows: [], next: null } : {}) }));
    try {
      const page = await unwrap(
        api.GET("/v1/connections/{connection_id}/fireflies/meetings", {
          params: {
            path: { connection_id: connectionId },
            query: { search: search || undefined, from: from || undefined, to: to || undefined, cursor: cursor ?? undefined },
          },
        }),
      );
      setState((s) =>
        s.key !== key ? s : { key, rows: reset ? page.meetings : [...s.rows, ...page.meetings], next: page.next_cursor ?? null, loading: false, error: null },
      );
    } catch (e) {
      if (!onAuth(e)) setState((s) => (s.key !== key ? s : { ...s, loading: false, error: errorMessage(e) }));
    }
  }

  useEffect(() => {
    if (enabled) void load(null, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  return { ...state, more: () => (state.next ? load(state.next, false) : undefined) };
}

const LIST = "flex max-h-[360px] flex-col overflow-y-auto rounded-button border border-line bg-surface";
const ROW =
  "flex min-h-11 cursor-pointer items-center gap-2.5 border-t border-line px-3 py-1.5 first:border-t-0 hover:bg-surface2 has-[:disabled]:cursor-default";
const CHECK = "size-4 flex-none accent-accent";

function Section({ title, count, children, action }: { title: string; count?: number; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2" aria-label={title}>
      <div className="flex min-h-9 items-center gap-2">
        <h3 className="text-[15px] font-semibold">{title}</h3>
        {count != null && <span className="tnum text-sm text-text2">{count}</span>}
        <span className="ml-auto flex items-center">{action}</span>
      </div>
      {children}
    </section>
  );
}

export function FirefliesPicker({
  connectionId,
  value,
  onChange,
  titleRule,
}: {
  connectionId: string;
  value: FirefliesConfig;
  onChange: (next: FirefliesConfig) => void;
  /** The legacy title rule of the source being edited, shown until it is saved again. */
  titleRule?: string[] | null;
}) {
  const ids = useId();
  const choosing = value.mode === "selected";
  const ongoing = !value.date_to;
  const [search, setSearch] = useState("");
  const query = useDebounced(search.trim());
  // Typing a date changes it on every keystroke (0002, 0020, 0202, 2026): the lists
  // follow once it settles.
  const from = useDebounced(value.date_from, 400);
  const to = useDebounced(value.date_to, 400);
  const labels = useMemo(() => value.labels ?? {}, [value.labels]);

  const set = (patch: Partial<FirefliesConfig>) => onChange({ ...value, ...patch });

  const series = useQuery(`ff-series|${connectionId}|${from ?? ""}|${to ?? ""}|${choosing}`, () =>
    choosing
      ? unwrap(
          api.GET("/v1/connections/{connection_id}/fireflies/series", {
            params: { path: { connection_id: connectionId }, query: { from: from || undefined, to: to || undefined } },
          }),
        )
      : Promise.resolve(null),
  );
  const meetings = useMeetings(connectionId, query, from, to, choosing);

  const pickedSeries = useMemo(() => new Set(value.series), [value.series]);
  const pickedMeetings = useMemo(() => new Set(value.meetings), [value.meetings]);

  // Calendar series with 2+ meetings, plus picked ones the list no longer shows. A
  // meeting on no calendar is in no series: only picking it takes it.
  const seriesRows: Series[] = useMemo(() => {
    const listed = series.data?.series ?? [];
    const rows = listed.filter((s) => s.meeting_count > 1 || pickedSeries.has(s.key));
    const shown = new Set(rows.map((s) => s.key));
    for (const key of value.series) {
      if (!shown.has(key)) rows.push({ key, title: labels[key] ?? "Picked series", meeting_count: 0, last_date: null, organizer: null });
    }
    return rows;
  }, [series.data, pickedSeries, value.series, labels]);

  const groups = useMemo(() => {
    const byDay = new Map<string, Meeting[]>();
    for (const m of meetings.rows) {
      const day = m.date ? m.date.slice(0, 10) : "";
      byDay.set(day, [...(byDay.get(day) ?? []), m]);
    }
    return [...byDay.entries()];
  }, [meetings.rows]);
  const listedIds = new Set(meetings.rows.map((m) => m.id));
  const earlier = query ? [] : value.meetings.filter((id) => !listedIds.has(id));

  const seriesFull = value.series.length >= MAX_SERIES;
  const meetingsFull = value.meetings.length >= MAX_MEETINGS;

  function toggleSeries(s: Series, on: boolean) {
    const nextSeries = on ? [...value.series, s.key] : value.series.filter((k) => k !== s.key);
    // A meeting picked on its own is covered once its series is picked.
    const covered = new Set(meetings.rows.filter((m) => m.series_key === s.key).map((m) => m.id));
    set({
      series: nextSeries,
      meetings: on ? value.meetings.filter((id) => !covered.has(id)) : value.meetings,
      labels: { ...labels, [s.key]: s.title.slice(0, MAX_LABEL) },
    });
  }

  function toggleMeeting(m: { id: string; title: string }, on: boolean) {
    set({
      meetings: on ? [...value.meetings, m.id] : value.meetings.filter((id) => id !== m.id),
      labels: { ...labels, [m.id]: m.title.slice(0, MAX_LABEL) },
    });
  }

  return (
    <div className="@container flex min-w-0 flex-col gap-3" data-testid="fireflies-picker">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div className="flex flex-col gap-1.5">
          <Label>Include</Label>
          <SegmentedControl
            label="Meetings to include"
            value={value.mode}
            onChange={(mode) => set({ mode })}
            items={[
              { value: "all", label: "All meetings" },
              { value: "selected", label: "Choose" },
            ]}
          />
        </div>
        <div className="flex flex-wrap items-end gap-2.5">
          <label className="flex flex-col gap-1.5">
            <Label>From</Label>
            <input
              type="date"
              value={value.date_from ?? ""}
              max={value.date_to || undefined}
              onChange={(e) => set({ date_from: e.target.value || undefined })}
              className={`${INPUT} w-[160px]`}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <Label>To</Label>
            <input
              type="date"
              value={value.date_to ?? ""}
              min={value.date_from || undefined}
              disabled={ongoing}
              onChange={(e) => set({ date_to: e.target.value || undefined })}
              className={`${INPUT} w-[160px]`}
            />
          </label>
          <label className="flex h-9 items-center gap-2 text-[15px]">
            <input
              type="checkbox"
              className={CHECK}
              checked={ongoing}
              onChange={(e) => set({ date_to: e.target.checked ? undefined : new Date().toISOString().slice(0, 10) })}
            />
            Ongoing
          </label>
          <span className="flex h-9 items-center gap-1 text-sm text-text2" data-testid="fireflies-timezone">
            UTC
            <InfoTip label="time zone" align="end">
              Dates are whole days in UTC, and meeting times are shown in UTC: Oracle does not know your time zone.
            </InfoTip>
          </span>
        </div>
      </div>

      <div className="flex min-h-9 items-center gap-2 rounded-button bg-surface2 px-3 py-1.5">
        <Label className="hidden flex-none @[520px]:inline">Includes</Label>
        <span className="tnum min-w-0 flex-1 text-[15px] font-semibold" data-testid="fireflies-summary" aria-live="polite">
          {firefliesSummary(value)}
        </span>
        <InfoTip label="what a sync takes" align="end">
          A series is a recurring calendar event: it takes its past meetings and every future one, and new meetings arrive on
          the next sync. A meeting on no calendar is in no series; pick it on its own. Saving a narrower date range removes the
          meetings outside it at once; a meeting or series you drop is removed on the next sync.
        </InfoTip>
      </div>

      {titleRule && (
        <div className="flex flex-wrap items-center gap-2" data-testid="title-rule">
          <Chip kind="warn">Title rule</Chip>
          <span className="min-w-0 text-[15px]">{titleRule.map((t) => `“${t}”`).join(", ")}</span>
          <InfoTip label="title rule" align="end">
            Saved before meetings could be picked: all meetings whose title contains one of these. Saving replaces it with the
            choice above.
          </InfoTip>
        </div>
      )}

      {choosing && (
        <div className="grid min-w-0 gap-4 @[700px]:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <Section title="Series" count={series.data ? seriesRows.length : undefined}>
            {series.error && <Notice tone="error">{series.error}</Notice>}
            {!series.data && !series.error && <span className="block h-11 animate-pulse rounded-button bg-surface2" aria-busy />}
            {series.data && seriesRows.length === 0 && <p className="px-1 text-[15px] text-text2">No recurring meetings</p>}
            {seriesFull && (
              <Notice testId="fireflies-series-cap">
                {MAX_SERIES} series picked, the most a source takes: unpick one to pick another.
              </Notice>
            )}
            {seriesRows.length > 0 && (
              <ul className={LIST} aria-label="Series">
                {seriesRows.map((s) => (
                  <li key={s.key}>
                    <label className={ROW}>
                      <input
                        type="checkbox"
                        className={CHECK}
                        checked={pickedSeries.has(s.key)}
                        disabled={seriesFull && !pickedSeries.has(s.key)}
                        onChange={(e) => toggleSeries(s, e.target.checked)}
                        aria-label={s.title}
                      />
                      <span className="min-w-0 flex-1 truncate text-[15px] font-medium" title={s.title}>
                        {s.title}
                      </span>
                      {s.meeting_count > 0 && (
                        <span
                          className="tnum flex-none text-sm text-text2"
                          title={`${s.meeting_count} meetings${s.last_date ? `, last ${shortDay(s.last_date)}` : ""}`}
                        >
                          {s.meeting_count} · {s.last_date ? shortDay(s.last_date) : "—"}
                        </span>
                      )}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Meetings" count={value.meetings.length || undefined}>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search titles"
              aria-label="Search meetings"
              className={INPUT}
            />
            {meetings.error && <Notice tone="error">{meetings.error}</Notice>}
            {meetingsFull && (
              <Notice testId="fireflies-meetings-cap">
                {MAX_MEETINGS.toLocaleString("en-US")} meetings picked, the most a source takes: unpick one, or pick its
                series instead.
              </Notice>
            )}
            <div className={LIST} role="group" aria-label="Meetings" aria-busy={meetings.loading}>
              {earlier.length > 0 && (
                <MeetingGroup heading="Picked earlier" id={`${ids}-earlier`}>
                  {earlier.map((id) => (
                    <MeetingRow
                      key={id}
                      title={labels[id] ?? id}
                      checked
                      onChange={(on) => toggleMeeting({ id, title: labels[id] ?? id }, on)}
                    />
                  ))}
                </MeetingGroup>
              )}
              {groups.map(([day, rows]) => (
                <MeetingGroup key={day} heading={day ? dayHeading(rows[0].date!) : "Undated"} id={`${ids}-${day}`}>
                  {rows.map((m) => {
                    const bySeries = m.series_key != null && pickedSeries.has(m.series_key);
                    return (
                      <MeetingRow
                        key={m.id}
                        title={m.title}
                        meta={[m.date ? timeOf(m.date) : null, m.duration ? `${Math.round(m.duration)} min` : null]
                          .filter(Boolean)
                          .join(" · ")}
                        checked={bySeries || pickedMeetings.has(m.id)}
                        bySeries={bySeries}
                        full={meetingsFull && !pickedMeetings.has(m.id)}
                        onChange={(on) => toggleMeeting(m, on)}
                      />
                    );
                  })}
                </MeetingGroup>
              ))}
              {!meetings.loading && !meetings.error && meetings.rows.length === 0 && earlier.length === 0 && (
                <p className="px-3 py-3 text-[15px] text-text2">No meetings</p>
              )}
              {meetings.loading && <span className="m-3 block h-3 w-2/3 animate-pulse rounded bg-surface2" />}
            </div>
            {meetings.next && (
              <div>
                <Button onClick={() => void meetings.more()} disabled={meetings.loading}>
                  Load more
                </Button>
              </div>
            )}
          </Section>
        </div>
      )}
    </div>
  );
}

function MeetingGroup({ heading, id, children }: { heading: string; id: string; children: ReactNode }) {
  return (
    <div role="group" aria-labelledby={id} className="border-t border-line first:border-t-0">
      <div id={id} className="sticky top-0 z-[1] bg-surface2 px-3 py-1 text-[13px] font-semibold tracking-[0.02em] text-text2">
        {heading}
      </div>
      {children}
    </div>
  );
}

function MeetingRow({
  title,
  meta,
  checked,
  bySeries = false,
  full = false,
  onChange,
}: {
  title: string;
  meta?: string;
  checked: boolean;
  bySeries?: boolean;
  /** At the meetings cap: an unpicked meeting cannot be picked. */
  full?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className={ROW} title={bySeries ? "Included with its series" : undefined}>
      <input
        type="checkbox"
        className={CHECK}
        checked={checked}
        disabled={bySeries || (full && !checked)}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={title}
      />
      <span className="min-w-0 flex-1 truncate text-[15px]">{title}</span>
      {bySeries && (
        <span className="hidden flex-none @[520px]:inline-flex">
          <Chip kind="acc">Series</Chip>
        </span>
      )}
      {meta && <span className="tnum flex-none text-sm text-text2">{meta}</span>}
    </label>
  );
}
