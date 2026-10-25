"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { onJobSettingsChanged, usePolling } from "@/components/JobsPanel";
import { Button, Chip, Icon, InfoTip, Notice } from "@/components/ds";
import { JobStatusChip } from "@/components/review/parts";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatDateTime, NO_ACCOUNT_REASON, turnedOff } from "@/lib/format";
import { useMe } from "@/lib/me";
import { useLive } from "@/lib/use-live";
import { errorMessage, useQuery } from "@/lib/use-query";
import { invalidateWaiting, onWaitingChanged, waitingChanged } from "@/lib/waiting";

type Staged = Schemas["StagedChanges"];
type StagedItem = Schemas["StagedChange"];
type Preview = Schemas["NextDraftPreview"];
type PreviewSection = Schemas["NextDraftSection"];
type AgentItem = Schemas["AgentItem"];
type Plan = Schemas["NextDraftPlan"];
/** What Build sends: the ticked text changes and items for the agents, and the engine the plan chose. */
type Choice = { engine: Plan["engine"]; suggestion_ids: string[]; feedback_ids: string[]; next_draft_change_ids: string[] };

/** `?build=1` on a document page (the Inbox's "Build draft" action) opens the sheet. */
export const BUILD_PARAM = "build";

const building = (status?: string | null) => status === "queued" || status === "running";

/**
 * C1e: "Build draft N+1 · K staged" next to Publish when accepted changes or items staged
 * for the agents wait for the next draft (or a build is in progress). Opens the build
 * sheet: pick the staged items; D12: the sheet says which engine builds them and why.
 * Oracle builds text changes in one job, with one combined preview applied as exactly one
 * version; the agents write the draft in a feedback-loop run.
 */
export function BuildDraftButton({ doc }: { doc: string }) {
  const { can } = useMe();
  const canBuild = can("build_next_draft");
  const [reload, setReload] = useState(0);
  const q = useQuery(`staged|${doc}|${reload}`, () =>
    unwrap(
      api.GET("/v1/documents/{doc}/staged-changes", {
        params: { path: { doc } },
      }),
    ),
  );
  // The refinement switch (History › Oracle's work): off means a build would be refused with a 409.
  // An owner may flip it in History on this page: read it again then.
  const [swReload, setSwReload] = useState(0);
  const sw = useQuery(`llm-settings|${doc}|${swReload}`, () =>
    unwrap(api.GET("/v1/documents/{doc}/llm-jobs/settings", { params: { path: { doc } } })),
  );
  const refinementOff = sw.data?.refinement === false;
  useEffect(() => onJobSettingsChanged(doc, () => setSwReload((k) => k + 1)), [doc]);
  // The sheet opens on arrival from the Inbox's "Build draft" (?build=1); the button shows
  // only once the staged list has loaded on the client, so the server render never differs.
  const [open, setOpen] = useState(
    () => typeof window !== "undefined" && !!new URLSearchParams(window.location.search).get(BUILD_PARAM),
  );
  // Accepting or dismissing a suggestion elsewhere on the page changes what is staged.
  useEffect(() => onWaitingChanged(() => setReload((k) => k + 1)), []);

  const data = q.data;
  if (!canBuild || !data) return null;
  const job = data.draft_job;
  const count = data.items.length + data.agent_items.length + (data.next_draft_changes ?? []).length;
  if (!count && !job) return null;
  const label = building(job?.status)
    ? `Building draft ${data.next_version}`
    : job?.status === "succeeded"
      ? `Draft ${data.next_version} ready`
      : `Build draft ${data.next_version}`;
  // The agents need no Refinement job: only a text-only build is switched off.
  if (refinementOff && !job && !data.agent_items.length) {
    return (
      <Button
        variant="secondary"
        icon="doc"
        disabled
        title={turnedOff("refinement")}
        aria-label={`${label}: ${turnedOff("refinement")}`}
        data-testid="build-draft"
      >
        {label}
      </Button>
    );
  }
  return (
    <>
      <Button
        variant="secondary"
        icon="doc"
        onClick={() => setOpen(true)}
        data-testid="build-draft"
        aria-haspopup="dialog"
        title={data.worth_a_draft ?? undefined}
      >
        {label}
        {count > 0 && (
          <span className="tnum font-semibold opacity-85" data-testid="build-draft-count">
            · {count} staged
          </span>
        )}
      </Button>
      {open &&
        createPortal(
          <NextDraftSheet
            doc={doc}
            staged={data}
            onClose={() => {
              setOpen(false);
              setReload((k) => k + 1);
            }}
          />,
          document.body,
        )}
    </>
  );
}

