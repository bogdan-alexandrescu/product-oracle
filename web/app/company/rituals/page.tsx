"use client";

import Link from "next/link";
import { Suspense, useState } from "react";

import { Button, Chip, type Column, DataTable, Empty, InfoTip, PageSkeleton, Panel, SegmentedControl, Sheet, Split, ViewOnly, confirmInPage } from "@/components/ds";
import { usePhone } from "@/components/ds/page-info";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { useCompanyZone } from "@/lib/dates";
import { formatMoney, zoneName } from "@/lib/format";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import { CompanyHeader } from "../_nav";
import { RitualInspector } from "./_components/RitualInspector";
import {
  estimateText,
  latestPreRead,
  localDate,
  localTime,
  monthlyText,
  perMonthText,
  personEmail,
  personName,
  scheduleOf,
  whenText,
  zoneText,
  zoneTime,
  type Ritual,
  type SummarySettings,
} from "./_components/lib";

export default function RitualsPage() {
  return (
    <Suspense fallback={<PageSkeleton bare />}>
      <Rituals />
    </Suspense>
  );
}

/**
 * Company › Rituals (H2): the summaries setting with its monthly estimate, the company's
 * rituals (Oracle prepares each one's pre-read ahead of its time), and the selected
 * ritual's inspector (a sheet on a phone). Owners edit; everyone else sees. Times show in
 * the Company time zone, named once above the table (qa-company-21).
 */
function Rituals() {
  const { can, capsReady, capsError } = useMe();
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
  // qa-company-6: on a phone the selected ritual opens in a sheet, as Decisions does.
  const phone = usePhone();
  const [sheetOpen, setSheetOpen] = useState(false);
  const companyZone = useCompanyZone();
  const zone = zoneText(companyZone, !!zoneQ.data?.is_default);
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
    // inspector too) give way when the table is narrow beside it (qa-company-22: already
    // beside the inspector at 1440, so names and schedules keep one or two lines).
    { key: "title", header: "Ritual", phone: "title", wrap: true, cell: (r) => <span className="font-medium">{r.title}</span> },
    {
      key: "when",
      header: "When",
      phone: "meta",
      wrap: true,
      className: "max-[600px]:basis-full",
      // qa-company-22: the schedule and the next meeting in one column; qa-company-7: a meeting
      // prepared early stays Next, its pre-read one click away. A paused ritual has no Next.
      cell: (r) => (
        <span className="block text-sm">
          <span className="block">{whenText(scheduleOf(r.schedule))}</span>
          {/* Owner decision 2026-10-29: a built-in waits paused for the first confirmed goal. */}
          {r.waits_for_goal && (
            <span className="block text-text2" data-testid="ritual-waits">
              Starts when the first goal is confirmed
            </span>
          )}
          {r.status === "active" && r.next_due_at && (
            <span className="block text-text2">
              Next{" "}
              <span data-col="next" className="tnum" title={zoneTime(r.next_due_at, scheduleOf(r.schedule).timezone)}>
                {localTime(r.next_due_at)}
              </span>
              {r.next_pre_read && (
                <>
                  {" · "}
                  <Link
                    href={`/company/rituals/${r.next_pre_read.id}`}
                    data-testid="next-pre-read"
                    className="text-accent-ink hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Pre-read ready
                  </Link>
                </>
              )}
            </span>
          )}
        </span>
      ),
    },
    {
      key: "owner",
      header: "Owner",
      width: "132px",
      phone: "hide",
      narrow: "laptop",
      wrap: true,
      cell: (r) => (
        <span className="text-sm" title={personEmail(peopleQ.data, r.owner_id)}>
          {personName(peopleQ.data, r.owner_id)}
        </span>
      ),
    },
    { key: "attendees", header: "Attendees", width: "88px", phone: "hide", narrow: "laptop", align: "right", cell: (r) => <span className="tnum text-sm">{r.attendee_ids.length}</span> },
    {
      key: "last",
      // qa-company-2: the newest pre-read, a ready one for the next meeting too, so the row
      // never says "None yet" beside "Pre-read ready" (the panel's newest occurrence is the same).
      header: "Latest pre-read",
      width: "128px",
      phone: "meta",
      phoneLabel: "Latest pre-read",
      // qa-company-34: on a phone, a line of its own under When and Next.
      className: "max-[600px]:basis-full",
      cell: (r) => {
        const latest = latestPreRead(r);
        return latest ? (
          <Link
            href={`/company/rituals/${latest.id}`}
            data-testid="last-pre-read"
            className="tnum text-sm text-accent-ink hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {localDate(latest.due_at)}
          </Link>
        ) : (
          <span className="text-sm text-text2">None yet</span>
        );
      },
    },
    {
      key: "state",
      header: "State",
      width: "112px",
      // On a phone the state sits right of the name.
      phone: "action",
      // H5: the goals check-in the metrics review replaced says so (an owner may resume it).
      // qa-company-32: a thin edge in the chip's own colour keeps the pill seen on the selected
      // row's tint too (the pass and accent tints are near alike, in light and dark).
      cell: (r) => (
        <Chip
          kind={r.status === "active" ? "pass" : "na"}
          dot
          wrap={!!r.replaced_by}
          title={r.replaced_by ? `Replaced by ${r.replaced_by}` : undefined}
          className="shadow-[inset_0_0_0_1px_color-mix(in_srgb,currentColor_35%,transparent)]"
          data-testid="ritual-state"
        >
          {r.status === "active" ? "On" : r.replaced_by ? `Replaced by ${r.replaced_by}` : "Paused"}
        </Chip>
      ),
    },
  ];

  // fix4-company review (qa-company-34): the page is drawn once the role is known, so the
  // owner's "+ Ritual" joining the tab strip (a second line on a phone) never moves it.
  if (!capsReady && !capsError) return <PageSkeleton bare />;
  return (
    <>
      <CompanyHeader
        status={capsReady && !owner && <ViewOnly />}
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
            if (phone) setSheetOpen(true);
            await changed();
          }}
        />
      )}
      <Split inspector={selected && !phone ? inspectorOf(selected) : undefined}>
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
          {/* qa-company-21: the zone named once, the times above and below without it. */}
          {/* qa4-company-21: an unset zone says it is used until it is set, and where to set it. */}
          <p className="px-4 pt-2.5 pb-1 text-sm text-text2" data-testid="rituals-zone">
            {zoneQ.data?.is_default ? (
              <>
                Times use {zoneName(companyZone)} until you set the company time zone.{" "}
                <Link href="/settings/company#timezone" className="font-semibold text-accent-ink hover:underline">
                  Set it
                </Link>
              </>
            ) : (
              <>Times are in {zone}</>
            )}
          </p>
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
              // qa-company-33: on a phone a row is marked only while its sheet is open.
              selected={phone && !sheetOpen ? null : (selected?.id ?? null)}
              onSelect={(_, r) => {
                setPicked(r.id);
                if (phone) setSheetOpen(true);
              }}
              rowProps={(r) => ({ "data-testid": "ritual-row", "data-kind": r.kind })}
            />
          )}
        </Panel>
      </Split>
      {phone && (
        <Sheet open={sheetOpen && !!selected} title={selected?.title ?? "Ritual"} onClose={() => setSheetOpen(false)} testId="ritual-sheet">
          {selected && inspectorOf(selected, true)}
        </Sheet>
      )}
    </>
  );

  function inspectorOf(r: Ritual, inSheet = false) {
    return (
      <RitualInspector
        inSheet={inSheet}
        key={`${r.id}|${r.lock_version}`}
        ritual={r}
        members={membersQ.data}
        people={peopleQ.data}
        zoneDefault={!!zoneQ.data?.is_default}
        canEdit={owner}
        onChanged={changed}
      />
    );
  }
}

