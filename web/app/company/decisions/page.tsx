"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";

import { Avatar, Button, Chip, type Column, DataTable, FilterChips, InfoTip, PageSkeleton, Panel, Sheet, Split } from "@/components/ds";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import type { paths } from "@/lib/api/schema";
import { useMe } from "@/lib/me";
import { displayName } from "@/lib/names";
import { useQuery } from "@/lib/use-query";
import { useSetParams } from "@/lib/use-set-params";
import { invalidateWaiting, waitingChanged } from "@/lib/waiting";

import { CompanyHeader } from "../_nav";
import { DecisionInspector } from "./_components/DecisionInspector";
import { useSubjectLabel } from "./_components/LinksPicker";
import { ProposeDialog } from "./_components/ProposeDialog";
import {
  CLASS_FILTERS,
  FROM,
  REVERSIBILITY_LABEL,
  STATE_FILTERS,
  STATE_KIND,
  STATE_LABEL,
  isCheckpoint,
  personName,
  shortDate,
  type ClassFilter,
  type Decision,
  type DecisionSummary,
  type Person,
  type StateFilter,
} from "./_components/lib";

/** A labelled row of filter chips: the group's name, then its chips. */
function FilterRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span aria-hidden className="w-12 shrink-0 text-sm font-semibold text-text2">
        {label}
      </span>
      {children}
    </div>
  );
}

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
    <Suspense fallback={<PageSkeleton bare />}>
      <Decisions />
    </Suspense>
  );
}

/** Rows per call (the API's most); Show more loads the next page. */
const PAGE = 200;

/** A state chip as the API's filters: Needs me is what waits on me to decide or review. */
const STATE_QUERY: Record<StateFilter, Pick<ListQuery, "status" | "approver" | "due">> = {
  needs_me: { status: "open", approver: "me" },
  proposed: { status: "proposed" },
  review_due: { status: "review_due" },
  // A decided call whose review has come is under Review due, not here: the API leaves it out,
  // so a page of Decided is a full page.
  decided: { status: "decided", due: false },
  all: {},
};

type ListQuery = NonNullable<paths["/v1/decisions"]["get"]["parameters"]["query"]>;

/** The first `pages` pages of what matches, and whether there is more. */
async function loadPages(query: ListQuery, pages: number): Promise<{ rows: DecisionSummary[]; more: boolean }> {
  const rows: DecisionSummary[] = [];
  for (let page = 0; page < pages; page++) {
    const batch = await unwrap(api.GET("/v1/decisions", { params: { query: { ...query, limit: PAGE, offset: page * PAGE } } }));
    rows.push(...batch);
    if (batch.length < PAGE) return { rows, more: false };
  }
  const next = await unwrap(api.GET("/v1/decisions", { params: { query: { ...query, limit: 1, offset: pages * PAGE } } }));
  return { rows, more: next.length > 0 };
}

/**
 * The decision log (H1): a one-line table of decisions on the left, the inspector on the
 * right (a sheet on a phone). The filters live in the URL, so a shared link opens the same
 * view: class (judgement calls by default; checkpoints when opened for a run), state (Needs me
 * when I have any), From, search, and the subject and run the deep links use.
 */
