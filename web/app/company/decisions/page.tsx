"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState, useSyncExternalStore } from "react";

import { Avatar, Button, Chip, DataTable, Empty, FilterChips, InfoTip, PageHeader, Panel, Sheet, Split, type Column } from "@/components/ds";
import { ErrorNote, INPUT, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { hasRole, useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";
import { invalidateWaiting, waitingChanged } from "@/lib/waiting";

import { DecisionInspector } from "./_components/DecisionInspector";
import { ProposeDialog } from "./_components/ProposeDialog";
import {
  CLASS_FILTERS,
  FROM,
  REVERSIBILITY_LABEL,
  STATE_FILTERS,
  STATE_KIND,
  STATE_LABEL,
  isCheckpoint,
  shortDate,
  type ClassFilter,
  type Decision,
  type DecisionSummary,
  type StateFilter,
} from "./_components/lib";

const PHONE = "(max-width: 600px)";

function subscribePhone(onChange: () => void) {
  const mq = window.matchMedia(PHONE);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function useIsPhone(): boolean {
  return useSyncExternalStore(
    subscribePhone,
    () => window.matchMedia(PHONE).matches,
    () => false,
  );
}

export default function DecisionsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Decisions />
    </Suspense>
  );
}

/** What waits on me: proposals I decide and reviews that have come due. */
const needsMe = (d: DecisionSummary, me: string | null | undefined) =>
  d.approver_id === me && (d.state === "proposed" || d.state === "review_due");

/**
 * The decision log (H1): a one-line table of decisions on the left, the inspector on the
 * right (a sheet on a phone). The filters live in the URL, so a shared link opens the same
 * view: class (judgement calls by default; checkpoints when opened for a run), state (Needs me
 * when I have any), From, search, and the subject and run the deep links use.
 */
function Decisions() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { me, role } = useMe();
  const phone = useIsPhone();
  const run = params.get("run");
  const subjectParam = params.get("subject");
  const cls = (params.get("class") as ClassFilter | null) ?? (run ? "checkpoint" : "judgement");
  const from = params.get("from") ?? "";
  const q = params.get("q") ?? "";
  const [search, setSearch] = useState(q);
  const [proposing, setProposing] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const picked = params.get("d");

  const subject = useMemo((): Schemas["Subject"] | null => {
    if (!subjectParam) return null;
    const [kind, ...rest] = subjectParam.split(":");
    const id = rest.join(":");
    return kind && id ? ({ kind, id } as Schemas["Subject"]) : null;
  }, [subjectParam]);

  const fromDef = FROM.find((f) => f.value === from);
  const query = {
    class: cls,
    origin: fromDef?.origin,
    run_id: run ?? undefined,
    subject_kind: subject?.kind,
    subject_id: subject?.id,
    q: q || undefined,
    limit: 200,
  };
  const listQ = useQuery(`decisions|${JSON.stringify(query)}`, () => unwrap(api.GET("/v1/decisions", { params: { query } })), { keepPrevious: true });
  // Needs me is the default when something waits on me (any class: judgement calls only).
  const mineQ = useQuery(`decisions|mine|${me?.user_id}`, () =>
    unwrap(api.GET("/v1/decisions", { params: { query: { class: "judgement", approver: "me", limit: 200 } } })),
  );
  const peopleQ = useQuery("decisions|people", () => unwrap(api.GET("/v1/decisions/people")));
  const people = peopleQ.data ?? [];
  const waitingOnMe = (mineQ.data ?? []).filter((d) => needsMe(d, me?.user_id)).length;
  const stateParam = params.get("state") as StateFilter | null;
  const state: StateFilter = stateParam ?? (mineQ.data ? (waitingOnMe > 0 && !run ? "needs_me" : "all") : "all");

  const rows = useMemo(() => {
    let list = listQ.data ?? [];
    if (fromDef?.chosen) list = list.filter((d) => d.chosen_option === fromDef.chosen);
    if (state === "needs_me") list = list.filter((d) => needsMe(d, me?.user_id));
    else if (state === "proposed") list = list.filter((d) => d.state === "proposed");
    else if (state === "review_due") list = list.filter((d) => d.state === "review_due");
    else if (state === "decided") list = list.filter((d) => d.status === "decided");
    return list;
  }, [listQ.data, fromDef, state, me?.user_id]);

  // The picked decision stays open after it leaves the filtered rows (decided from Needs me).
  const selectedSummary = rows.find((d) => String(d.number) === picked || d.id === picked) ?? (phone || picked ? undefined : rows[0]);
  const selectedKey = picked ?? (selectedSummary ? String(selectedSummary.number) : null);
  const detailQ = useQuery(
    `decision|${selectedKey ?? "none"}`,
    () => (selectedKey ? unwrap(api.GET("/v1/decisions/{decision}", { params: { path: { decision: selectedKey } } })) : Promise.resolve(null)),
    { keepPrevious: true },
  );
  const detail =
    detailQ.data && selectedKey && (String(detailQ.data.number) === selectedKey || detailQ.data.id === selectedKey) ? detailQ.data : null;

  /** Rewrites the URL's filters (null removes one); the view follows the URL. */
  function setParams(patch: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    const s = next.toString();
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
  }

  async function changed(updated?: Decision) {
    invalidateWaiting();
    if (updated) detailQ.setData(() => updated);
    await Promise.all([listQ.reload(), mineQ.reload(), detailQ.reload()]);
    waitingChanged();
  }

  const columns: Column<DecisionSummary>[] = [
    {
      key: "ref",
      header: "No.",
      width: "64px",
      phone: "meta",
      cell: (d) => <span className="tnum font-mono text-sm text-accent-ink">{d.ref}</span>,
    },
    { key: "title", header: "Title", phone: "title", cell: (d) => <span className="truncate font-medium">{d.title}</span> },
    {
      key: "state",
      header: "State",
      width: "120px",
      phone: "meta",
      cell: (d) => (
        <Chip kind={STATE_KIND[d.state]} dot>
          {STATE_LABEL[d.state]}
        </Chip>
      ),
    },
    {
      key: "reversibility",
      header: "Reversibility",
      width: "136px",
      phone: "hide",
      cell: (d) => <span className="text-sm text-text2">{isCheckpoint(d) ? "—" : REVERSIBILITY_LABEL[d.reversibility]}</span>,
    },
    {
      key: "approver",
      header: "Approver",
      width: "84px",
      phone: "hide",
      cell: (d) => (
        <span data-col="approver" title={d.approver_email ?? undefined}>
          <Avatar name={d.approver_email ?? "?"} />
        </span>
      ),
    },
    { key: "decided", header: "Decided", width: "112px", phone: "hide", cell: (d) => <span className="tnum text-sm">{shortDate(d.decided_at)}</span> },
    {
      key: "review",
      header: "Review",
      width: "112px",
      phone: "hide",
      cell: (d) => <span className="tnum text-sm">{isCheckpoint(d) ? "—" : shortDate(d.review_at)}</span>,
    },
  ];

  // One inspector per decision (its open form never carries over); ?act=decide (the Inbox's
  // Decide) opens the decide form.
  const inspector = detail ? (
    <DecisionInspector key={detail.id} decision={detail} people={people} onChanged={changed} autoDecide={params.get("act") === "decide"} />
  ) : null;
  const select = (d: DecisionSummary) => {
    setParams({ d: String(d.number) });
    if (phone) setSheetOpen(true);
  };

  return (
    <>
      <PageHeader
        title="Company"
        action={
          hasRole(role, "commenter") && (
            <Button variant="primary" icon="plus" onClick={() => setProposing(true)}>
              Propose decision
            </Button>
          )
        }
      />
      {listQ.error && <ErrorNote>{listQ.error}</ErrorNote>}
      <Split inspector={!phone ? inspector : undefined}>
        <Panel
          title="Decisions"
          count={listQ.data ? rows.length : undefined}
          tools={
            <InfoTip label="the decision log" align="end">
              Every product decision is one record with one approver: its options, why it was chosen, what should happen and when to look at it
              again. Oracle records the calls made elsewhere (published versions, accepted risks, blocker choices, overrides of its pushback) and
              every run stop approved or sent back.
            </InfoTip>
          }
        >
          <div className="flex flex-col gap-2 border-b border-line px-4 py-3 max-[600px]:px-3" data-testid="decision-filters">
            <FilterChips
              label="Class"
              testId="decision-class"
              items={CLASS_FILTERS.map((c) => ({ value: c.value, label: c.label }))}
              value={cls}
              onChange={(v) => setParams({ class: v === (run ? "checkpoint" : "judgement") ? null : v, d: null })}
            />
            <FilterChips
              label="State"
              testId="decision-state"
              items={STATE_FILTERS.map((s) => ({ value: s.value, label: s.label }))}
              value={state}
              onChange={(v) => setParams({ state: v, d: null })}
            />
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-sm font-semibold text-text2">
                From
                <select aria-label="From" className={`${INPUT} w-auto`} value={from} onChange={(e) => setParams({ from: e.target.value || null, d: null })}>
                  <option value="">Anywhere</option>
                  {FROM.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </label>
              <form
                role="search"
                className="min-w-0 flex-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  setParams({ q: search.trim() || null, d: null });
                }}
              >
                <input
                  type="search"
                  aria-label="Search decisions"
                  className={INPUT}
                  value={search}
                  placeholder="Search decisions"
                  onChange={(e) => setSearch(e.target.value)}
                  onBlur={() => search.trim() !== q && setParams({ q: search.trim() || null, d: null })}
                />
              </form>
            </div>
            {(run || subject) && (
              <p className="flex flex-wrap items-center gap-2 text-sm text-text2">
                {run ? "Decisions in this run" : `About ${subject?.kind} ${subject?.id.slice(0, 8)}`}
                <Button variant="ghost" onClick={() => setParams({ run: null, subject: null, d: null })}>
                  Show every decision
                </Button>
              </p>
            )}
          </div>
          {listQ.data && rows.length === 0 ? (
            <Empty testId="decisions-empty">No decisions here</Empty>
          ) : (
            <DataTable
              label="Decisions"
              testId="decisions-table"
              columns={columns}
              rows={listQ.data ? rows : undefined}
              loading={listQ.loading}
              rowKey={(d) => d.id}
              selected={phone ? (sheetOpen ? (selectedSummary?.id ?? null) : null) : (selectedSummary?.id ?? null)}
              onSelect={(_, d) => select(d)}
              rowProps={(d) => ({ "data-testid": "decision-row", "data-number": String(d.number) })}
            />
          )}
        </Panel>
      </Split>
      {phone && (
        <Sheet open={sheetOpen && !!detail} title={detail ? `${detail.ref} ${detail.title}` : "Decision"} onClose={() => setSheetOpen(false)} testId="decision-sheet">
          {inspector}
        </Sheet>
      )}
      {proposing && (
        <ProposeDialog
          people={people}
          subject={subject}
          onClose={() => setProposing(false)}
          onProposed={async (d) => {
            setProposing(false);
            setParams({ d: String(d.number), state: "all" });
            await changed(d);
          }}
        />
      )}
    </>
  );
}
