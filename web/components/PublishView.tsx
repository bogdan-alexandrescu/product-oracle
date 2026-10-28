"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { DocCrumb } from "@/components/DocToolbar";
import {
  Button,
  Chip,
  Icon,
  InfoTip,
  Inspector,
  InspectorSection,
  LinkButton,
  Notice,
  Page,
  PageHeader,
  Panel,
  Split,
  useFocusTrap,
  type ChipKind,
} from "@/components/ds";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { addDays, todayIn, useCompanyZone, zoneInstant } from "@/lib/dates";
import { useMe } from "@/lib/me";
import { OWNER_APPROVES } from "@/lib/owner-kinds";
import { useRiskPolicy } from "@/lib/risk-policy";
import { useScreenSubject } from "@/lib/screen-subject";
import { errorMessage, useAuthRedirect, useQuery } from "@/lib/use-query";
import { sectionHref } from "@/lib/section-link";
import { formatDate, plural } from "@/lib/format";

type Readiness = Schemas["ReadinessDashboard"];
type Item = Schemas["ReadinessItem"];
type Strategy = Schemas["BlockerStrategy"];
type Question = Schemas["StakeholderQuestionOut"];
type DateMark = Schemas["DateMarkOut"];
/** Why the confirm dialog's Publish was refused: the API's 409, a newer version, or an error. */
type Refusal = { detail: string; blocking: Schemas["PublishBlock"][]; stale?: boolean };

/** The blockers lane's hard check (api/oracle/blockers/readiness.py). */
const BLOCKERS_CHECK = "critical_blockers";
const CHECK_KIND: Record<string, string> = {
  security_policy: "Security or policy",
  third_party_support: "Third-party",
};
const PHONE = "(max-width: 600px)";
/** The kinds whose approve checks the dates the text writes, not the PRD checks (api/oracle/review/publish_gate.py). */
const DATED_KINDS = new Set(["roadmap", "update"]);
const DAY = 86_400_000;

/** One reason the API refuses the publish: a gating blocker, or another critical hard check. */
type Block = {
  id: string;
  title: string;
  kind: string;
  /** Where it is resolved: the blocker's baseline item, the section, or the item. */
  href: string | null;
  blocker?: Strategy;
  check?: Item;
};

/**
 * The verdict's refusals, one row each. `critical_blockers` expands into the critical
 * blockers that gate this PRD (B4 reach: GET .../blocker-strategy); when those cannot be
 * read, the check itself is the row.
 */
function blocksOf(doc: string, n: number, readiness: Readiness, strategy: Schemas["DocumentBlockerStrategy"] | undefined): Block[] {
  const entity = (id: string | undefined) => (id ? `/baseline?entity=${id}` : null);
  const section = (key: string | undefined) => (key ? sectionHref(doc, n, key) : null);
  // The gating blockers first, then the other refusals in the verdict's order.
  const keys = [...readiness.blocking].sort((a, b) => Number(b === BLOCKERS_CHECK) - Number(a === BLOCKERS_CHECK));
  return keys.flatMap((key): Block[] => {
    const item = readiness.items.find((i) => i.key === key);
    if (key === BLOCKERS_CHECK) {
      const gating = strategy?.blockers.filter((s) => s.gate.status === "critical") ?? [];
      if (gating.length > 0) {
        return gating.map((s) => ({
          id: s.blocker.id,
          title: s.blocker.statement,
          kind: "Critical blocker",
          href: entity(s.blocker.id),
          blocker: s,
        }));
      }
      return [{ id: key, title: item?.title ?? "Critical blockers", kind: "Critical blocker", href: entity(item?.evidence_ids[0]), check: item }];
    }
    return [
      {
        id: key,
        title: item?.title ?? key,
        kind: CHECK_KIND[key] ?? "Hard check",
        href: section(item?.section_keys[0]) ?? entity(item?.evidence_ids[0]),
        check: item,
      },
    ];
  });
}

/**
 * qa-docs-2: a roadmap's (or an update's) approve refuses each date its text writes that no
 * confirmed schedule backs (the version's ``date_marks`` with a label), as the 409 lists them.
 */
