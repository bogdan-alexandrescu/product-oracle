"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";

import { DocCrumb } from "@/components/DocToolbar";
import { peopleByIds } from "@/components/PersonPicker";
import {
  Button,
  Chip,
  DataTable,
  FilterChips,
  Inspector,
  InspectorSection,
  Notice,
  Page,
  PageHeader,
  Panel,
  Sheet,
  Split,
  ViewOnly,
  type ChipKind,
  type Column,
} from "@/components/ds";
import { INPUT } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useCompanyZone, zoneDateTime, zoneDay } from "@/lib/dates";
import { formatUsd, JOB_STATUS_LABEL, NO_ACCOUNT_REASON } from "@/lib/format";
import { useMe } from "@/lib/me";
import { useScreenSubject } from "@/lib/screen-subject";
import { errorMessage, useAuthRedirect, useQuery } from "@/lib/use-query";

type Readiness = Schemas["ReadinessDashboard"];
type Item = Schemas["ReadinessItem"];
type Status = Item["status"];
type Job = Schemas["LlmJobOut"];
type Report = Schemas["EvaluationReportOut"];
type Person = Schemas["PersonOut"];
type Draft = { status: Status | null; rationale: string; sections: string[] };
type Filter = "all" | "disagrees" | "unrated" | "skipped" | "hard";
type HistoryFilter = "all" | "rules" | "llm_job" | "human";

const STATUS: Record<Status, { kind: ChipKind; label: string; word: string }> = {
  pass: { kind: "pass", label: "Pass", word: "pass" },
  warning: { kind: "warn", label: "Warning", word: "warning" },
  critical: { kind: "crit", label: "Critical", word: "critical" },
  not_applicable: { kind: "na", label: "N/A", word: "n/a" },
};
const ORDER: Status[] = ["pass", "warning", "critical", "not_applicable"];
const ACTIVE: Job["status"][] = ["queued", "running"];
/** C's option, remembered on this browser: rules, model and people stay hidden until the rater picks. */
const BLIND_KEY = "po-quality-blind";
const PHONE = "(max-width: 600px)";
const EMPTY_DRAFT: Draft = { status: null, rationale: "", sections: [] };

function subscribePhone(onChange: () => void) {
  const mq = window.matchMedia(PHONE);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function useIsPhone(): boolean {
  return useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE).matches, () => false);
}

const Dash = ({ children }: { children: ReactNode }) => <span className="text-sm text-text2">{children}</span>;

function StatusChip({ status, testId }: { status: Status; testId?: string }) {
  const s = STATUS[status];
  return (
    <Chip kind={s.kind} data-testid={testId}>
      {s.label}
    </Chip>
  );
}

function agreed(item: Item): { k: number; n: number } | null {
  if (!item.human.length) return null;
  return { k: item.human.filter((h) => h.status === item.status).length, n: item.human.length };
}

function shortId(id: string) {
  return id.slice(0, 8);
}

/** Why a quality review job failed, in the pool's words when no account could take it. */
function failedWhy(job: Job): string {
  return (job.error_reason && NO_ACCOUNT_REASON[job.error_reason]) || job.error || "the job failed";
}

function countsLine(counts: unknown): string {
  const c = (counts ?? {}) as Record<string, number>;
  return ORDER.filter((s) => c[s]).map((s) => `${c[s]} ${STATUS[s].word}`).join(" · ");
}