function Decisions() {
  const params = useSearchParams();
  // Rewrites the URL's filters (null removes one) from the latest URL; the view follows the URL.
  const setParams = useSetParams();
  const { me, can } = useMe();
  const phone = useIsPhone();
  const run = params.get("run");
  const subjectParam = params.get("subject");
  const cls = (params.get("class") as ClassFilter | null) ?? (run ? "checkpoint" : "judgement");
  const from = params.get("from") ?? "";
  const q = params.get("q") ?? "";
  const [search, setSearch] = useState(q);
  // ?propose=1 (a section's or a blocker's "Record a decision") opens the form about it.
  const [proposing, setProposing] = useState(params.get("propose") === "1");
  const [sheetOpen, setSheetOpen] = useState(false);
  const picked = params.get("d");

  const subject = useMemo((): Schemas["Subject"] | null => {
    if (!subjectParam) return null;
    const [kind, ...rest] = subjectParam.split(":");
    const id = rest.join(":");
    return kind && id ? ({ kind, id, ref: params.get("ref") } as Schemas["Subject"]) : null;
  }, [subjectParam, params]);

  const fromDef = FROM.find((f) => f.value === from);
  // Needs me is the default when something waits on me (judgement calls only).
  const mineQ = useQuery(`decisions|mine|${me?.user_id}`, () =>
    unwrap(api.GET("/v1/decisions", { params: { query: { class: "judgement", status: "open", approver: "me", limit: 1 } } })),
  );
  const subjectName = useSubjectLabel();
  const peopleQ = useQuery("decisions|people", () => unwrap(api.GET("/v1/decisions/people")));
  // Names as the company knows them (GET /v1/people); an email is the second line, never the name.
  const namesQ = useQuery("decisions|names", () => unwrap(api.GET("/v1/people", { params: { query: { limit: 500 } } })));
  const people = useMemo((): Person[] => {
    const names = new Map((namesQ.data ?? []).map((p) => [p.user_id, p.name]));
    return (peopleQ.data ?? []).map((p) => ({ ...p, name: names.get(p.id) ?? personName(p) }));
  }, [peopleQ.data, namesQ.data]);
  const nameOf = (id: string | null | undefined, email: string | null | undefined): string | null => {
    const p = people.find((x) => x.id === id);
    return p ? personName(p) : email ? displayName(email) : null;
  };
  const stateParam = params.get("state") as StateFilter | null;
  const state: StateFilter | null = stateParam ?? (mineQ.data ? (mineQ.data.length > 0 && !run ? "needs_me" : "all") : null);

  // Every filter runs in the API, so an old decision is found however many newer ones there are.
  const query: ListQuery = {
    class: cls,
    origin: fromDef?.origin,
    chosen: fromDef?.chosen,
    ...STATE_QUERY[state ?? "all"],
    run_id: run ?? undefined,
    subject_kind: subject?.kind,
    subject_id: subject?.id,
    q: q || undefined,
  };
  const filterKey = JSON.stringify(query);
  const [paging, setPaging] = useState({ key: filterKey, pages: 1 });
  const pages = paging.key === filterKey ? paging.pages : 1;
  // The state is known once Needs me is (or the URL names one): no list of the wrong state first.
  const listQ = useQuery(
    state ? `decisions|${filterKey}|${pages}` : "decisions|pending",
    () => (state ? loadPages(query, pages) : Promise.resolve(undefined)),
    { keepPrevious: true },
  );
  const rows = useMemo(() => listQ.data?.rows ?? [], [listQ.data]);
  // The count of what the filters choose from (the class, the run or subject), so a filter
  // that hides rows reads "2 of 5", never a bare 0.
  const baseQuery: ListQuery = { class: cls, run_id: run ?? undefined, subject_kind: subject?.kind, subject_id: subject?.id };
  const baseKey = JSON.stringify(baseQuery);
  const totalQ = useQuery(`decisions|total|${baseKey}`, () => loadPages(baseQuery, 1), { keepPrevious: true });
  const total = totalQ.data ? `${totalQ.data.rows.length}${totalQ.data.more ? "+" : ""}` : null;
  const filtered = (state !== null && state !== "all") || !!from || !!q;
  // What hides rows, in words, for the empty list.
  const hiding = [
    state && state !== "all" ? `State: ${STATE_FILTERS.find((s) => s.value === state)?.label}` : null,
    fromDef ? `From: ${fromDef.label}` : null,
    q ? `Search: \u201c${q}\u201d` : null,
  ].filter((x): x is string => !!x);
  const clearFilters = () => {
    setSearch("");
    setParams({ state: "all", from: null, q: null, d: null });
  };

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

  async function changed(updated?: Decision) {
    invalidateWaiting();
    if (updated) detailQ.setData(() => updated);
    await Promise.all([listQ.reload(), mineQ.reload(), detailQ.reload(), totalQ.reload()]);
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
    // The title wraps: it is what a row is read by, never cut mid-word.
    { key: "title", header: "Title", phone: "title", wrap: true, cell: (d) => <span className="font-medium">{d.title}</span> },
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
      width: "128px",
      phone: "hide",
      narrow: "hide",
      cell: (d) => <span className="text-sm text-text2">{isCheckpoint(d) ? "—" : REVERSIBILITY_LABEL[d.reversibility]}</span>,
    },
    {
      key: "approver",
      header: "Approver",
      width: "84px",
      phone: "hide",
      cell: (d) => {
        const name = nameOf(d.approver_id, d.approver_email);
        return (
          <span data-col="approver" title={name ? `${name}${d.approver_email ? ` · ${d.approver_email}` : ""}` : undefined}>
            <Avatar name={name ?? "?"} />
          </span>
        );
      },
    },
    { key: "decided", header: "Decided", width: "112px", phone: "hide", narrow: "hide", cell: (d) => <span className="tnum text-sm">{shortDate(d.decided_at)}</span> },
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
  const setClass = (v: ClassFilter) => setParams({ class: v === (run ? "checkpoint" : "judgement") ? null : v, d: null });
  const select = (d: DecisionSummary) => {
    setParams({ d: String(d.number) });
    if (phone) setSheetOpen(true);
  };

  return (
    <>
      <CompanyHeader
        action={
          can("create_decision") && (
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
          count={listQ.data ? (filtered && total !== null && total !== String(rows.length) ? `${rows.length} of ${total}` : rows.length) : undefined}
          tools={
            <InfoTip label="the decision log" align="end">
              Every product decision is one record with one approver: its options, why it was chosen, what should happen and when to look at it
              again. Oracle records the calls made elsewhere (published versions, accepted risks, blocker choices, overrides of its pushback) and
              every run stop approved or sent back.
            </InfoTip>
          }
        >
          <div className="flex flex-col gap-2 border-b border-line px-4 py-3 max-[600px]:px-3" data-testid="decision-filters">
            {phone ? (
              // A phone has room for menus, not three rows of pills.
              <div className="grid grid-cols-2 gap-2">
                <label className="flex min-w-0 flex-col gap-1 text-sm font-semibold text-text2">
                  Kind
                  <select aria-label="Kind" data-testid="decision-class" className={INPUT} value={cls} onChange={(e) => setClass(e.target.value as ClassFilter)}>
                    {CLASS_FILTERS.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex min-w-0 flex-col gap-1 text-sm font-semibold text-text2">
                  State
                  <select
                    aria-label="State"
                    data-testid="decision-state"
                    className={INPUT}
                    value={state ?? "all"}
                    onChange={(e) => setParams({ state: e.target.value, d: null })}
                  >
                    {STATE_FILTERS.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ) : (
              <>
                <FilterRow label="Kind">
                  <FilterChips
                    label="Kind"
                    testId="decision-class"
                    items={CLASS_FILTERS.map((c) => ({ value: c.value, label: c.label }))}
                    value={cls}
                    onChange={setClass}
                  />
                </FilterRow>
                <FilterRow label="State">
                  <FilterChips
                    label="State"
                    testId="decision-state"
                    items={STATE_FILTERS.map((s) => ({ value: s.value, label: s.label }))}
                    value={state ?? "all"}
                    onChange={(v) => setParams({ state: v, d: null })}
                  />
                </FilterRow>
              </>
            )}
            <div className="flex flex-wrap items-center gap-2 max-[600px]:flex-col max-[600px]:items-stretch">
              <label className="flex items-center gap-2 text-sm font-semibold text-text2 max-[600px]:flex-col max-[600px]:items-stretch max-[600px]:gap-1">
                From
                <select
                  aria-label="From"
                  className={`${INPUT} w-auto max-[600px]:w-full`}
                  value={from}
                  onChange={(e) => setParams({ from: e.target.value || null, d: null })}
                >
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
                className="min-w-0 flex-1 max-[600px]:w-full"
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
                  placeholder="Search"
                  onChange={(e) => setSearch(e.target.value)}
                  onBlur={() => search.trim() !== q && setParams({ q: search.trim() || null, d: null })}
                />
              </form>
            </div>
            {(run || subject) && (
              <p className="flex flex-wrap items-center gap-2 text-sm text-text2">
                {run ? "Decisions in this run" : subject ? `About ${subjectName(subject)}` : null}
                <Button variant="ghost" onClick={() => setParams({ run: null, subject: null, d: null })}>
                  Show every decision
                </Button>
              </p>
            )}
          </div>
          {listQ.data && rows.length === 0 ? (
            <div data-testid="decisions-empty" className="flex flex-col items-center gap-2 px-4 py-8 text-center text-[15px] text-text2">
              {state === "needs_me" && !from && !q ? (
                <p data-testid="decisions-needs-me-empty">
                  Nothing waits on you here. Needs me lists the proposals you are the approver of and your decisions whose review date has come. Run
                  stops and document approvals wait in the{" "}
                  <Link href="/inbox" className="font-medium text-accent-ink hover:underline">
                    Inbox
                  </Link>
                  .
                </p>
              ) : (
                <p>{hiding.length > 0 ? `No decisions match ${hiding.join(", ")}.` : "No decisions here yet."}</p>
              )}
              {filtered && (
                <Button onClick={clearFilters} data-testid="decisions-clear">
                  Clear filters
                </Button>
              )}
            </div>
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
          {listQ.data?.more && (
            <div className="border-t border-line px-4 py-2 max-[600px]:px-3">
              <Button variant="ghost" disabled={listQ.loading} onClick={() => setPaging({ key: filterKey, pages: pages + 1 })}>
                Show more
              </Button>
            </div>
          )}
        </Panel>
      </Split>
      {phone && (
        <Sheet open={sheetOpen && !!detail} title={detail ? `${detail.ref} ${detail.title}` : "Decision"} onClose={() => setSheetOpen(false)} testId="decision-sheet">
          {inspector}
        </Sheet>
      )}
      {proposing && can("create_decision") && (
        <ProposeDialog
          people={people}
          subject={subject}
          onClose={() => {
            setProposing(false);
            if (params.get("propose")) setParams({ propose: null });
          }}
          onProposed={async (d) => {
            setProposing(false);
            setParams({ d: String(d.number), state: "all", propose: null });
            await changed(d);
          }}
        />
      )}
    </>
  );
}