export function dateBlocksOf(marks: DateMark[] | undefined, headings: Map<string, string>): Block[] {
  return (marks ?? [])
    .filter((m) => m.label)
    .map((m) => {
      const heading = m.where === "title" ? "the title" : headings.get(m.section_key);
      return {
        id: `${m.section_key}:${m.text}`,
        title: `${formatDate(m.date)}${heading ? ` in “${heading}”` : ""}: ${
          m.status === "withdrawn" ? "its schedule basis was withdrawn" : "not backed by a confirmed schedule"
        }`,
        kind: "Unconfirmed date",
        href: "/plan/dates",
      };
    });
}

const STATUS: Record<Item["status"], { kind: ChipKind; label: string }> = {
  pass: { kind: "pass", label: "Pass" },
  warning: { kind: "warn", label: "Warning" },
  critical: { kind: "crit", label: "Critical" },
  not_applicable: { kind: "na", label: "N/A" },
};

/** A hard check fails only when critical (T2); its count is what it found. */
function hardCount(item: Item): string | null {
  const found = item.evidence_ids.length;
  if (item.status === "pass" || item.status === "not_applicable" || found === 0) return null;
  return item.key === BLOCKERS_CHECK ? `${found} open` : `${found} item${found === 1 ? "" : "s"}`;
}

function subscribePhone(onChange: () => void) {
  const mq = window.matchMedia(PHONE);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/** True at phone width; false on the server. */
function useIsPhone(): boolean {
  return useSyncExternalStore(
    subscribePhone,
    () => window.matchMedia(PHONE).matches,
    () => false,
  );
}

function age(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return days < 1 ? "today" : `${days}d`;
}

/** What publishing does on main: POST .../approve stamps the version, the PRD and the audit log. */
function onPublishLines(n: number) {
  return [`Version v${n} approved with its evidence`, "PRD status set to Approved", "Approval recorded in the audit log"];
}

function OnPublish({ n }: { n: number }) {
  return (
    <ul className="flex flex-col" data-testid="on-publish">
      {onPublishLines(n).map((line) => (
        <li key={line} className="flex min-h-[30px] items-center gap-2">
          <Icon name="doc" size={16} className="flex-none text-accent-ink" />
          <span className="min-w-0 truncate">{line}</span>
        </li>
      ))}
    </ul>
  );
}

/** Accept a blocker's risk: the company's acceptance role (B4, owners by default); hidden from anyone else. */
function AcceptRisk({ blocker, onDone }: { blocker: Strategy; onDone: (message: string) => void }) {
  const { can } = useMe();
  const policy = useRiskPolicy();
  const onAuth = useAuthRedirect();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const zone = useCompanyZone();
  const today = todayIn(zone);
  // Thirty days out, inside the company's limit (a day short of it); null until edited.
  const [picked, setPicked] = useState<string | null>(null);
  const review = picked ?? addDays(today, Math.max(1, Math.min(30, policy.maxDays - 1)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // #370: POST accept-risk; for a blocker that gates publishing the handler asks for the
  // company's acceptance role too (its per-item role, owner): an approver passes when it is theirs.
  const canAccept = can("accept_blocker_risk", policy.role !== "owner");

  if (!canAccept) return null;

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      await unwrap(
        api.POST("/v1/blockers/{blocker_id}/accept-risk", {
          params: { path: { blocker_id: blocker.blocker.id } },
          // 09:00 on the chosen day in the Company time zone, kept inside the company's limit from now.
          body: {
            reason: reason.trim(),
            review_at: new Date(Math.min(Date.parse(zoneInstant(review, "09:00", zone)), Date.now() + policy.maxDays * DAY - 60_000)).toISOString(),
          },
        }),
      );
      setOpen(false);
      onDone("Risk accepted.");
    } catch (e) {
      if (!onAuth(e)) setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => setOpen(true)}>Accept risk</Button>
      </div>
    );
  }
  return (
    <form
      className="flex flex-col gap-2"
      aria-label="Accept risk"
      onSubmit={(e) => {
        e.preventDefault();
        void accept();
      }}
    >
      <label className="flex flex-col gap-1 text-[13px] font-semibold text-text2">
        Reason
        <input className={INPUT} value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={4000} />
      </label>
      <label className="flex flex-col gap-1 text-[13px] font-semibold text-text2">
        Review by
        <input
          className={INPUT}
          type="date"
          value={review}
          min={addDays(today, 1)}
          max={addDays(today, policy.maxDays)}
          onChange={(e) => setPicked(e.target.value)}
          aria-describedby="risk-review-limit"
          required
        />
        <span id="risk-review-limit" className="text-[13px] font-normal">
          Within {policy.maxDays} days
        </span>
      </label>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="solid" disabled={busy || !reason.trim()}>
          {busy ? "Accepting…" : "Accept risk"}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
    </form>
  );
}

