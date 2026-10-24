"use client";

import { useMemo, useState, type ReactNode } from "react";

import { Button, Chip, DataTable, Empty, InfoTip, Panel, SegmentedControl, type Column } from "@/components/ds";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { addDays, dayIn, todayIn, useCompanyZone } from "@/lib/dates";
import { useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

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
}: {
  view: ChangeView;
  onView: (v: ChangeView) => void;
  alternative: string | null;
  onAlternative: (id: string | null) => void;
  onOpenChange: (id: string) => void;
}) {
  const zone = useCompanyZone();
  const { can } = useMe();
  const competitors = useQuery("competitors", () => unwrap(api.GET("/v1/competitors")));
  const [origin, setOrigin] = useState<Origin | "">("");
  const [label, setLabel] = useState<Label | "">("");
  const [rating, setRating] = useState<Rating | "">("");
  const [month, setMonth] = useState("");
  const [older, setOlder] = useState(false);

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
          What changed about each alternative, dated in the Company time zone ({zone}): differences between two weekly reads of a watched page,
          and web findings a person promoted. From the web lists what the monthly web search found: not vetted until a person promotes or dismisses
          it.
        </InfoTip>
      }
    >
      <div className="flex flex-col gap-2 border-b border-line px-4 py-3 max-[600px]:px-3" data-testid="change-filters">
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
        <div className="flex flex-wrap items-center gap-2">
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
              <label className="flex items-center gap-2 text-sm font-semibold text-text2">
                Month
                <input type="month" aria-label="Month" className={`${INPUT} w-auto`} value={month} max={todayIn(zone).slice(0, 7)} onChange={(e) => setMonth(e.target.value)} />
              </label>
            </>
          )}
        </div>
      </div>
      {view === "changes" ? (
        <>
          {changes.error && <ErrorNote>{changes.error}</ErrorNote>}
          {changes.data && rows.length === 0 ? (
            <Empty testId="changes-empty">No changes here</Empty>
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
            <Empty testId="findings-empty">Nothing from the web to vet</Empty>
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