/** The sheet's frame: a dark head (eyebrow, title, chips) and a body; Escape closes. */
function Sheet({
  eyebrow,
  title,
  chips,
  onClose,
  children,
  footer,
}: {
  eyebrow: string;
  title: string;
  chips?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const id = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-hero/50 px-4 py-10 max-[600px]:px-2 max-[600px]:py-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        data-testid="next-draft-sheet"
        className="w-full max-w-3xl overflow-hidden rounded-inspector border border-line bg-surface text-text shadow-tip"
      >
        <div className="bg-hero px-5 pt-4 pb-[18px] text-hero-text max-[600px]:px-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px] leading-4 font-semibold tracking-[0.02em] text-hero-text2">{eyebrow}</span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="grid size-8 place-items-center rounded-lg text-hero-text2 hover:bg-hero-2 hover:text-hero-text"
            >
              <Icon name="x" size={20} />
            </button>
          </div>
          <h2 id={`${id}-title`} className="mt-1 font-display text-[22px] leading-[27px] font-bold tracking-heading">
            {title}
          </h2>
          {chips && <div className="mt-2 flex flex-wrap items-center gap-2">{chips}</div>}
        </div>
        <div className="space-y-4 px-5 py-4 text-[15px] max-[600px]:px-4">{children}</div>
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3 max-[600px]:px-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/** "v5 → v6": the version a build starts from and the draft it makes. */
function VersionStep({ from, to }: { from: number | null | undefined; to: number | null | undefined }) {
  return (
    <span className="inline-flex items-center gap-1" aria-label={`v${from} to v${to}`}>
      v{from}
      <Icon name="arrow" size={16} />v{to}
    </span>
  );
}

function HeroChip({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "accent" }) {
  return (
    <span
      className={`tnum inline-flex h-[26px] items-center gap-1.5 rounded-full px-2.5 text-[13px] font-semibold ${
        tone === "accent" ? "bg-accent-soft text-accent-ink" : "bg-hero-2 text-hero-text"
      }`}
    >
      {children}
    </span>
  );
}

/** Pick → build (progress) → combined preview → apply, or discard (everything stays staged). */
export function NextDraftSheet({ doc, staged, onClose }: { doc: string; staged: Staged; onClose: () => void }) {
  const router = useRouter();
  const [jobId, setJobId] = useState<string | null>(staged.draft_job?.id ?? null);
  const [runId, setRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = staged.next_version;

  // The build's preview; while it runs, its job status only (polled).
  const pq = useQuery(`next-draft|${doc}|${jobId}`, () =>
    jobId
      ? unwrap(
          api.GET("/v1/documents/{doc}/next-draft/{job_id}", {
            params: { path: { doc, job_id: jobId } },
          }),
        )
      : Promise.resolve(null),
  );
  const preview: Preview | null = pq.data ?? null;
  const load = pq.reload;
  usePolling(!!jobId && (!preview || building(preview.job.status)), load);

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

  const build = ({ engine, suggestion_ids, feedback_ids, next_draft_change_ids }: Choice) =>
    act(async () => {
      const body = { suggestion_ids, feedback_ids, next_draft_change_ids, depth: "standard" as const };
      if (engine === "agents") {
        // D12: the agents write the draft in a feedback-loop run; its page follows it.
        const run = await unwrap(api.POST("/v1/documents/{doc}/next-draft/run", { params: { path: { doc } }, body }));
        setRunId(run.id);
        invalidateWaiting();
        waitingChanged();
        router.push(`/runs/${run.id}`);
        return;
      }
      const job = await unwrap(api.POST("/v1/documents/{doc}/next-draft", { params: { path: { doc } }, body }));
      setJobId(job.id);
    });

  const discard = () =>
    act(async () => {
      if (jobId)
        await unwrap(
          api.POST("/v1/documents/{doc}/next-draft/{job_id}/discard", {
            params: { path: { doc, job_id: jobId } },
          }),
        );
      invalidateWaiting();
      waitingChanged();
      onClose();
    });

  const retry = () =>
    act(async () => {
      if (!jobId) return;
      await unwrap(
        api.POST("/v1/llm-jobs/{job_id}/retry", {
          params: { path: { job_id: jobId } },
        }),
      );
      await load();
    });

  const apply = (drop: string[]) =>
    act(async () => {
      if (!jobId) return;
      const v = await unwrap(
        api.POST("/v1/documents/{doc}/next-draft/{job_id}/apply", {
          params: { path: { doc, job_id: jobId } },
          body: { drop_sections: drop, edits: {} },
        }),
      );
      invalidateWaiting();
      waitingChanged();
      onClose();
      router.push(`/documents/${doc}/v/${v.number}?tab=reports`);
    });

  if (runId)
    return (
      <Sheet eyebrow="Next draft" title={`Agents are writing draft ${next}`} onClose={onClose}>
        <p className="text-text2" data-testid="agents-writing">
          The draft comes back as version {next} with its run review.{" "}
          <Link href={`/runs/${runId}`} className="font-semibold text-accent-ink underline-offset-2 hover:underline">
            Open the run
          </Link>
        </p>
      </Sheet>
    );
  if (!jobId) return <PickStep staged={staged} busy={busy} error={error} onBuild={build} onClose={onClose} />;

  const job = preview?.job;
  const chips = (
    <>
      <HeroChip>
        <VersionStep from={preview?.base_version ?? staged.latest_version} to={preview?.next_version ?? next} />
      </HeroChip>
      {job && <JobStatusChip status={job.status} />}
    </>
  );

  if (!preview || building(job?.status) || job?.status === "failed" || job?.status === "cancelled") {
    return (
      <Sheet
        eyebrow="Next draft"
        title={`Building draft ${next}`}
        chips={chips}
        onClose={onClose}
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={discard}>
              Discard
            </Button>
            {job?.status === "failed" && (
              <Button variant="primary" disabled={busy} onClick={retry}>
                Retry
              </Button>
            )}
          </>
        }
      >
        {job?.status === "failed" ? (
          <Notice tone="error">
            {job.error ?? "The build failed"} {job.error_reason && NO_ACCOUNT_REASON[job.error_reason]}
          </Notice>
        ) : (
          <div data-testid="next-draft-progress" className="flex flex-col gap-2.5 py-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-text2">
              <Icon name="clock" size={16} />
              {job?.status === "running" ? "Writing every affected section" : "Waiting for a Claude account"}
            </div>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-surface2"
              role="progressbar"
              aria-label="Building the next draft"
            >
              <div className={`h-full rounded-full bg-accent ${job?.status === "running" ? "w-2/3" : "w-1/4"} animate-pulse`} />
            </div>
          </div>
        )}
        {(error || pq.error) && <Notice tone="error">{error ?? pq.error}</Notice>}
      </Sheet>
    );
  }

  return (
    <PreviewStep
      preview={preview}
      chips={chips}
      busy={busy}
      error={error}
      onApply={apply}
      onDiscard={discard}
      onClose={onClose}
    />
  );
}

function why(item: StagedItem, latest: number | null | undefined): string | null {
  if (item.section_gone) return `Section gone in v${latest}`;
  if (item.section_locked) return "Section approved · locked";
  return null;
}

const EXCERPT = 140;
const excerpt = (text: string) => (text.length <= EXCERPT ? text : `${text.slice(0, EXCERPT)}…`);
const money = (usd: number) => `$${usd.toFixed(2)}`;

/** "a, b and c" */
function joined(parts: string[]): string {
  return parts.length < 2 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** D12: which engine builds the ticked items, and why, in one line. */
function engineLine(plan: Plan, next: number): string {
  if (plan.engine === "oracle")
    return `Oracle rewrites ${plan.sections} section${plan.sections === 1 ? "" : "s"} itself and shows you a preview.`;
  return `Agents write draft ${next} because ${joined(plan.why.map((w) => w.text))}.`;
}

function Group({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <section aria-label={label} data-testid={testId}>
      <h3 className="text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2">{label}</h3>
      <ul className="flex flex-col">{children}</ul>
    </section>
  );
}

function Tick({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <input
      type="checkbox"
      className="mt-1 size-4 flex-none accent-[var(--accent)]"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

function PickStep({
  staged,
  busy,
  error,
  onBuild,
  onClose,
}: {
  staged: Staged;
  busy: boolean;
  error: string | null;
  onBuild: (choice: Choice) => void;
  onClose: () => void;
}) {
  // Every staged item is in (C1e: ticked by default), unless its section is locked; a change
  // whose section is gone is listed unticked (ticked, it goes to the agents).
  const all = useQuery(`staged-all|${staged.slug}`, () =>
    unwrap(
      api.GET("/v1/documents/{doc}/staged-changes", {
        params: { path: { doc: staged.slug }, query: { include_gone: true } },
      }),
    ),
  );
  const items = all.data?.items ?? staged.items;
  const agents: AgentItem[] = all.data?.agent_items ?? staged.agent_items;
  // G4: the discussions' section changes, ticked by default like the text changes.
  const discussed = all.data?.next_draft_changes ?? staged.next_draft_changes ?? [];
  // Ids the approver changed from their default (ticked, or unticked for a gone section).
  const [flipped, setFlipped] = useState<Set<string>>(new Set());
  const flip = (id: string) => {
    const nextSet = new Set(flipped);
    if (nextSet.has(id)) nextSet.delete(id);
    else nextSet.add(id);
    setFlipped(nextSet);
  };
  const ticked = (i: StagedItem) => !i.section_locked && i.section_gone === flipped.has(i.suggestion_id);
  const texts = items.filter(ticked);
  const agentsOn = agents.filter((a) => !flipped.has(a.feedback_id));
  const discussedOn = discussed.filter((d) => !d.section_locked && d.section_gone === flipped.has(d.id));
  const chosen = texts.length + agentsOn.length + discussedOn.length;
  const body = {
    suggestion_ids: texts.map((i) => i.suggestion_id),
    feedback_ids: agentsOn.map((a) => a.feedback_id),
    next_draft_change_ids: discussedOn.map((d) => d.id),
    depth: "standard" as const,
  };
  const live = useLive(
    body,
    (b) => unwrap(api.POST("/v1/documents/{doc}/next-draft/plan", { params: { path: { doc: staged.slug } }, body: b })),
    250,
    chosen > 0,
  );
  const plan = chosen > 0 && !live.pending ? live.data : undefined;
  const next = staged.next_version;

  return (
    <Sheet
      eyebrow="Next draft"
      title={`Build draft ${next}`}
      chips={
        <>
          <HeroChip>
            <VersionStep from={staged.latest_version} to={next} />
          </HeroChip>
          <HeroChip tone="accent">
            <span data-testid="pick-count">{chosen}</span> of {items.length + agents.length + discussed.length} staged
          </HeroChip>
          <InfoTip label="Build draft" align="start" side="bottom" hero>
            Oracle rewrites the sections text changes touch, together, and you review one preview; anything that needs more than a
            section&apos;s text goes to the agents, who write the whole draft.
          </InfoTip>
        </>
      }
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto flex min-w-0 flex-col gap-0.5 text-sm" aria-live="polite">
            <span className="font-semibold text-text" data-testid="engine-line">
              {plan ? engineLine(plan, next) : chosen ? "…" : "Tick at least one item."}
            </span>
            {plan?.engine === "agents" && plan.estimate_usd != null && (
              <span className="tnum text-text2" data-testid="run-estimate">
                {plan.needs_owner_approval ? `Ask an owner to approve (${money(plan.estimate_usd)})` : `Estimate ${money(plan.estimate_usd)}`}
              </span>
            )}
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={busy || !plan || !!plan.refused}
            onClick={() =>
              plan &&
              onBuild({
                engine: plan.engine,
                suggestion_ids: body.suggestion_ids,
                feedback_ids: body.feedback_ids,
                next_draft_change_ids: body.next_draft_change_ids,
              })
            }
          >
            Build draft {next}
          </Button>
        </>
      }
    >
      {staged.worth_a_draft && (
        <Notice tone="info" testId="worth-a-draft">
          {staged.worth_a_draft}
        </Notice>
      )}
      {items.length > 0 && (
        <Group label="Text changes" testId="staged-list">
          {items.map((i) => {
            const reason = why(i, staged.latest_version);
            return (
              <li key={i.suggestion_id} className="border-b border-line py-2.5 last:border-b-0" data-testid="staged-item">
                <label className={`flex items-start gap-3 ${i.section_locked ? "cursor-not-allowed" : "cursor-pointer"}`}>
                  <Tick
                    label={`Include ${i.section_heading}: ${i.feedback_summary}`}
                    checked={ticked(i)}
                    disabled={i.section_locked}
                    onChange={() => flip(i.suggestion_id)}
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className={`font-semibold ${reason ? "text-text2" : "text-text"}`}>Section {i.section_heading}</span>
                      <Chip kind="line">v{i.raised_on_version}</Chip>
                      {reason && (
                        <Chip kind={i.section_locked ? "warn" : "na"}>
                          {i.section_locked && <Icon name="lock" size={16} />}
                          {reason}
                        </Chip>
                      )}
                    </span>
                    <span className={`text-[15px] leading-[22px] ${reason ? "text-text2" : "text-text"}`}>{i.feedback_summary}</span>
                    {i.text && (
                      <span className="text-sm leading-5 text-text2" data-testid="staged-text">
                        {excerpt(i.text)}
                      </span>
                    )}
                    <span className="tnum text-[13px] text-text2">
                      {i.accepted_by_name ?? "Accepted"}
                      {i.accepted_at && ` · ${formatDateTime(i.accepted_at)}`}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </Group>
      )}
      {discussed.length > 0 && (
        <Group label="From discussions" testId="discussion-list">
          {discussed.map((d) => (
            <li key={d.id} className="border-b border-line py-2.5 last:border-b-0" data-testid="discussion-item">
              <label className={`flex items-start gap-3 ${d.section_locked ? "cursor-not-allowed" : "cursor-pointer"}`}>
                <Tick
                  label={`Include ${d.section_heading}: ${d.instruction}`}
                  checked={!d.section_locked && d.section_gone === flipped.has(d.id)}
                  disabled={d.section_locked}
                  onChange={() => flip(d.id)}
                />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-text">Section {d.section_heading}</span>
                    {d.section_locked && (
                      <Chip kind="warn">
                        <Icon name="lock" size={16} />
                        Approved and locked
                      </Chip>
                    )}
                  </span>
                  <span className="text-[15px] leading-[22px] text-text">{d.instruction}</span>
                  {d.reason && <span className="text-sm leading-5 text-text2">{d.reason}</span>}
                  <span className="flex items-center gap-1 text-[13px] text-text2" data-testid="discussion-origin">
                    <Icon name="comment" size={16} />
                    {d.origin_line}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </Group>
      )}
      {agents.length > 0 && (
        <Group label="Needs the agents" testId="agent-list">
          {agents.map((a) => {
            const where = a.section_key ? `Section ${a.section_key}` : "General";
            return (
              <li key={a.feedback_id} className="border-b border-line py-2.5 last:border-b-0" data-testid="agent-item">
                <label className="flex cursor-pointer items-start gap-3">
                  <Tick label={`Include ${where}: ${a.summary}`} checked={!flipped.has(a.feedback_id)} onChange={() => flip(a.feedback_id)} />
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <Chip kind="line">{where}</Chip>
                    </span>
                    <span className="text-[15px] leading-[22px] text-text">{a.summary}</span>
                    <span className="tnum text-[13px] text-text2">
                      {a.staged_by_name ?? "Staged"}
                      {a.staged_at && ` · ${formatDateTime(a.staged_at)}`}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </Group>
      )}
      {plan?.refused && (
        <Notice tone="error" testId="next-draft-refused">
          {plan.refused}
        </Notice>
      )}
      {live.error && <Notice tone="error">{live.error}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
    </Sheet>
  );
}

function Words({ words }: { words: Schemas["WordOp"][] }) {
  return (
    <p className="rounded-lg border border-line bg-surface2 px-3 py-2 text-[15px] leading-6 whitespace-pre-wrap text-text">
      {words.map((w, i) =>
        w.op === "insert" ? (
          <ins key={i} className="diff-ins">
            {w.text}
          </ins>
        ) : w.op === "delete" ? (
          <del key={i} className="diff-del">
            {w.text}
          </del>
        ) : (
          <span key={i}>{w.text}</span>
        ),
      )}
    </p>
  );
}

function PreviewSectionCard({ s, keep, onKeep }: { s: PreviewSection; keep: boolean; onKeep: (keep: boolean) => void }) {
  return (
    <section
      aria-label={s.heading}
      data-testid="next-draft-section"
      data-section={s.section_key}
      data-keep={keep ? "true" : "false"}
      className={`rounded-panel border px-3.5 py-3 ${keep ? "border-line" : "border-dashed border-line bg-surface2"}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className={`min-w-0 font-semibold ${keep ? "text-text" : "text-text2 line-through"}`}>{s.heading}</h3>
        <span className="font-mono text-[13px] text-text2">#{s.section_key}</span>
        <label className="ml-auto inline-flex cursor-pointer items-center gap-2 text-sm font-semibold text-text">
          <input
            type="checkbox"
            role="switch"
            className="size-4 accent-[var(--accent)]"
            checked={keep}
            onChange={(e) => onKeep(e.target.checked)}
            aria-label={`Keep ${s.heading}`}
          />
          Keep
        </label>
      </div>
      {keep ? (
        <div className="mt-2 flex flex-col gap-2">
          <Words words={s.words} />
          <div className="flex flex-wrap items-center gap-1.5">
            {s.feedback.map((f) => (
              <Chip key={f.id} kind="pass">
                <Icon name="check" size={16} />
                <span className="max-w-[28ch] truncate" title={f.summary}>
                  {f.summary}
                </span>
              </Chip>
            ))}
            {s.notes && (
              <InfoTip label={`Oracle on ${s.heading}`} align="start">
                {s.notes}
              </InfoTip>
            )}
          </div>
        </div>
      ) : (
        <p className="mt-1 text-sm font-medium text-text2">Stays staged</p>
      )}
    </section>
  );
}

function PreviewStep({
  preview,
  chips,
  busy,
  error,
  onApply,
  onDiscard,
  onClose,
}: {
  preview: Preview;
  chips: ReactNode;
  busy: boolean;
  error: string | null;
  onApply: (drop: string[]) => void;
  onDiscard: () => void;
  onClose: () => void;
}) {
  const [dropped, setDropped] = useState<Set<string>>(new Set());
  const kept = preview.sections.filter((s) => !dropped.has(s.section_key));
  return (
    <Sheet
      eyebrow="Next draft · preview"
      title={`Draft ${preview.next_version}`}
      chips={
        <>
          {chips}
          <HeroChip tone="accent">
            <span data-testid="kept-count">{kept.length}</span> of {preview.sections.length} sections
          </HeroChip>
          {preview.notes && (
            <InfoTip label="Oracle's notes" align="start" side="bottom" hero>
              {preview.notes}
            </InfoTip>
          )}
        </>
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onDiscard}>
            Discard
          </Button>
          <Button
            variant="primary"
            icon="check"
            disabled={busy || kept.length === 0 || preview.stale}
            onClick={() => onApply([...dropped])}
          >
            Apply as draft {preview.next_version}
          </Button>
        </>
      }
    >
      {preview.stale && <Notice tone="error">v{preview.latest_version} exists now · build again</Notice>}
      <div className="flex flex-col gap-3" data-testid="next-draft-preview">
        {preview.sections.map((s) => (
          <PreviewSectionCard
            key={s.section_key}
            s={s}
            keep={!dropped.has(s.section_key)}
            onKeep={(keep) => {
              const next = new Set(dropped);
              if (keep) next.delete(s.section_key);
              else next.add(s.section_key);
              setDropped(next);
            }}
          />
        ))}
      </div>
      {preview.skipped.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label="Not in this draft">
          {preview.skipped.map((s, i) => (
            <li key={i} className="flex items-center gap-2 text-sm text-text2">
              <Chip kind="na">Stays staged</Chip>
              <span className="font-mono text-[13px]">#{s.section_key}</span>
              <span>{s.reason}</span>
            </li>
          ))}
        </ul>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </Sheet>
  );
}