function BlockInspector({
  block,
  question,
  n,
  onChanged,
}: {
  block: Block;
  question: Question | undefined;
  n: number;
  onChanged: (message: string) => void;
}) {
  const why = block.blocker?.gate.rationale ?? block.check?.rationale;
  return (
    <Inspector
      testId="publish-inspector"
      label="Selected block"
      eyebrow="Block · selected"
      title={block.title}
      chips={
        <>
          <Chip hero>{block.kind}</Chip>
          {(block.check || block.blocker) && <Chip hero>Hard check</Chip>}
        </>
      }
      action={
        why && (
          <InfoTip label="this block" hero side="bottom">
            {why}
          </InfoTip>
        )
      }
    >
      {question && (
        <InspectorSection label="Question" testId="block-question">
          <div className="flex min-h-8 items-center gap-2.5">
            <Icon name="ask" size={20} className="flex-none text-accent-ink" />
            <span className="min-w-0 flex-1">{question.prompt}</span>
            <span className="tnum flex-none text-text2">{age(question.created_at)}</span>
          </div>
        </InspectorSection>
      )}
      {block.blocker && (
        <InspectorSection label="Blocker strategy">
          <div className="flex flex-wrap items-center gap-2">
            <LinkButton href={`/baseline?tab=blockers&blocker=${encodeURIComponent(block.blocker.blocker.id)}`}>
              Open blocker
            </LinkButton>
            <span className="text-sm text-text2">Status, options, feasibility scope and experiments</span>
          </div>
        </InspectorSection>
      )}
      {block.blocker && (
        <InspectorSection label="Risk" testId="block-risk">
          <AcceptRisk key={block.id} blocker={block.blocker} onDone={onChanged} />
        </InspectorSection>
      )}
      <InspectorSection label="On publish">
        <OnPublish n={n} />
      </InspectorSection>
    </Inspector>
  );
}

function ReadyInspector({ n }: { n: number }) {
  return (
    <Inspector testId="publish-inspector" label="On publish" eyebrow="On publish">
      <InspectorSection>
        <OnPublish n={n} />
      </InspectorSection>
    </Inspector>
  );
}

function SubHead({ title, count, children }: { title: string; count: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-h-12 flex-wrap items-center gap-2.5 border-t border-line px-4 py-2 max-[600px]:px-3">
      <h2 className="font-display text-lg leading-6 font-bold tracking-heading">{title}</h2>
      <span className="tnum font-display text-lg leading-6 font-bold tracking-heading text-accent-ink">{count}</span>
      {children}
    </div>
  );
}

/** One block: icon, title, kind chip, Resolve. Click selects it. */
function BlockRow({ block, selected, onSelect }: { block: Block; selected: boolean; onSelect: () => void }) {
  return (
    <div
      data-testid="block-row"
      data-key={block.id}
      aria-current={selected || undefined}
      onClick={onSelect}
      className={`grid min-h-[44px] cursor-pointer grid-cols-[22px_minmax(0,1fr)_170px_96px] items-center gap-x-2 border-t border-line px-4 hover:bg-surface2 max-[600px]:grid-cols-[22px_minmax(0,1fr)_auto] max-[600px]:gap-y-1.5 max-[600px]:px-3 max-[600px]:py-2.5 ${
        selected ? "bg-accent-soft shadow-[inset_4px_0_0_var(--accent)] hover:bg-accent-soft" : ""
      }`}
    >
      <Icon name="alert" size={16} className="text-crit" />
      <button
        type="button"
        aria-pressed={selected}
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
        title={block.title}
        className="min-w-0 truncate text-left font-medium max-[600px]:col-span-2 max-[600px]:whitespace-normal"
      >
        {block.title}
      </button>
      <span className="min-w-0 max-[600px]:col-start-2">
        <Chip kind="crit">{block.kind}</Chip>
      </span>
      <span className="text-right max-[600px]:col-start-3 max-[600px]:row-start-2">
        {block.href && (
          <LinkButton href={block.href} variant={selected ? "solid" : "secondary"} onClick={(e) => e.stopPropagation()}>
            Resolve
          </LinkButton>
        )}
      </span>
    </div>
  );
}

