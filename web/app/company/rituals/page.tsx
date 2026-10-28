"use client";

import Link from "next/link";
import { Suspense, useState } from "react";

import { Button, Chip, DataTable, Empty, InfoTip, Panel, SegmentedControl, Split, type Column } from "@/components/ds";
import { ErrorNote, INPUT, Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { formatMoney } from "@/lib/format";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import { CompanyHeader } from "../_nav";
import { RitualInspector } from "./_components/RitualInspector";
import {
  estimateText,
  localDate,
  localTime,
  perMonthText,
  personEmail,
  personName,
  scheduleOf,
  whenText,
  zoneTime,
  type Ritual,
  type SummarySettings,
} from "./_components/lib";

export default function RitualsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Rituals />
    </Suspense>
  );
}

/**
 * Company › Rituals (H2): the summaries setting with its monthly estimate, the company's
 * rituals (Oracle prepares each one's pre-read ahead of its time), and the selected
 * ritual's inspector. Owners edit; everyone else sees. Times show in the viewer's zone,
 * with the ritual's zone in a tooltip.
 */
function Rituals() {
  const { can } = useMe();
  // #370: editing rituals is the ritual routes' role (owners).
  const owner = can("update_ritual");
  const ritualsQ = useQuery("rituals", () => unwrap(api.GET("/v1/rituals")));
  const settingsQ = useQuery("rituals|summaries", () => unwrap(api.GET("/v1/rituals/summaries")));
  // The owner's member pickers read the member list (owners only); every name on the page
  // comes from the member directory, which everyone who sees the table may read.
  const membersQ = useQuery(owner ? "rituals|members" : "rituals|members|none", () => (owner ? unwrap(api.GET("/v1/members")) : Promise.resolve(undefined)));
  // qa-company-24: whether an owner chose the Company time zone yet (Settings are the owner's).
  const zoneQ = useQuery(owner ? "settings|company_timezone" : "settings|company_timezone|none", () =>
    owner ? unwrap(api.GET("/v1/settings/{key}", { params: { path: { key: "company_timezone" } } })) : Promise.resolve(undefined),
  );
  const [picked, setPicked] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const rows = ritualsQ.data ?? [];
  const ownerIds = [...new Set(rows.map((r) => r.owner_id))].sort().join(",");
  const peopleQ = useQuery(`rituals|people|${ownerIds}`, () =>
    ownerIds ? unwrap(api.GET("/v1/people", { params: { query: { ids: ownerIds.split(",") } } })) : Promise.resolve([]),
  );
  const selected = rows.find((r) => r.id === picked) ?? rows[0];

  async function changed(r?: Ritual) {
    if (r) ritualsQ.setData((prev) => prev?.map((x) => (x.id === r.id ? r : x)));
    await Promise.all([ritualsQ.reload(), settingsQ.reload()]);
  }

  const columns: Column<Ritual>[] = [
    // qa-company-8: names and schedules wrap rather than cut; Owner and Attendees (in the
    // inspector too) give way when the table is narrow beside it.
    { key: "title", header: "Ritual", phone: "title", wrap: true, cell: (r) => <span className="font-medium">{r.title}</span> },
    { key: "when", header: "When", phone: "meta", wrap: true, cell: (r) => <span className="text-sm">{whenText(scheduleOf(r.schedule))}</span> },
    {
      key: "owner",
      header: "Owner",
      width: "132px",
      phone: "hide",
      narrow: "hide",
      wrap: true,
      cell: (r) => (
        <span className="text-sm" title={personEmail(peopleQ.data, r.owner_id)}>
          {personName(peopleQ.data, r.owner_id)}
        </span>
      ),
    },
    { key: "attendees", header: "Attendees", width: "88px", phone: "hide", narrow: "hide", align: "right", cell: (r) => <span className="tnum text-sm">{r.attendee_ids.length}</span> },
    {
      key: "next",
      header: "Next",
      width: "184px",
      phone: "meta",
      phoneLabel: "Next",
      wrap: true,
      // qa-company-7: a meeting prepared early stays Next, its pre-read one click away.
      cell: (r) => (
        <span className="text-sm">
          <span data-col="next" className="tnum" title={r.next_due_at ? zoneTime(r.next_due_at, scheduleOf(r.schedule).timezone) : undefined}>
            {r.status === "active" && r.next_due_at ? localTime(r.next_due_at) : "—"}
          </span>
          {r.status === "active" && r.next_pre_read && (
            <Link
              href={`/company/rituals/${r.next_pre_read.id}`}
              data-testid="next-pre-read"
              className="block text-accent-ink hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              Pre-read ready
            </Link>
          )}
        </span>
      ),
    },
    {
      key: "last",
      header: "Last pre-read",
      width: "120px",
      phone: "meta",
      phoneLabel: "Last",
      cell: (r) =>
        r.last_pre_read ? (
          <Link href={`/company/rituals/${r.last_pre_read.id}`} className="tnum text-sm text-accent-ink hover:underline" onClick={(e) => e.stopPropagation()}>
            {localDate(r.last_pre_read.due_at)}
          </Link>
        ) : (
          <span className="text-sm text-text2">—</span>
        ),
    },
    {
      key: "state",
      header: "State",
      width: "96px",
      phone: "meta",
      // H5: the goals check-in the metrics review replaced says so (an owner may resume it).
      cell: (r) => (
        <Chip kind={r.status === "active" ? "pass" : "na"} dot wrap={!!r.replaced_by} title={r.replaced_by ? `Replaced by ${r.replaced_by}` : undefined}>
          {r.status === "active" ? "On" : r.replaced_by ? `Replaced by ${r.replaced_by}` : "Paused"}
        </Chip>
      ),
    },
  ];

  return (
    <>
      <CompanyHeader
        action={
          owner && (
            <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
              Add ritual
            </Button>
          )
        }
      />
      {ritualsQ.error && <ErrorNote>{ritualsQ.error}</ErrorNote>}
      {settingsQ.data && <SummariesLine settings={settingsQ.data} canEdit={owner} onChanged={(s) => settingsQ.setData(() => s)} />}
      {adding && owner && (
        <AddRitual
          onClose={() => setAdding(false)}
          onAdded={async (r) => {
            setAdding(false);
            setPicked(r.id);
            await changed();
          }}
        />
      )}
      <Split
        inspector={
          selected ? (
            <RitualInspector
              key={`${selected.id}|${selected.lock_version}`}
              ritual={selected}
              members={membersQ.data}
              people={peopleQ.data}
              zoneDefault={!!zoneQ.data?.is_default}
              canEdit={owner}
              onChanged={changed}
            />
          ) : undefined
        }
      >
        <Panel
          title="Rituals"
          testId="rituals-panel"
          count={ritualsQ.data ? rows.length : undefined}
          tools={
            <InfoTip label="rituals" align="end">
              Oracle prepares each ritual&apos;s pre-read from its own data before the meeting and puts it in the owner&apos;s and
              attendees&apos; Inbox. After the meeting the owner records notes, or skips it with a reason.
            </InfoTip>
          }
        >
          {ritualsQ.data && rows.length === 0 ? (
            <Empty>No rituals yet</Empty>
          ) : (
            <DataTable
              label="Rituals"
              testId="rituals-table"
              columns={columns}
              rows={ritualsQ.data ? rows : undefined}
              loading={ritualsQ.loading}
              rowKey={(r) => r.id}
              selected={selected?.id ?? null}
              onSelect={(_, r) => setPicked(r.id)}
              rowProps={(r) => ({ "data-testid": "ritual-row", "data-kind": r.kind })}
            />
          )}
        </Panel>
      </Split>
    </>
  );
}

