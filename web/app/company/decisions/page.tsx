"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";

import { Button, Chip, type Column, DataTable, FilterChips, InfoTip, PageSkeleton, Panel, Sheet, Split } from "@/components/ds";
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
  const { me, can, capsReady } = useMe();
  // qa-company-30: Needs me is for who can be named approver (approver and above, as the API's
  // approver-level decision operation says); a viewer or a commenter never sees it.
  const mayApprove = can("recommend_decision_options");
  const stateFilters = STATE_FILTERS.filter((s) => s.value !== "needs_me" || mayApprove);
  const phone = useIsPhone();
  const run = params.get("run");
  const subjectParam = params.get("subject");
  const cls = (params.get("class") as ClassFilter | null) ?? (run ? "checkpoint" : "judgement");
  const from = params.get("from") ?? "";
  const q = params.get("q") ?? "";
  const [search, setSearch] = useState(q);
  // qa-company-9: the list follows the search as it is typed, once typing pauses.
  useEffect(() => {
    const next = search.trim();
    if (next === q) return;
    const timer = window.setTimeout(() => setParams({ q: next || null, d: null }), 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
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
  const urlState = params.get("state") as StateFilter | null;
  const stateParam: StateFilter | null = urlState === "needs_me" && capsReady && !mayApprove ? "all" : urlState;
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
  // The count of what the filters choose from (the run or subject, every kind), so a filter
  // that hides rows reads "2 of 5", never a bare 0 (qa-company-10: the Kind filter too).
  const baseQuery: ListQuery = { run_id: run ?? undefined, subject_kind: subject?.kind, subject_id: subject?.id };
  const baseKey = JSON.stringify(baseQuery);
  const totalQ = useQuery(`decisions|total|${baseKey}`, () => loadPages(baseQuery, 1), { keepPrevious: true });
  const total = totalQ.data ? `${totalQ.data.rows.length}${totalQ.data.more ? "+" : ""}` : null;
  const filtered = (state !== null && state !== "all") || !!from || !!q;
  // What hides rows, in words, for the empty list.
  // qa-company-27: the search reads as itself ("No decisions match “zzzz”."), the filters by name.
  const hiding = [
    state && state !== "all" ? `State: ${STATE_FILTERS.find((s) => s.value === state)?.label}` : null,
    fromDef ? `From: ${fromDef.label}` : null,
  ].filter((x): x is string => !!x);
  const noMatch = q
    ? `No decisions match \u201c${q}\u201d${hiding.length > 0 ? ` with ${hiding.join(", ")}` : ""}.`
    : `No decisions match ${hiding.join(", ")}.`;
  const clsLabel = cls === "checkpoint" ? "checkpoint decisions" : "judgement calls";
  const clearFilters = () => {
    setSearch("");
    // Every filter, the kind too: one click brings the rows back.
    setParams({ state: "all", from: null, q: null, d: null, ...(cls !== "all" ? { class: "all" } : {}) });
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
      // qa-company-39: the number in body text, not a link-coloured code.
      cell: (d) => <span className="tnum text-sm">{d.ref}</span>,
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
      width: "150px",
      phone: "hide",
      // qa-company-39: the approver's name, not their initials (cut with an ellipsis, whole on hover).
      cell: (d) => {
        const name = nameOf(d.approver_id, d.approver_email);
        return (
          <span data-col="approver" className="block truncate text-sm" title={name ? `${name}${d.approver_email ? ` · ${d.approver_email}` : ""}` : undefined}>
            {name ?? "—"}
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
  // qa4-company-15: beside the list the inspector's column stays while nothing is open, so the
  // filter chips keep their place when a kind with no decisions is picked. At 1100 px and
  // below the layout is one column, so the empty panel would sit under the list: it hides.
  const besideList = inspector ?? (
    <Panel testId="decision-inspector-empty" className="max-[1100px]:hidden">
      <p className="px-4 py-8 text-center text-[15px] text-text2">{listQ.data && rows.length === 0 ? "No decision to show." : "Pick a decision to see it here."}</p>
    </Panel>
  );
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
      <Split inspector={!phone ? besideList : undefined}>
        <Panel
          title="Decisions"
          count={listQ.data ? (total !== null && total !== String(rows.length) ? `${rows.length} of ${total}` : rows.length) : undefined}
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
                    {stateFilters.map((s) => (
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
                    items={stateFilters.map((s) => ({ value: s.value, label: s.label }))}
                    value={state ?? "all"}
                    onChange={(v) => setParams({ state: v, d: null })}
                  />
                </FilterRow>
                {/* qa-company-28: From is chips too, like Kind and State. */}
                <FilterRow label="From">
                  <FilterChips
                    label="From"
                    testId="decision-from"
                    items={[{ value: "", label: "Anywhere" }, ...FROM.map((f) => ({ value: f.value, label: f.label }))]}
                    value={from}
                    onChange={(v) => setParams({ from: v || null, d: null })}
                  />
                </FilterRow>
              </>
            )}
            <div className="flex flex-wrap items-center gap-2 max-[600px]:flex-col max-[600px]:items-stretch">
              {phone && (
                <label className="flex flex-col items-stretch gap-1 text-sm font-semibold text-text2">
                  From
                  <select aria-label="From" className={INPUT} value={from} onChange={(e) => setParams({ from: e.target.value || null, d: null })}>
                    <option value="">Anywhere</option>
                    {FROM.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
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
                <p>
                  {hiding.length > 0 || q
                    ? noMatch
                    : cls === "all"
                      ? "No decisions here yet."
                      : `No ${clsLabel}.`}
                  {/* qa4-company-16: a checkpoint still waiting is in the Inbox, not here. */}
                  {!(hiding.length > 0 || q) && cls === "checkpoint" && (
                    <>
                      {" "}
                      A run checkpoint shows here once it is approved or sent back; one still waiting is in the{" "}
                      <Link href="/inbox" className="font-medium text-accent-ink hover:underline">
                        Inbox
                      </Link>
                      .
                    </>
                  )}
                </p>
              )}
              {/* qa-company-10: the Kind filter alone hides every row: one step back to all kinds. */}
              {!filtered && cls !== "all" && (
                <Button onClick={() => setClass("all")} data-testid="decisions-all-kinds">
                  Show all kinds
                </Button>
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
        <Sheet open={sheetOpen && !!detail} title="Decision" onClose={() => setSheetOpen(false)} testId="decision-sheet">
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