function HardRow({ item }: { item: Item }) {
  const fail = item.status === "critical";
  const chip = fail ? { kind: "crit" as const, label: "Fail" } : STATUS[item.status];
  const count = hardCount(item);
  return (
    <li
      data-testid="hard-check"
      data-key={item.key}
      data-status={item.status}
      title={item.rationale}
      className="grid min-h-[44px] grid-cols-[22px_minmax(0,1fr)_170px_96px] items-center gap-x-2 border-t border-line px-4 max-[600px]:grid-cols-[22px_minmax(0,1fr)_auto_auto] max-[600px]:px-3"
    >
      {item.status === "not_applicable" ? (
        <span aria-hidden="true" data-testid="hard-na" className="text-center text-text2">
          –
        </span>
      ) : (
        <Icon name={fail ? "x" : "check"} size={16} className={fail ? "text-crit" : item.status === "pass" ? "text-pass" : "text-text2"} />
      )}
      <span className="min-w-0 py-2 font-medium break-words">{item.title}</span>
      <span>
        <Chip kind={chip.kind}>{chip.label}</Chip>
      </span>
      <span className="tnum text-right" data-testid="hard-count">
        {count}
      </span>
    </li>
  );
}

function AdvisoryRow({ item, index }: { item: Item; index: number }) {
  const s = STATUS[item.status];
  return (
    <li
      data-testid="advisory"
      data-key={item.key}
      data-status={item.status}
      title={item.rationale}
      className="grid min-h-[44px] grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-x-2 border-t border-line px-4 max-[600px]:px-3"
    >
      <b className="tnum font-semibold text-text2">{index}</b>
      <span className="min-w-0 py-2 break-words">{item.title}</span>
      <Chip kind={s.kind}>
        {item.status === "pass" && <Icon name="check" size={16} />}
        {s.label}
      </Chip>
    </li>
  );
}