/** Summaries: On demand · Every pre-read (owners change it), and the monthly estimate. */
function SummariesLine({ settings, canEdit, onChanged }: { settings: SummarySettings; canEdit: boolean; onChanged: (s: SummarySettings) => void }) {
  const [error, setError] = useState<string | null>(null);
  // qa-company-23: what the last change saved, in words.
  const [saved, setSaved] = useState<string | null>(null);
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
              setSaved(null);
              // qa-company-23: a recurring cost is asked about first, with what it costs.
              if (
                mode === "always" &&
                !(await confirmInPage({
                  action: "Summarize every pre-read",
                  message: `Oracle will write a summary of every pre-read as soon as it is built, each one an Oracle run. With today's rituals that is ${monthlyText(settings)}.`,
                }))
              )
                return;
              try {
                const next = await unwrap(api.PUT("/v1/rituals/summaries", { body: { mode } }));
                onChanged(next);
                setSaved(
                  mode === "always"
                    ? `Saved · Oracle now summarizes every pre-read, ${monthlyText(next)}`
                    : "Saved · Summaries are on demand: Oracle writes one only when someone asks",
                );
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          />
        </>
      ) : (
        <span className="text-sm font-semibold text-text2">Summaries: {label}</span>
      )}
      {/* qa-company-34: the (i) stays beside the cost text, also when it wraps on a phone. */}
      <span className="inline-flex min-w-0 items-center gap-1">
        <span className="tnum min-w-0 text-sm" data-testid="summaries-estimate">
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
      </span>
      {saved && (
        <span role="status" className="basis-full text-sm text-text2" data-testid="summaries-saved">
          {saved}
        </span>
      )}
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
        {/* qa-company-24: the Title field has the focus, and a disabled Add says why. */}
        <input className={INPUT} required maxLength={120} autoFocus aria-describedby={title.trim() ? undefined : "add-ritual-needs"} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <Button type="submit" variant="solid" disabled={!title.trim()} title={title.trim() ? undefined : "Type a title first"}>
        Add
      </Button>
      <Button variant="ghost" onClick={onClose}>
        Cancel
      </Button>
      {!title.trim() && (
        <p id="add-ritual-needs" className="basis-full text-sm text-text2" data-testid="add-ritual-needs">
          Type a title to add the ritual.
        </p>
      )}
      <p className="basis-full text-sm text-text2" data-testid="add-ritual-hint">
        It starts every Monday at 9:00 AM for 30 minutes, with you as owner and no attendees. Change any of it in the panel once it is added.
      </p>
      {error && <ErrorNote>{error}</ErrorNote>}
    </form>
  );
}