/** Summaries: On demand · Every pre-read (owners change it), and the monthly estimate. */
function SummariesLine({ settings, canEdit, onChanged }: { settings: SummarySettings; canEdit: boolean; onChanged: (s: SummarySettings) => void }) {
  const [error, setError] = useState<string | null>(null);
  const label = settings.mode === "always" ? "Every pre-read" : "On demand";
  return (
    <div data-testid="ritual-summaries" className="mb-3 flex flex-wrap items-center gap-3 rounded-panel border border-line bg-surface px-4 py-2.5 shadow-panel">
      {canEdit ? (
        <>
          <span className="text-sm font-semibold text-text2">Summaries</span>
          <SegmentedControl
            label="Summaries"
            size="sm"
            value={settings.mode}
            items={[
              { value: "on_demand", label: "On demand", title: "Summarize with Oracle on an occurrence page" },
              { value: "always", label: "Every pre-read", title: "Oracle summarizes each pre-read as soon as it is built" },
            ]}
            onChange={async (mode) => {
              setError(null);
              try {
                onChanged(await unwrap(api.PUT("/v1/rituals/summaries", { body: { mode } })));
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          />
        </>
      ) : (
        <span className="text-sm font-semibold text-text2">Summaries: {label}</span>
      )}
      <span className="tnum text-sm" data-testid="summaries-estimate">
        {estimateText(settings)}
      </span>
      <InfoTip label="the summaries estimate" align="start">
        {settings.estimate.rituals.length === 0
          ? "No active ritual would be summarized."
          : settings.estimate.rituals.map((r) => (
              <span key={r.ritual_id} className="block">
                {r.title}: {perMonthText(r.runs_per_month)}, {formatMoney(r.per_summary_usd)} each
              </span>
            ))}
        {/* With no active ritual, what one summary would cost is still said. */}
        <span className="mt-1 block">
          {settings.estimate.rituals.length === 0
            ? `Each summary is one Oracle run of about ${formatMoney(settings.estimate.per_summary_usd)}.`
            : "Each summary is one Oracle run."}
        </span>
      </InfoTip>
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}

/**
 * Add ritual (owners): a custom ritual with a title, made with the defaults it says
 * (qa-company-29); its schedule, length and people are then edited in the inspector.
 */
function AddRitual({ onClose, onAdded }: { onClose: () => void; onAdded: (r: Ritual) => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      aria-label="Add ritual"
      className="mb-3 flex flex-wrap items-end gap-2 rounded-panel border border-line bg-surface px-4 py-3 shadow-panel"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          const r = await unwrap(
            api.POST("/v1/rituals", {
              body: {
                kind: "custom",
                title: title.trim(),
                attendee_ids: [],
                // In the Company time zone: a ritual has no zone of its own.
                schedule: { freq: "weekly", interval: 1, weekday: 0, week_of_month: 1, month: 1, time: "09:00" },
              },
            }),
          );
          await onAdded(r);
        } catch (err) {
          setError(errorMessage(err));
        }
      }}
    >
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm font-semibold text-text2">
        Title
        <input className={INPUT} required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <Button type="submit" variant="solid" disabled={!title.trim()}>
        Add
      </Button>
      <Button variant="ghost" onClick={onClose}>
        Cancel
      </Button>
      <p className="basis-full text-sm text-text2" data-testid="add-ritual-hint">
        It starts every Monday at 9:00 AM for 30 minutes, with you as owner and no attendees. Change any of it in the panel once it is added.
      </p>
      {error && <ErrorNote>{error}</ErrorNote>}
    </form>
  );
}