/** Publish (B1): blocks, hard checks and advisory on the left, the selected block right. */
export function PublishView({ doc }: { doc: string }) {
  const { can } = useMe();
  const onAuth = useAuthRedirect();
  const phone = useIsPhone();
  const docQ = useQuery(`doc|${doc}`, () => unwrap(api.GET("/v1/documents/{doc}", { params: { path: { doc } } })));
  const d = docQ.data;
  const n = d?.latest_version ?? null;
  // G7 3.3: the panel is about this document (its latest version).
  useScreenSubject(d && n != null ? { kind: "document", subject: { document_id: d.id, version: n } } : null, d?.title);
  const readinessQ = useQuery(`readiness|${doc}|${n}`, () =>
    n == null
      ? Promise.resolve(undefined)
      : unwrap(api.GET("/v1/documents/{doc}/versions/{n}/readiness", { params: { path: { doc, n }, query: { purpose: "publish" } } })),
  );
  // #254: the confirm names how many sections are not reviewed.
  const versionQ = useQuery(`version|${doc}|${n}`, () =>
    n == null ? Promise.resolve(undefined) : unwrap(api.GET("/v1/documents/{doc}/versions/{n}", { params: { path: { doc, n } } })).catch(() => undefined),
  );
  const sections = versionQ.data?.sections ?? [];
  const unreviewed = sections.filter((s) => !s.verdict).length;
  // Optional reads: without them the blocks fall back to the verdict's own rows.
  const strategyQ = useQuery(`blocker-strategy|${doc}`, () =>
    unwrap(api.GET("/v1/documents/{doc}/blocker-strategy", { params: { path: { doc } } })).catch(() => undefined),
  );
  const questionsQ = useQuery(`questions|${d?.id}`, async () => {
    if (!d) return undefined;
    const query = { document_id: d.id };
    const [gaps, questions] = await Promise.all([
      unwrap(api.GET("/v1/gaps", { params: { query } })),
      unwrap(api.GET("/v1/questions", { params: { query } })),
    ]).catch(() => [[], []] as const);
    return { gaps, questions };
  });

  const [picked, setPicked] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const readiness = readinessQ.data;
  // qa-docs-2: a roadmap's approve refuses its unconfirmed dates (not the PRD checks), so the
  // page lists those, from the version the approve checks.
  const dated = d != null && DATED_KINDS.has(d.kind);
  const headings = new Map(sections.map((s) => [s.section_key, s.heading]));
  const blocks =
    readiness && n != null
      ? dated
        ? versionQ.data
          ? dateBlocksOf(versionQ.data.date_marks, headings)
          : []
        : blocksOf(doc, n, readiness, strategyQ.data)
      : [];
  const selected = blocks.find((b) => b.id === picked) ?? blocks[0] ?? null;
  const published = n != null && d?.approved_version === n;
  // #370: Publish is POST .../approve; anyone who may not call it never sees the button. A
  // vision, strategy or update is an owner's (its per-item role); any other kind an approver's.
  const canPublish = can("approve_version", d != null && !OWNER_APPROVES[d.kind]);
  const hard = readiness?.items.filter((i) => i.hard) ?? [];
  const advisory = readiness?.items.filter((i) => !i.hard) ?? [];
  const failing = hard.filter((i) => i.status === "critical").length;
  const tally = (s: Item["status"]) => advisory.filter((i) => i.status === s).length;
  const half = Math.ceil(advisory.length / 2);

  const questionFor = (block: Block): Question | undefined => {
    const data = questionsQ.data;
    if (!data || !block.blocker) return undefined;
    const gapIds = new Set(data.gaps.filter((g) => g.entity_ids.includes(block.blocker!.blocker.id)).map((g) => g.id));
    return data.questions.find((q) => q.gap_id != null && gapIds.has(q.gap_id) && !["answered", "withdrawn"].includes(q.status));
  };

  const reloadReadiness = readinessQ.reload;
  const reloadStrategy = strategyQ.reload;
  const changed = (message: string) => {
    setNotice(message);
    void reloadReadiness();
    void reloadStrategy();
  };

  const closeConfirm = () => {
    setConfirming(false);
    setRefusal(null);
  };
  useFocusTrap(dialogRef, confirming, closeConfirm);
  // A refusal disables Publish; keep focus inside the dialog, on the way out.
  useEffect(() => {
    if (refusal) dialogRef.current?.querySelector<HTMLElement>("[data-dialog-cancel]")?.focus();
  }, [refusal]);

  async function publish() {
    if (n == null) return;
    setBusy(true);
    setRefusal(null);
    try {
      // C5: only the latest version is published; one that landed since this page loaded wins.
      const fresh = await unwrap(api.GET("/v1/documents/{doc}", { params: { path: { doc } } }));
      if (fresh.latest_version !== n) {
        setRefusal({ detail: `v${fresh.latest_version} exists, reload`, blocking: [], stale: true });
        return;
      }
      // The API runs the publish checks itself and answers 409 naming the blocks.
      const res = await api.POST("/v1/documents/{doc}/versions/{n}/approve", { params: { path: { doc, n } } });
      if (res.response.status === 409 && res.error && "blocking" in res.error) {
        setRefusal(res.error);
        void reloadReadiness();
        void reloadStrategy();
        return;
      }
      await unwrap(Promise.resolve(res));
      closeConfirm();
      setNotice(`Published v${n}.`);
      void docQ.reload();
    } catch (e) {
      if (!onAuth(e)) setRefusal({ detail: errorMessage(e), blocking: [] });
    } finally {
      setBusy(false);
    }
  }

  function reloadPage() {
    closeConfirm();
    setNotice(null);
    void docQ.reload();
  }

  // Enabled only when the API's verdict refuses nothing; never a count made here.
  const checking = !readiness || (dated && !versionQ.data);
  const reason = checking
    ? "Checking"
    : (dated ? blocks.length > 0 : readiness.blocked)
      ? plural(blocks.length, "block")
      : null;
  // qa-docs-3: publishable, but say what is still open (the confirm dialog says the same).
  const critical = tally("critical");
  const caveats = [
    unreviewed > 0 ? `${plural(unreviewed, "section")} ${unreviewed === 1 ? "is" : "are"} not reviewed` : null,
    critical > 0 ? `${plural(critical, "advisory check")} ${critical === 1 ? "is" : "are"} critical` : null,
  ].filter((x): x is string => !!x);
  // qa-docs-23: who may publish, from can(): a vision, strategy or update is an owner's.
  const whoPublishes = d && OWNER_APPROVES[d.kind] ? "Only an owner can publish" : "Only an approver or owner can publish";
  const headline = published
    ? `Published v${n}`
    : !canPublish
      ? `${whoPublishes} v${n}`
      : caveats.length > 0
        ? `Publishable, but ${caveats.join(" and ")}`
        : `Ready to publish v${n}`;
  const action =
    n == null ? null : published ? (
      <Chip kind="pass" className="h-10 px-4 text-[15px]" data-testid="published-chip">
        <Icon name="check" size={16} />
        Published v{n}
      </Chip>
    ) : !canPublish ? null : (
      <>
        <Button
          variant="primary"
          icon={reason ? "lock" : "check"}
          disabled={!!reason}
          aria-describedby={reason ? "publish-reason" : undefined}
          title={reason ?? undefined}
          data-testid="publish-button"
          onClick={() => setConfirming(true)}
        >
          Publish v{n}
        </Button>
        {reason && (
          <span id="publish-reason" className="sr-only">
            {reason}
          </span>
        )}
      </>
    );

  const blocksChip = !checking && (
    <span id="publish-blocks" className="inline-flex">
      <Chip kind={blocks.length ? "crit" : "pass"} data-testid="blocks-chip">
        {blocks.length} block{blocks.length === 1 ? "" : "s"}
      </Chip>
    </span>
  );

  const inspector =
    n == null || !readiness ? undefined : selected ? (
      <BlockInspector key={selected.id} block={selected} question={questionFor(selected)} n={n} onChanged={changed} />
    ) : (
      <ReadyInspector n={n} />
    );

  return (
    <Page>
      <PageHeader
        testId="publish-header"
        back={<DocCrumb doc={d} withTitle={false} />}
        title="Publish"
        suffix={d ? `${d.title}${n != null ? ` v${n}` : ""}` : undefined}
        status={blocksChip}
        action={action}
      />
      {docQ.error && <ErrorNote>{docQ.error}</ErrorNote>}
      {readinessQ.error && <ErrorNote>{readinessQ.error}</ErrorNote>}
      {notice && <Notice tone="pass">{notice}</Notice>}
      {d && n == null && <Notice>No version yet</Notice>}

      {readiness && n != null && (
        <Split inspector={phone && selected ? undefined : inspector}>
          <Panel testId="publish-readiness" className="overflow-hidden">
            {!canPublish && !published && blocks.length > 0 && (
              <p data-testid="publish-role" className="flex min-h-12 items-center gap-2.5 border-b border-line px-4 font-medium text-text2 max-[600px]:px-3">
                <Icon name="lock" size={16} className="flex-none" />
                {whoPublishes} v{n}
              </p>
            )}
            {blocks.length > 0 ? (
              <section aria-label="Blocks">
                <div className="flex min-h-12 items-center gap-2.5 px-4 py-2 max-[600px]:px-3">
                  <h2 className="font-display text-lg leading-6 font-bold tracking-heading">Blocks</h2>
                  <span className="tnum font-display text-lg leading-6 font-bold tracking-heading text-accent-ink">{blocks.length}</span>
                </div>
                {blocks.map((b) => (
                  <div key={b.id}>
                    <BlockRow block={b} selected={b.id === selected?.id} onSelect={() => setPicked(b.id)} />
                    {phone && b.id === selected?.id && inspector && <div className="border-t border-line p-2">{inspector}</div>}
                  </div>
                ))}
              </section>
            ) : (
              <p
                data-testid="publish-ready"
                className="flex min-h-12 items-center gap-2.5 px-4 py-2 font-display text-lg font-bold tracking-heading max-[600px]:px-3"
              >
                <Icon
                  name={!published && !canPublish ? "lock" : !published && caveats.length > 0 ? "alert" : "check"}
                  size={20}
                  className={`flex-none ${!published && !canPublish ? "text-text2" : !published && caveats.length > 0 ? "text-warn" : "text-pass"}`}
                />
                <span className="min-w-0">{headline}</span>
              </p>
            )}

            <section aria-label="Hard checks">
              <SubHead title="Hard checks" count={hard.length}>
                {failing > 0 && <Chip kind="crit">{failing} fail</Chip>}
              </SubHead>
              <ul>
                {hard.map((i) => (
                  <HardRow key={i.key} item={i} />
                ))}
              </ul>
            </section>

            <section aria-label="Advisory">
              <SubHead title="Advisory" count={advisory.length}>
                {tally("pass") > 0 && <Chip kind="pass">{tally("pass")} pass</Chip>}
                {tally("warning") > 0 && <Chip kind="warn">{tally("warning")} warning</Chip>}
                {tally("critical") > 0 && <Chip kind="crit">{tally("critical")} critical</Chip>}
                {tally("not_applicable") > 0 && <Chip kind="na">{tally("not_applicable")} n/a</Chip>}
                <Link href={`/documents/${doc}/v/${n}/quality`} className="text-sm font-medium text-accent-ink hover:underline">
                  Open quality
                </Link>
              </SubHead>
              <div className="grid grid-cols-2 max-[700px]:grid-cols-1" data-testid="advisory-columns">
                {[advisory.slice(0, half), advisory.slice(half)].map((col, c) => (
                  <ul key={c} className={c === 0 ? "border-r border-line max-[700px]:border-r-0" : ""}>
                    {col.map((i, k) => (
                      <AdvisoryRow key={i.key} item={i} index={c * half + k + 1} />
                    ))}
                  </ul>
                ))}
              </div>
            </section>
          </Panel>
        </Split>
      )}

      {confirming && n != null && (
        <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-hero/50 px-4 py-10 max-[600px]:px-2 max-[600px]:py-4">
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="publish-confirm-title"
            tabIndex={-1}
            className="w-full max-w-md min-w-0 rounded-inspector border border-line bg-surface text-text shadow-tip"
          >
            <div className="flex min-h-14 items-center border-b border-line px-5 max-[600px]:px-4">
              <h2 id="publish-confirm-title" className="font-display text-lg font-bold tracking-heading">
                Publish v{n}?
              </h2>
            </div>
            <div className="px-5 py-3.5 max-[600px]:px-4">
              {unreviewed > 0 && (
                <p data-testid="unreviewed-sections" className="mb-2 font-semibold text-warn">
                  {unreviewed} of {sections.length} sections {unreviewed === 1 ? "is" : "are"} not reviewed
                </p>
              )}
              <OnPublish n={n} />
            </div>
            {refusal && (
              <div id="publish-refusal" role="alert" data-testid="publish-refusal" className="border-t border-line bg-crit-bg px-5 py-3 text-crit max-[600px]:px-4">
                <p className="flex items-start gap-2 font-semibold">
                  <Icon name="alert" size={16} className="mt-0.5 flex-none" />
                  <span className="min-w-0">{refusal.blocking.length > 0 ? "Not published" : refusal.detail}</span>
                </p>
                {refusal.blocking.length > 0 && (
                  <>
                    <p className="mt-1 pl-6">
                      {refusal.blocking.length} block{refusal.blocking.length === 1 ? "" : "s"}
                    </p>
                    <ul className="mt-1 flex flex-col gap-1 pl-6">
                      {refusal.blocking.map((b) => (
                        <li key={b.id} data-testid="refusal-block" className="list-disc">
                          {b.title}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
            <div className="flex justify-end gap-2 border-t border-line px-5 py-3 max-[600px]:px-4">
              <Button variant="ghost" data-dialog-cancel onClick={closeConfirm}>
                Cancel
              </Button>
              {refusal?.stale ? (
                <Button variant="primary" onClick={reloadPage}>
                  Reload
                </Button>
              ) : (
                <Button
                  variant="primary"
                  icon={refusal ? "lock" : "check"}
                  disabled={busy || !!refusal}
                  aria-describedby={refusal ? "publish-refusal" : undefined}
                  onClick={publish}
                  data-autofocus
                >
                  {busy ? "Publishing…" : "Publish"}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}