/** Quality evaluation of a PRD version (v2 screen 5): criteria table, inspector, History. */
export function QualityView({ doc, n }: { doc: string; n: number }) {
  const { can } = useMe();
  const onAuth = useAuthRedirect();
  const zone = useCompanyZone();
  const phone = useIsPhone();
  const docQ = useQuery(`doc|${doc}`, () => unwrap(api.GET("/v1/documents/{doc}", { params: { path: { doc } } })));
  const d = docQ.data;
  useScreenSubject(d ? { kind: "document", subject: { document_id: d.id, version: n } } : null, d?.title);
  const readinessQ = useQuery(`quality|${doc}|${n}`, () =>
    unwrap(api.GET("/v1/documents/{doc}/versions/{n}/readiness", { params: { path: { doc, n } } })),
  );
  const readiness = readinessQ.data;
  const versionQ = useQuery(`version|${doc}|${n}`, () =>
    unwrap(api.GET("/v1/documents/{doc}/versions/{n}", { params: { path: { doc, n } } })).catch(() => undefined),
  );
  const jobsQ = useQuery(`quality-jobs|${doc}|${n}`, () =>
    unwrap(api.GET("/v1/documents/{doc}/llm-jobs", { params: { path: { doc } } })).then((all) =>
      all.filter((j) => j.kind === "quality_review" && j.version_number === n),
    ),
  );
  const versionId = readiness?.version_id;
  const reportsQ = useQuery(`quality-reports|${versionId}`, () =>
    versionId ? unwrap(api.GET("/v1/evaluation-reports", { params: { query: { version_id: versionId } } })) : Promise.resolve(undefined),
  );
  const jobs = useMemo(() => [...(jobsQ.data ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at)), [jobsQ.data]);
  const reports = reportsQ.data;

  const ids = [
    ...(reports ?? []).map((r) => r.created_by),
    ...(readiness?.items ?? []).flatMap((i) => [i.owner_id, ...i.human.map((h) => h.rater_id)]),
  ].filter((x): x is string => !!x);
  const idKey = [...new Set(ids)].sort().join(",");
  const peopleQ = useQuery(`people|${idKey}`, () => peopleByIds(idKey ? idKey.split(",") : []).catch(() => new Map<string, Person>()));
  const nameOf = (id: string | null | undefined) => (id ? (peopleQ.data?.get(id)?.name ?? "Someone") : "Oracle");

  const [filter, setFilter] = useState<Filter>("all");
  const [picked, setPicked] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [blind, setBlindState] = useState(() => typeof window !== "undefined" && localStorage.getItem(BLIND_KEY) === "1");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stored, setStored] = useState<string | null>(null);
  const [watched, setWatched] = useState<string | null>(null);

  const setBlind = (on: boolean) => {
    setBlindState(on);
    localStorage.setItem(BLIND_KEY, on ? "1" : "0");
  };

  const mayRate = can("create_human_rating");
  const maySnapshot = can("create_evaluation_report");
  const mayQueue = can("queue_quality_review");
  const mayRetry = can("retry_llm_job");
  const mayCancel = can("cancel_llm_job");
  const readOnly = !mayRate && !maySnapshot;

  const latestJob = jobs[0];
  const active = latestJob && ACTIVE.includes(latestJob.status) ? latestJob : null;

  // A queued or running review is polled until it ends; its report then fills the Model column.
  const activeId = active?.id;
  const reloadReadiness = readinessQ.reload;
  const reloadReports = reportsQ.reload;
  const setJobs = jobsQ.setData;
  useEffect(() => {
    if (!activeId) return;
    const timer = window.setInterval(async () => {
      const job = await unwrap(api.GET("/v1/llm-jobs/{job_id}", { params: { path: { job_id: activeId } } })).catch(() => null);
      if (!job || ACTIVE.includes(job.status)) return;
      setJobs((prev) => prev?.map((j) => (j.id === job.id ? job : j)));
      void reloadReadiness();
      void reloadReports();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [activeId, setJobs, reloadReadiness, reloadReports]);

  const items = useMemo(() => readiness?.items ?? [], [readiness]);
  const advisory = items.filter((i) => !i.hard);
  const indexOf = (key: string) => advisory.findIndex((i) => i.key === key) + 1;
  const hasModel = !!readiness?.model_review;
  const judged = advisory.filter((i) => i.model).length;
  const tests: Record<Filter, (i: Item) => boolean> = {
    all: () => true,
    disagrees: (i) => i.agreement.model === false,
    unrated: (i) => !i.hard && i.human.length === 0,
    skipped: (i) => !i.hard && hasModel && !i.model,
    hard: (i) => i.hard,
  };
  const rows = items.filter(tests[filter]);
  const selected = items.find((i) => i.key === picked) ?? (phone ? null : (rows[0] ?? null));
  const draftOf = (key: string) => drafts[key] ?? EMPTY_DRAFT;
  const hidden = (i: Item) => blind && mayRate && !i.hard && !draftOf(i.key).status;

  async function act(name: string, call: () => Promise<unknown>) {
    setBusy(name);
    setError(null);
    setStored(null);
    try {
      await call();
    } catch (e) {
      if (!onAuth(e)) setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const upsertJob = (job: Job) => {
    setJobs((prev) => [job, ...(prev ?? []).filter((j) => j.id !== job.id)]);
    setWatched(job.id);
  };
  const queueReview = () =>
    act("queue", async () => upsertJob(await unwrap(api.POST("/v1/documents/{doc}/versions/{n}/quality-review", { params: { path: { doc, n } } }))));
  const retry = (id: string) =>
    act("retry", async () => upsertJob(await unwrap(api.POST("/v1/llm-jobs/{job_id}/retry", { params: { path: { job_id: id } } }))));
  const cancel = (id: string) =>
    act("cancel", async () => {
      const job = await unwrap(api.POST("/v1/llm-jobs/{job_id}/cancel", { params: { path: { job_id: id } } }));
      setJobs((prev) => prev?.map((j) => (j.id === job.id ? job : j)));
    });
  const snapshot = () =>
    act("snapshot", async () => {
      await unwrap(api.POST("/v1/documents/{doc}/versions/{n}/evaluations", { params: { path: { doc, n } } }));
      await Promise.all([reloadReadiness(), reloadReports()]);
    });
  const submit = (item: Item) =>
    act("rate", async () => {
      const dr = draftOf(item.key);
      if (!dr.status) return;
      const out = await unwrap(
        api.POST("/v1/documents/{doc}/versions/{n}/evaluations/human", {
          params: { path: { doc, n } },
          body: { ratings: [{ criterion: item.key, status: dr.status, rationale: dr.rationale.trim(), section_keys: dr.sections }] },
        }),
      );
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[item.key];
        return next;
      });
      await Promise.all([reloadReadiness(), reloadReports()]);
      setStored(`Rating stored as human report ${shortId(out.id)} · ${zoneDateTime(out.created_at, zone)}.`);
    });

  const select = (key: string) => {
    setPicked(key);
    if (phone) setSheet(true);
  };

  const hiddenCell = <Dash>Hidden</Dash>;
  const columns: Column<Item>[] = [
    {
      key: "n",
      header: "#",
      width: "48px",
      phone: "hide",
      cell: (i) => <span className="tnum text-text2">{i.hard ? "" : indexOf(i.key)}</span>,
    },
    {
      key: "criterion",
      header: "Criterion",
      phone: "title",
      cell: (i) => (
        <span className="flex min-w-0 flex-col py-0.5">
          <span className="truncate font-medium">{i.title}</span>
          <span className="truncate text-sm text-text2 max-[600px]:hidden">{i.question}</span>
        </span>
      ),
    },
    {
      key: "rules",
      header: "Rules",
      width: "112px",
      phoneLabel: "Rules",
      cell: (i) =>
        hidden(i) ? (
          <span data-testid="rules-cell">{hiddenCell}</span>
        ) : (
          <span data-testid="rules-cell">
            {i.error ? (
              <Chip kind="crit" className="border border-dashed border-crit">
                Check failed
              </Chip>
            ) : (
              <StatusChip status={i.status} />
            )}
          </span>
        ),
    },
    {
      key: "model",
      header: "Model",
      width: "128px",
      phoneLabel: "Model",
      cell: (i) => (
        <span data-testid="model-cell">
          {i.hard ? (
            <Dash>Rules only</Dash>
          ) : hidden(i) ? (
            hiddenCell
          ) : !hasModel ? (
            <Dash>No model review</Dash>
          ) : i.model ? (
            <StatusChip status={i.model.status} />
          ) : (
            <Chip kind="na" className="border border-dashed border-line-strong">
              Skipped
            </Chip>
          )}
        </span>
      ),
    },
    {
      key: "people",
      header: "People",
      width: "148px",
      phoneLabel: "People",
      wrap: true,
      cell: (i) => (
        <span data-testid="people-cell" className="inline-flex flex-wrap gap-1">
          {i.hard ? (
            <Dash>Rules only</Dash>
          ) : hidden(i) ? (
            hiddenCell
          ) : i.human.length === 0 ? (
            <Dash>Not rated</Dash>
          ) : (
            ORDER.filter((s) => i.human.some((h) => h.status === s)).map((s) => (
              <Chip key={s} kind={STATUS[s].kind}>
                {`${i.human.filter((h) => h.status === s).length} ${STATUS[s].word}`}
              </Chip>
            ))
          )}
        </span>
      ),
    },
    {
      key: "agreement",
      header: "Agreement",
      width: "176px",
      phone: "hide",
      cell: (i) => {
        if (i.hard) return <span data-testid="agreement-cell"><Dash>—</Dash></span>;
        if (hidden(i)) return <span data-testid="agreement-cell">{hiddenCell}</span>;
        const people = agreed(i);
        const m = i.agreement.model;
        if (m == null && !people) return <span data-testid="agreement-cell"><Dash>No comparison</Dash></span>;
        return (
          <span data-testid="agreement-cell" className="text-sm">
            {m === false ? <Chip kind="warn">Model disagrees</Chip> : m === true ? "Model agrees" : "People"}
            {people && (
              <>
                {m != null ? " · " : " "}
                <b className="tnum">
                  {people.k}/{people.n}
                </b>
              </>
            )}
          </span>
        );
      },
    },
  ];

  const tally = (s: Status) => advisory.filter((i) => i.status === s).length;
  const filterItems = [
    { value: "all" as const, label: "All", count: items.length },
    { value: "disagrees" as const, label: "Model disagrees", count: items.filter(tests.disagrees).length },
    { value: "unrated" as const, label: "Not rated by people", count: items.filter(tests.unrated).length },
    ...(hasModel ? [{ value: "skipped" as const, label: "Model skipped", count: items.filter(tests.skipped).length }] : []),
    { value: "hard" as const, label: "Hard checks", count: items.filter(tests.hard).length },
  ];

  const detail = (item: Item) => (
    <CriterionInspector
      key={item.key}
      item={item}
      index={indexOf(item.key)}
      readiness={readiness!}
      hidden={hidden(item)}
      blind={blind}
      onBlind={setBlind}
      mayRate={mayRate}
      draft={draftOf(item.key)}
      onDraft={(dr) => setDrafts((prev) => ({ ...prev, [item.key]: dr }))}
      sections={versionQ.data?.sections ?? []}
      nameOf={nameOf}
      busy={busy === "rate"}
      onSubmit={() => submit(item)}
      doc={doc}
      n={n}
    />
  );

  const header = (
    <PageHeader
      testId="quality-header"
      back={<DocCrumb doc={d} withTitle />}
      title="Quality"
      suffix={`v${n}`}
      status={
        <>
          {readOnly && <ViewOnly />}
          {readiness && (
            <>
              <Chip kind="line" data-testid="policy-chip">
                Advisory policy
              </Chip>
              <Chip kind={readiness.blocked ? "crit" : "pass"} dot data-testid="blocked-chip">
                {readiness.blocked ? "Blocked" : "Not blocked"}
              </Chip>
              {hasModel && (
                <Chip kind="line" data-testid="model-chip">
                  Model reviewed {judged} of {advisory.length}
                </Chip>
              )}
            </>
          )}
        </>
      }
      action={
        (maySnapshot || mayQueue) && (
          <>
            {maySnapshot && (
              <Button disabled={busy != null || !readiness} onClick={snapshot}>
                Store rules snapshot
              </Button>
            )}
            {mayQueue && (
              <Button variant="primary" data-testid="page-queue-review" disabled={busy != null || !!active || !readiness} onClick={queueReview}>
                Queue model review
              </Button>
            )}
          </>
        )
      }
    />
  );

  const done = latestJob && latestJob.id === watched && latestJob.status === "succeeded" ? latestJob : null;
  const failed = latestJob?.status === "failed" ? latestJob : null;

  return (
    <Page>
      {header}
      <div className="flex flex-col gap-3 pb-4">
        {docQ.error && <Notice tone="error">{docQ.error}</Notice>}
        {readinessQ.error && (
          <Notice
            tone="error"
            testId="quality-error"
            action={
              <Button variant="ghost" onClick={() => void readinessQ.reload()}>
                Retry
              </Button>
            }
          >
            {readinessQ.error}
          </Notice>
        )}
        {error && (
          <Notice tone="error" testId="action-error">
            {error}
          </Notice>
        )}
        {stored && (
          <Notice tone="pass" testId="rating-stored">
            {stored}
          </Notice>
        )}
        {readiness?.model_review ? (
          <Notice testId="model-disclaimer">
            {readiness.model_review.disclaimer}{" "}
            <span className="font-mono text-[13px]">
              {[readiness.model_review.model, zoneDateTime(readiness.model_review.created_at, zone)].filter(Boolean).join(" · ")}
            </span>
          </Notice>
        ) : (
          readiness && <Notice testId="no-model-review">No model review for v{n} yet.{mayQueue ? "" : " An approver can queue one."}</Notice>
        )}
        {active && (
          <Notice
            testId="job-active"
            action={
              mayCancel && (
                <Button variant="ghost" disabled={busy != null} onClick={() => cancel(active.id)}>
                  Cancel
                </Button>
              )
            }
          >
            <Chip kind="acc" dot>
              {JOB_STATUS_LABEL[active.status]}
            </Chip>{" "}
            Quality review · <span className="font-mono">{shortId(active.id)}</span> · attempt {Math.max(1, active.attempts)}
            {active.error_reason && ` · ${NO_ACCOUNT_REASON[active.error_reason] ?? active.error_reason}`}
            {active.next_reset_at && ` Next reset ${zoneDateTime(active.next_reset_at, zone)}.`}
          </Notice>
        )}
        {failed && (
          <Notice
            tone="error"
            testId="job-failed"
            action={
              mayRetry && (
                <Button variant="ghost" disabled={busy != null} onClick={() => retry(failed.id)}>
                  Retry
                </Button>
              )
            }
          >
            Quality review failed: {failedWhy(failed)}
            {failed.next_reset_at && ` Next reset ${zoneDateTime(failed.next_reset_at, zone)}.`}
          </Notice>
        )}
        {done && (
          <Notice tone="pass" testId="job-done">
            Model review done: {String(done.output?.criteria ?? 0)} criteria judged
            {countsLine(done.output?.counts) && ` · ${countsLine(done.output?.counts)}`}
            {done.input_tokens != null && (
              <span className="font-mono text-[13px]">
                {" "}
                {done.input_tokens} in · {done.output_tokens ?? 0} out · {formatUsd(done.cost_usd)}
              </span>
            )}
          </Notice>
        )}
      </div>

      <Split inspector={!phone && selected && readiness ? detail(selected) : undefined}>
        <Panel
          title="Criteria"
          count={readiness ? items.length : undefined}
          testId="criteria-panel"
          tools={
            readiness && (
              <span className="flex flex-wrap gap-1.5">
                {ORDER.filter((s) => tally(s)).map((s) => (
                  <Chip key={s} kind={STATUS[s].kind}>
                    {tally(s)} {STATUS[s].word}
                  </Chip>
                ))}
              </span>
            )
          }
        >
          {readiness && (
            <div className="border-b border-line px-4 py-2.5 max-[600px]:px-3">
              <FilterChips label="Show criteria" items={filterItems} value={filter} onChange={setFilter} />
            </div>
          )}
          <DataTable<Item>
            label="Criteria"
            columns={columns}
            rows={readiness ? rows : undefined}
            rowKey={(i) => i.key}
            loading={readinessQ.loading && !readiness}
            selected={selected?.key ?? null}
            onSelect={(k) => select(k)}
            group={(i) => (i.hard ? "Hard checks" : "Advisory")}
            groupLabel={(g) => (
              <>
                {g}
                <span className="ml-2 font-display text-accent-ink">{items.filter((i) => (g === "Advisory" ? !i.hard : i.hard)).length}</span>
              </>
            )}
            rowProps={(i) => ({ "data-testid": "criterion-row", "data-key": i.key })}
            empty="No criteria match this filter"
          />
          {readiness && (
            <p className="border-t border-line px-4 py-2.5 text-[13px] text-text2 max-[600px]:px-3" data-testid="latest-report">
              Evaluated {zoneDateTime(readiness.evaluated_at, zone)}
              {readiness.composition_revision != null && (
                <>
                  {" "}
                  · composition rev <span className="font-mono">r{readiness.composition_revision}</span>
                </>
              )}
              {" · "}
              {readiness.latest_report ? (
                <>
                  Latest stored report <span className="font-mono">{shortId(readiness.latest_report.id)}</span> ·{" "}
                  {zoneDateTime(readiness.latest_report.created_at, zone)}
                </>
              ) : (
                "No stored report"
              )}
              {" · "}no numeric score: the policy is advisory and only a critical hard check blocks.
            </p>
          )}
        </Panel>

        <HistoryPanel
          n={n}
          reports={reports}
          loading={reportsQ.loading || !readiness}
          error={reportsQ.error}
          jobs={jobs}
          nameOf={nameOf}
          zone={zone}
          mayRetry={mayRetry}
          mayCancel={mayCancel}
          busy={busy != null}
          onRetry={retry}
          onCancel={cancel}
        />
      </Split>

      {phone && selected && readiness && (
        <Sheet open={sheet} title={selected.title} onClose={() => setSheet(false)} testId="sheet-criterion">
          {detail(selected)}
        </Sheet>
      )}
    </Page>
  );
}

function CriterionInspector({
  item,
  index,
  readiness,
  hidden,
  blind,
  onBlind,
  mayRate,
  draft,
  onDraft,
  sections,
  nameOf,
  busy,
  onSubmit,
  doc,
  n,
}: {
  item: Item;
  index: number;
  readiness: Readiness;
  hidden: boolean;
  blind: boolean;
  onBlind: (on: boolean) => void;
  mayRate: boolean;
  draft: Draft;
  onDraft: (d: Draft) => void;
  sections: { section_key: string; heading: string }[];
  nameOf: (id: string | null | undefined) => string;
  busy: boolean;
  onSubmit: () => void;
  doc: string;
  n: number;
}) {
  const zone = useCompanyZone();
  const people = agreed(item);
  const firstSection = item.section_keys[0];
  const stats = item.hard || hidden
    ? undefined
    : [
        {
          label: "Model agrees with rules",
          value: item.agreement.model == null ? "—" : item.agreement.model ? "Yes" : "No",
          testId: "stat-model-agrees",
        },
        people
          ? { label: "People agree with rules", value: people.k, of: people.n, testId: "stat-people-agree" }
          : { label: "No human ratings yet", value: "—", testId: "stat-people-agree" },
      ];
  const tags = (keys: string[]) =>
    keys.length > 0 && (
      <span className="flex flex-wrap gap-1">
        {keys.map((k) => (
          <span key={k} className="rounded-goal bg-surface2 px-1.5 font-mono text-[13px] text-text2">
            {k}
          </span>
        ))}
      </span>
    );

  return (
    <Inspector
      testId="quality-inspector"
      label={item.title}
      eyebrow={
        <>
          {item.hard ? "Hard check" : `Advisory criterion ${index}`} · <span className="font-mono">{item.key}</span>
        </>
      }
      title={item.title}
      action={
        firstSection ? (
          <Link
            href={`/documents/${doc}/v/${n}#${firstSection}`}
            className="inline-flex h-8 items-center rounded-lg border border-hero-text2 px-3 text-sm text-hero-text hover:bg-hero-2"
          >
            Open sections
          </Link>
        ) : undefined
      }
      chips={
        <>
          {!hidden && (
            <Chip hero>
              Rules: {item.error ? "check failed" : STATUS[item.status].word}
            </Chip>
          )}
          <Chip hero>{item.hard ? "Hard · blocks when critical" : "Advisory · never blocks"}</Chip>
        </>
      }
      stats={stats}
    >
      <InspectorSection label="Question">
        <p className="text-[15px]">{item.question}</p>
      </InspectorSection>

      <InspectorSection label="What each evaluator said">
        {hidden ? (
          <p data-testid="hidden-until-pick" className="text-sm text-text2">
            Rules, model and other people&apos;s ratings are hidden until you pick a status.
          </p>
        ) : (
          <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-3 text-[15px]">
            <Said who="Rules">
              {item.error ? (
                <>
                  <span>
                    <Chip kind="crit">Check failed</Chip>
                  </span>
                  <p className="text-sm text-crit">The check could not run: {item.error}</p>
                </>
              ) : (
                <span>
                  <StatusChip status={item.status} />
                </span>
              )}
              <p>{item.rationale}</p>
              {tags([...item.section_keys, ...item.evidence_ids.map(shortId)])}
            </Said>
            {!item.hard && (
              <Said who="Model">
                {item.model ? (
                  <>
                    <span>
                      <StatusChip status={item.model.status} />
                    </span>
                    <p>{item.model.rationale}</p>
                    {tags(item.model.section_keys)}
                  </>
                ) : (
                  <p className="text-sm text-text2">
                    {readiness.model_review ? "The model did not judge this criterion." : `No model review for v${readiness.version} yet.`}
                  </p>
                )}
              </Said>
            )}
            {item.human.map((h) => (
              <Said key={`${h.rater_id}-${h.report_id}`} who={nameOf(h.rater_id)}>
                <span className="flex items-center gap-2">
                  <StatusChip status={h.status} />
                  <span className="text-[13px] text-text2">{zoneDay(h.created_at, zone)}</span>
                </span>
                <p>{h.rationale}</p>
              </Said>
            ))}
          </dl>
        )}
      </InspectorSection>

      {item.owner_id && (
        <InspectorSection label="Owner">
          <p className="text-[15px] font-medium">{nameOf(item.owner_id)}</p>
        </InspectorSection>
      )}

      <InspectorSection label="Your rating">
        {item.hard ? (
          <p className="text-sm text-text2">Rules only: people do not rate hard checks.</p>
        ) : !mayRate ? (
          <p className="text-sm text-text2">Commenters and above can rate this criterion.</p>
        ) : (
          <RatingForm
            draft={draft}
            onDraft={onDraft}
            blind={blind}
            onBlind={onBlind}
            sections={sections}
            busy={busy}
            onSubmit={onSubmit}
          />
        )}
      </InspectorSection>
    </Inspector>
  );
}

function Said({ who, children }: { who: string; children: ReactNode }) {
  return (
    <div data-testid="evaluator" className="contents">
      <dt className="pt-0.5 text-[13px] font-semibold text-text2">{who}</dt>
      <dd className="flex min-w-0 flex-col gap-1.5 break-words">{children}</dd>
    </div>
  );
}

function RatingForm({
  draft,
  onDraft,
  blind,
  onBlind,
  sections,
  busy,
  onSubmit,
}: {
  draft: Draft;
  onDraft: (d: Draft) => void;
  blind: boolean;
  onBlind: (on: boolean) => void;
  sections: { section_key: string; heading: string }[];
  busy: boolean;
  onSubmit: () => void;
}) {
  const left = sections.filter((s) => !draft.sections.includes(s.section_key));
  const ready = !!draft.status && draft.rationale.trim().length > 0;
  return (
    <div data-testid="rating-form" className="flex flex-col gap-3">
      <label className="flex min-h-8 items-center gap-2 text-sm">
        <input type="checkbox" checked={blind} onChange={(e) => onBlind(e.target.checked)} className="size-4 accent-[var(--accent)]" />
        Hide rules, model and other people until I pick
      </label>
      <div role="group" aria-label="Status" className="flex flex-wrap gap-1">
        {ORDER.map((s) => {
          const on = draft.status === s;
          return (
            <button
              key={s}
              type="button"
              aria-pressed={on}
              onClick={() => onDraft({ ...draft, status: s })}
              className={`flex h-8 items-center rounded-full border px-3 text-sm font-medium max-[639px]:h-11 ${
                on ? "border-accent bg-accent text-on-accent" : "border-line-strong bg-surface text-text hover:bg-surface2"
              }`}
            >
              {STATUS[s].label}
            </button>
          );
        })}
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-semibold text-text2">Rationale</span>
        <textarea
          className={`${INPUT} min-h-20`}
          value={draft.rationale}
          maxLength={4000}
          onChange={(e) => onDraft({ ...draft, rationale: e.target.value })}
        />
      </label>
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-semibold text-text2">Sections</span>
        <div className="flex flex-wrap items-center gap-1.5">
          {draft.sections.map((k) => (
            <button
              key={k}
              type="button"
              aria-label={`Remove section ${k}`}
              onClick={() => onDraft({ ...draft, sections: draft.sections.filter((x) => x !== k) })}
              className="inline-flex h-7 items-center gap-1 rounded-goal bg-surface2 px-2 font-mono text-[13px] text-text2 hover:text-text"
            >
              <span data-testid="picked-section">{k}</span>
              <span aria-hidden>×</span>
            </button>
          ))}
          {left.length > 0 && (
            <select
              aria-label="Add a section"
              className={`${INPUT} w-auto max-w-full`}
              value=""
              onChange={(e) => e.target.value && onDraft({ ...draft, sections: [...draft.sections, e.target.value] })}
            >
              <option value="">+ Section</option>
              {left.map((s) => (
                <option key={s.section_key} value={s.section_key}>
                  {s.heading}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-[13px] text-text2">Submits one human report for this criterion</span>
        <Button variant="primary" disabled={!ready || busy} onClick={onSubmit}>
          Submit rating
        </Button>
      </div>
    </div>
  );
}

type HistoryRow =
  | { kind: "report"; id: string; at: string; report: Report; job: Job | undefined }
  | { kind: "job"; id: string; at: string; job: Job };

const EVALUATOR_LABEL: Record<string, string> = { rules: "Rules snapshot", human: "Human rating", llm_job: "Model review" };

function HistoryPanel({
  n,
  reports,
  loading,
  error,
  jobs,
  nameOf,
  zone,
  mayRetry,
  mayCancel,
  busy,
  onRetry,
  onCancel,
}: {
  n: number;
  reports: Report[] | undefined;
  loading: boolean;
  error: string | null;
  jobs: Job[];
  nameOf: (id: string | null | undefined) => string;
  zone: string;
  mayRetry: boolean;
  mayCancel: boolean;
  busy: boolean;
  onRetry: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const reported = new Set((reports ?? []).map((r) => (typeof r.summary.job_id === "string" ? r.summary.job_id : null)).filter(Boolean));
  const all: HistoryRow[] | undefined = reports && [
    ...reports.map((r): HistoryRow => ({
      kind: "report",
      id: r.id,
      at: r.created_at,
      report: r,
      job: typeof r.summary.job_id === "string" ? byId.get(r.summary.job_id) : undefined,
    })),
    // A model job with no report yet (queued, running, failed or cancelled).
    ...jobs.filter((j) => j.status !== "succeeded" && !reported.has(j.id)).map((j): HistoryRow => ({ kind: "job", id: j.id, at: j.created_at, job: j })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const evaluatorOf = (r: HistoryRow) => (r.kind === "job" ? "llm_job" : r.report.evaluator);
  const rows = all?.filter((r) => filter === "all" || evaluatorOf(r) === filter);
  const count = (f: HistoryFilter) => all?.filter((r) => evaluatorOf(r) === f).length ?? null;

  const columns: Column<HistoryRow>[] = [
    {
      key: "what",
      header: "Report",
      phone: "title",
      wrap: true,
      cell: (r) => {
        const ev = evaluatorOf(r);
        const by = r.kind === "job" ? r.job.requested_by : r.report.created_by;
        const model = r.kind === "job" ? r.job.model : r.job?.model;
        return (
          <span className="flex min-w-0 flex-col py-0.5">
            <span className="font-medium">
              {EVALUATOR_LABEL[ev] ?? ev} · {nameOf(by)}
            </span>
            <span className="text-sm text-text2">
              {zoneDateTime(r.at, zone)} · <span className="font-mono">{shortId(r.id)}</span>
              {model && <> · {model}</>}
              {r.kind === "report" && typeof r.report.summary.note === "string" && r.report.summary.note && <> · “{r.report.summary.note}”</>}
            </span>
          </span>
        );
      },
    },
    {
      key: "result",
      header: "Result",
      width: "34%",
      wrap: true,
      cell: (r) => {
        if (r.kind === "job") {
          return r.job.status === "failed" ? (
            <span className="text-sm text-crit">{failedWhy(r.job)}</span>
          ) : (
            <span className="text-sm text-text2">Attempt {Math.max(1, r.job.attempts)}</span>
          );
        }
        const s = r.report.summary;
        const errors = Array.isArray(s.errors) ? s.errors.length : 0;
        return (
          <span className="flex flex-wrap items-center gap-1.5 text-sm">
            {countsLine(s.counts) || "—"}
            {s.blocked === true && <Chip kind="crit">Blocked</Chip>}
            {errors > 0 && <Chip kind="warn">{errors} check error{errors === 1 ? "" : "s"}</Chip>}
          </span>
        );
      },
    },
    {
      key: "status",
      header: "Status",
      width: "200px",
      phone: "action",
      cell: (r) => {
        const job = r.kind === "job" ? r.job : r.job;
        if (!job) return <Chip kind="pass">Stored</Chip>;
        const kind: ChipKind = job.status === "failed" ? "crit" : job.status === "succeeded" ? "pass" : job.status === "cancelled" ? "na" : "acc";
        return (
          <span className="inline-flex items-center gap-1.5">
            <Chip kind={kind} dot={ACTIVE.includes(job.status)}>
              {JOB_STATUS_LABEL[job.status]}
            </Chip>
            {job.status === "succeeded" && job.cost_usd != null && <span className="text-sm text-text2">{formatUsd(job.cost_usd)}</span>}
            {mayCancel && ACTIVE.includes(job.status) && (
              <Button variant="ghost" disabled={busy} onClick={() => onCancel(job.id)}>
                Cancel
              </Button>
            )}
            {mayRetry && (job.status === "failed" || job.status === "cancelled") && (
              <Button variant="ghost" disabled={busy} onClick={() => onRetry(job.id)}>
                Retry
              </Button>
            )}
          </span>
        );
      },
    },
  ];

  return (
    <Panel
      title="History"
      count={all?.length}
      testId="quality-history"
      tools={
        all && (
          <FilterChips
            label="Show reports"
            value={filter}
            onChange={setFilter}
            items={[
              { value: "all", label: "All", count: all.length },
              { value: "rules", label: "Rules", count: count("rules") },
              { value: "llm_job", label: "Model", count: count("llm_job") },
              { value: "human", label: "Human", count: count("human") },
            ]}
          />
        )
      }
    >
      {error && (
        <div className="p-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      <DataTable<HistoryRow>
        label="History"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={loading && !all}
        rowProps={() => ({ "data-testid": "history-row" })}
        empty={all && all.length === 0 ? `No evaluation reports for v${n} yet` : "No reports match this filter"}
      />
    </Panel>
  );
}
