"use client";

import { useMemo, useState, type ReactNode } from "react";

import { Button, Chip, DataTable, InfoTip, Panel, SegmentedControl, type Column } from "@/components/ds";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { addDays, dayIn, todayIn, useCompanyZone } from "@/lib/dates";
import { zoneName } from "@/lib/format";
import { useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

import { CompanyEmpty } from "../../_empty";
import { FindingCard } from "./FindingCard";
import { LABEL_TITLE, LABELS, RATING_KIND, RATING_LABEL, RATINGS, day, originOf, type Change, type Label, type Rating } from "./lib";

type Origin = Change["origin"];
export type ChangeView = "changes" | "web";

/**
 * Market › Change log: every change across the alternatives (page changes and promoted web
 * findings), filtered by alternative, origin, label, rating and month (in the Company time
 * zone); its From the web view lists the open findings with Promote and Dismiss.
 */
export function ChangeLog({
  view,
  onView,
  alternative,
  onAlternative,
  onOpenChange,
  onAddAlternative,
}: {
  view: ChangeView;
  onView: (v: ChangeView) => void;
  alternative: string | null;
  onAlternative: (id: string | null) => void;
  onOpenChange: (id: string) => void;
  /** Opens Alternatives with its Add form (the empty change log's way to start). */
  onAddAlternative?: () => void;
}) {
  const zone = useCompanyZone();
  const { can } = useMe();
  const competitors = useQuery("competitors", () => unwrap(api.GET("/v1/competitors")));
  const [origin, setOrigin] = useState<Origin | "">("");
  const [label, setLabel] = useState<Label | "">("");
  const [rating, setRating] = useState<Rating | "">("");
  const [month, setMonth] = useState("");
  const [older, setOlder] = useState(false);
  const filtered = !!(alternative || origin || label || rating || month);
  const clearFilters = () => {
    onAlternative(null);
    setOrigin("");
    setLabel("");
    setRating("");
    setMonth("");
  };

  // The month is the Company's: ask the API for a day either side (its from/to are UTC days),
  // then keep the changes whose day in the Company time zone falls in it.
  const range = month ? { from: addDays(`${month}-01`, -1), to: addDays(nextMonth(month), 1) } : {};
  const query = { competitor_id: alternative ?? undefined, origin: origin || undefined, rating: rating || undefined, ...range };
  const changes = useQuery(`competitor-changes|${JSON.stringify(query)}`, () => unwrap(api.GET("/v1/competitor-changes", { params: { query } })), {
    keepPrevious: true,
  });
  const findings = useQuery(`competitor-web-findings|${alternative ?? ""}|${older}`, () =>
    unwrap(api.GET("/v1/competitor-web-findings", { params: { query: { status: "open", competitor_id: alternative ?? undefined, include_older: older } } })),
  );
  const rows = useMemo(
    () =>
      (changes.data ?? []).filter((c) => (!label || c.page_label === label) && (!month || dayIn(c.detected_at, zone).startsWith(month))),
    [changes.data, label, month, zone],
  );

  // Nothing has changed at all (no filter on and the list is empty).
  const nothingYet = !filtered && !!changes.data && changes.data.length === 0;
  const months = useMemo(() => lastMonths(todayIn(zone).slice(0, 7), 24), [zone]);

  const columns: Column<Change>[] = [
    { key: "alternative", header: "Alternative", width: "160px", phone: "title", cell: (c) => <span className="truncate font-medium">{c.competitor_name}</span> },
    { key: "origin", header: "From", width: "220px", phone: "meta", wrap: true, cell: (c) => <span className="text-sm">{originOf(c)}</span> },
    { key: "date", header: "Found", width: "88px", phone: "meta", cell: (c) => <span className="tnum text-sm">{day(c.detected_at, zone)}</span> },
    {
      key: "lines",
      header: "Lines",
      width: "88px",
      phone: "hide",
      cell: (c) => <span className="tnum text-sm text-text2">{c.origin === "page" ? `+${c.added_lines} −${c.removed_lines}` : "—"}</span>,
    },
    {
      key: "rating",
      header: "Rating",
      width: "104px",
      phone: "meta",
      cell: (c) => <Chip kind={RATING_KIND[c.rating]}>{RATING_LABEL[c.rating]}</Chip>,
    },
    { key: "summary", header: "Summary", phone: "meta", wrap: true, cell: (c) => <span className="text-sm text-text2">{c.summary ?? "Not summarised yet"}</span> },
  ];

  const open = findings.data ?? [];
  return (
    <Panel
      title="Change log"
      tools={
        <InfoTip label="the change log" align="end">
          What changed about each alternative, dated in the Company time zone ({zoneName(zone)}): differences between two weekly reads of a watched page,
          and web findings a person promoted. From the web lists what the monthly web search found: not vetted until a person promotes or dismisses
          it.
        </InfoTip>
      }
    >
      <div className="flex flex-col gap-2 border-b border-line px-4 py-3 max-[600px]:px-3" data-testid="change-filters">
        {/* qa-company-41: the toggle is as wide as its two choices, not the card. */}
        <div data-testid="change-view">
          <SegmentedControl<ChangeView>
            label="View"
            size="sm"
            items={[
              { value: "changes", label: "Changes" },
              { value: "web", label: "From the web", count: findings.data ? open.length : null },
            ]}
            value={view}
            onChange={onView}
          />
        </div>
        {/* qa-company-41: no filters over an empty change log; they show once there is a change to narrow. */}
        {!(view === "changes" && nothingYet) && (
          <div className="flex flex-wrap items-center gap-2" data-testid="change-filter-row">
            <Filter label="Alternative" value={alternative ?? ""} onChange={(v) => onAlternative(v || null)}>
              <option value="">Every alternative</option>
              {(competitors.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Filter>
            {view === "changes" && (
              <>
                <Filter label="Origin" value={origin} onChange={(v) => setOrigin(v as Origin | "")}>
                  <option value="">Pages and the web</option>
                  <option value="page">Pages</option>
                  <option value="web">From the web</option>
                </Filter>
                <Filter label="Page label" value={label} onChange={(v) => setLabel(v as Label | "")}>
                  <option value="">Every label</option>
                  {LABELS.map((l) => (
                    <option key={l} value={l}>
                      {LABEL_TITLE[l]}
                    </option>
                  ))}
                </Filter>
                <Filter label="Rating" value={rating} onChange={(v) => setRating(v as Rating | "")}>
                  <option value="">Every rating</option>
                  {RATINGS.map((r) => (
                    <option key={r} value={r}>
                      {RATING_LABEL[r]}
                    </option>
                  ))}
                </Filter>
                {/* qa-company-41: the month as words ("October 2026"), never an empty month field's dashes. */}
                <Filter label="Month" value={month} onChange={setMonth}>
                  <option value="">Every month</option>
                  {months.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </Filter>
              </>
            )}
          </div>
        )}
      </div>
      {view === "changes" ? (
        <>
          {changes.error && <ErrorNote>{changes.error}</ErrorNote>}
          {changes.data && rows.length === 0 ? (
            <CompanyEmpty
              testId="changes-empty"
              title={filtered ? "No changes match" : "No changes yet"}
              action={
                filtered ? (
                  <Button onClick={clearFilters}>Clear the filters</Button>
                ) : onAddAlternative && can("create_competitor") && competitors.data?.length === 0 ? (
                  <Button icon="plus" onClick={onAddAlternative}>
                    Add your first alternative
                  </Button>
                ) : undefined
              }
            >
              {filtered
                ? "Nothing changed for this alternative, origin, label, rating or month. Change or clear a filter to see more."
                : competitors.data?.length === 0
                  ? "Each week Oracle reads the public pages you watch on each alternative and lists what changed here. Add an alternative and its pages to start."
                  : "Each week Oracle reads the pages watched on each alternative and lists what changed here. Watch more pages from an alternative's details."}
            </CompanyEmpty>
          ) : (
            <DataTable
              label="Changes"
              testId="changes-table"
              columns={columns}
              rows={changes.data ? rows : undefined}
              loading={changes.loading}
              rowKey={(c) => c.id}
              onSelect={(id) => onOpenChange(id)}
              rowProps={(c) => ({ "data-testid": "change-row", "data-id": c.id })}
            />
          )}
        </>
      ) : (
        <div className="px-4 max-[600px]:px-3" data-testid="web-findings">
          {findings.error && <ErrorNote>{findings.error}</ErrorNote>}
          {findings.data && open.length === 0 ? (
            <CompanyEmpty testId="findings-empty" title="Nothing from the web to vet">
              Once a month Oracle searches the web for news, reviews and launches about each alternative. What it finds waits here for an
              approver to promote to the change log or dismiss.
            </CompanyEmpty>
          ) : (
            <div className="flex flex-col divide-y divide-line">
              {open.map((f) => (
                <FindingCard
                  key={f.id}
                  finding={f}
                  canDecide={can("promote_web_finding")}
                  onPromoted={() => void Promise.all([findings.reload(), changes.reload()])}
                  onDismissed={() => void findings.reload()}
                />
              ))}
            </div>
          )}
          {!older && (
            <div className="border-t border-line py-2">
              <Button variant="ghost" onClick={() => setOlder(true)}>
                Show older
              </Button>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The `n` months up to `current` (YYYY-MM), newest first, as values and words. */
function lastMonths(current: string, n: number): { value: string; label: string }[] {
  let [y, m] = current.split("-").map(Number);
  const out: { value: string; label: string }[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ value: `${y}-${String(m).padStart(2, "0")}`, label: `${MONTH_NAMES[m - 1]} ${y}` });
    if (--m === 0) {
      m = 12;
      y--;
    }
  }
  return out;
}

function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

function Filter({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: ReactNode }) {
  return (
    <label className="flex min-w-0 items-center gap-2 text-sm font-semibold text-text2 max-[600px]:w-full">
      <span className="sr-only">{label}</span>
      <select aria-label={label} className={`${INPUT} w-auto min-w-0 max-[600px]:w-full`} value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
    </label>
  );
}
