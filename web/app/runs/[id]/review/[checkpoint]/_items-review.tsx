"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Button, Chip, FilterChips, LinkButton, InspectorSection, Page, PageHeader, SegmentedControl, Sheet, Split, type Column } from "@/components/ds";
import { DecisionBar, type StagedChip } from "@/components/review/DecisionBar";
import { ItemInspector } from "@/components/review/ItemInspector";
import { ItemsTable } from "@/components/review/ItemsTable";
import { RawFileSheet } from "@/components/review/RawFileSheet";
import type { Horizon, ItemRow as TableRow } from "@/components/roadmap/item-row";
import { ErrorNote, INPUT, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";
import { invalidateWaiting, waitingChanged } from "@/lib/waiting";

import {
  AGENT_KINDS,
  day,
  describe,
  doneText,
  EDIT_KINDS,
  horizonLabel,
  HORIZONS,
  openReasons,
  plural,
  resolutionText,
  mayWaive,
  rowFixes,
  show,
  type Action,
  type Fix,
  type Item,
  type Mode,
  type Reason,
  type Review,
} from "./_items-lib";
import { draftKey, loadDraft } from "./_draft";
import type { ReviewViewProps } from "./_shell";

type Filter = "needs" | "all" | "changed";
type Group = "horizon" | "reason";
type ActionBody = Schemas["ActionIn"];
/** What a row or the inspector does to the shared draft (D8). */
export type Ops = {
  act: (body: Omit<ActionBody, "answers"> & { answers?: string[] }) => Promise<void>;
  remove: (id: string) => Promise<void>;
  stage: (id: string) => Promise<void>;
};
/** An inline form a row's ⋯ menu or the inspector opens. */
export type Form = { key: string; kind: "waive" | "split" | "ask"; code?: string; where: "row" | "inspector" } | null;

const POLL_MS = 10_000;
const OUTCOME_MAX = 500;
/** Ghost rows (removed items, D6) sort after every item of their group. */
const GHOST_POSITION = 1_000_000;
const HORIZON_INDEX = new Map<string, number>(HORIZONS.map((h, i) => [h, i]));

/** Whether a staged (or my own suggested) edit removes the item's milestone date. */
const dateRemoved = (it: Item) => it.actions.some((a) => a.kind === "edit" && a.field === "milestone_date" && a.value == null);

/** "0.7" or "70" as E2's 0-1 confidence; a word stays a word. */
function confidenceOf(c: string | null | undefined): TableRow["confidence"] {
  if (!c) return null;
  if (!/^[\d.]+$/.test(c)) return c;
  const n = Number(c);
  return n <= 1 ? n : n / 100;
}

/** A file item as E2's table row: the review's states in its row fields (muted, struck, date removed). */
function toRow(it: Item, prd: { slug: string; version: number } | null): TableRow {
  const staged = it.actions.filter((a) => a.state === "staged" && a.kind !== "question");
  const m = it.milestone;
  return {
    key: it.key,
    position: it.position != null ? it.position - 1 : GHOST_POSITION,
    title: it.title ?? it.key,
    outcome: it.outcome ?? null,
    horizon: (it.horizon ?? "") as Horizon,
    milestone: m ? { name: m.name ?? null, date: m.date ? day(m.date) : null, refused_date: null, refused: null, verified: false, date_removed: dateRemoved(it) } : null,
    confidence: confidenceOf(it.confidence),
    depends_on: it.depends_on,
    prd: it.prd_section ? { label: it.prd_section, href: prd ? `/documents/${prd.slug}/v/${prd.version}#${it.prd_section}` : "#" } : null,
    ghost: it.position == null,
    muted: it.state === "handled",
    struck: staged.some((a) => a.kind === "drop"),
  };
}

function usePhone(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 600px)");
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}

/** "Waiting for you · 19 h left" from D8's wait (amber under an hour, red under ten minutes). */
function waitChip(review: Review, mode: Mode) {
  const who = mode === "approver" ? "Waiting for you" : "Waiting for an approver";
  const w = review.wait;
  if (w.state === "ended") return <Chip kind="warn">Wait ended · deciding continues the run as a new workflow</Chip>;
  if (w.state !== "open" || w.seconds_left == null)
    return (
      <Chip kind="warn" dot>
        {who}
      </Chip>
    );
  const s = w.seconds_left;
  const left = s >= 3600 ? `${Math.floor(s / 3600)} h left` : `${Math.max(1, Math.floor(s / 60))} min left`;
  return (
    <Chip kind={s < 600 ? "crit" : s < 3600 ? "warn" : "na"} dot>
      {who} · {left}
    </Chip>
  );
}

/** The decided state: "Approved with 3 edits", "Sent back · 4 entries", "Approved". */
function decidedText(cp: Schemas["CheckpointOut"]): string {
  const review = (cp.review ?? {}) as { kind?: string; edits?: number; items?: unknown[] };
  if (cp.status === "approved") return review.kind === "edits" && review.edits ? `Approved with ${plural(review.edits, "edit")}` : "Approved";
  if (cp.status === "changes_requested") return Array.isArray(review.items) ? `Sent back · ${plural(review.items.length, "entry").replace("entrys", "entries")}` : "Sent back";
  return "Skipped";
}

/**
 * D1 Roadmap items review: roadmap_items.yaml as one row per item that needs a person, its
 * reasons (D2) and one-click fixes staged on the shared draft (D8); the inspector edits one
 * item; C7's DecisionBar sends back (D4) or approves with edits (D7) behind the gate (D3).
 * Approvers stage, commenters suggest, viewers read.
 */
export function ItemsReview({ run, cp, item, reloadRun }: ReviewViewProps) {
  const { can, me } = useMe();
  const phone = usePhone();
  const path = { params: { path: { run_id: run.id, checkpoint_id: cp.id } } };
  const reviewQ = useQuery(draftKey(run.id, cp.id), () => loadDraft(run.id, cp.id));
  const review = reviewQ.data ?? null;
  const reload = reviewQ.reload;
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("needs");
  const [group, setGroup] = useState<Group>("horizon");
  const [selected, setSelected] = useState<string | null>(item);
  const [sheet, setSheet] = useState(!!item);
  const [menu, setMenu] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(null);
  const [raw, setRaw] = useState<"file" | "agents" | null>(null);
  // Enter on a row asks to confirm its first fix here (criterion 16: no single-key decisions).
  const [confirm, setConfirm] = useState<string | null>(null);

  // D8: the draft is read again every 10 s while the page is visible (a teammate's suggestion).
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible" && cp.status === "pending") void reload();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [reload, cp.status]);

  const mode: Mode =
    cp.status !== "pending" || !review
      ? "viewer"
      : // #370 fixes 4: the review's can_stage/can_suggest are the API's item answer (the stop's
        // role); can() adds the route role, without a second check of the signed-in role here.
        review.can_stage && can("stage_checkpoint_action", review.can_stage)
        ? "approver"
        : review.can_suggest && can("create_checkpoint_action", review.can_suggest)
          ? "commenter"
          : "viewer";

  async function write(call: () => Promise<unknown>) {
    setError(null);
    try {
      await call();
    } catch (e) {
      setError(errorMessage(e));
    }
    await reload();
  }
  const ops: Ops = {
    act: (body) => write(() => unwrap(api.POST("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/actions", { ...path, body: { ...body, answers: body.answers ?? [] } }))),
    remove: (id) => write(() => unwrap(api.DELETE("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/actions/{action_id}", { params: { path: { run_id: run.id, checkpoint_id: cp.id, action_id: id } } }))),
    stage: (id) => write(() => unwrap(api.POST("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/actions/{action_id}/stage", { params: { path: { run_id: run.id, checkpoint_id: cp.id, action_id: id } } }))),
  };

  const items = useMemo(() => review?.items ?? [], [review]);
  const removed = review?.diff?.removed ?? [];
  const changed = (it: Item) => it.diff.length > 0 || removed.includes(it.key) || (!!it.resolution && it.resolution.outcome !== "done");
  const showChanged = (review?.attempt ?? 1) > 1 && !!review?.diff;
  const needing = items.filter((it) => it.reasons.length > 0);
  const rows = useMemo(() => {
    const list = filter === "needs" ? items.filter((it) => it.reasons.length > 0) : filter === "changed" ? items.filter(changed) : items;
    return [...list].sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, filter]);

  if (reviewQ.error) return <Page className="py-6"><ErrorNote>{reviewQ.error}</ErrorNote></Page>;
  if (!review) return <div className="px-6 py-8"><Loading /></div>;

  const titleOf = (key: string) => items.find((x) => x.key === key)?.title ?? key;
  const byKey = new Map(items.map((x) => [x.key, x]));
  const prdRef = run.source ? { slug: run.source.slug, version: run.source.version } : null;
  const tableRows = rows.map((it) => toRow(it, prdRef));
  // Group: by horizon (Now, Next, Later, then items not in the file), or by the first open reason.
  const reasonOf = (it: Item) => openReasons(it)[0]?.label ?? (it.reasons.length ? "Handled" : "Nothing open");
  const reasonOrder = [...new Set(rows.map(reasonOf))];
  const groupBy = group === "horizon" ? undefined : (r: TableRow) => reasonOf(byKey.get(r.key)!);
  const groupOrder = group === "horizon" ? (g: string) => HORIZON_INDEX.get(g) ?? 9 : (g: string) => reasonOrder.indexOf(g);
  const groupHead = (g: string, shown: TableRow[]) => {
    if (group !== "horizon") return <span data-testid="group-head">{`${g} · ${shown.length}`}</span>;
    const all = items.filter((x) => (x.horizon ?? "") === g);
    const need = all.filter((x) => x.reasons.length > 0).length;
    return <span data-testid="group-head">{`${horizonLabel(g || null)} · ${need} of ${all.length} need you`}</span>;
  };

  const tally = review.tally;
  const handled = needing.filter((x) => x.state === "handled").length;
  const staged = items.flatMap((it) => it.actions.filter((a) => a.state === "staged"));
  const questions = staged.filter((a) => a.kind === "question");
  const edits = staged.filter((a) => EDIT_KINDS.includes(a.kind)).length;
  const agentOnly = staged.find((a) => AGENT_KINDS.includes(a.kind));
  const waitingOn = tally.waiting_on.map((w) => `${w.count} waiting on ${w.name}`);
  const blockingLeft = review.gate ? review.gate.blocking_open + review.gate.file_problems : tally.blocking_open;
  const tallyNode = (
    <>
      {handled} of {needing.length} handled
      <span className="block text-sm font-normal text-text2" data-testid="tally-second">
        {[blockingLeft > 0 ? `${blockingLeft} blocking left` : null, ...waitingOn].filter(Boolean).join(" · ") || "Nothing blocking"}
      </span>
    </>
  );
  const chips: StagedChip[] = staged
    .filter((a) => a.kind !== "question")
    .map((a) => {
      const done = doneText(a, titleOf);
      return { key: a.id, label: `${titleOf(a.item_key)}: ${done.charAt(0).toLowerCase()}${done.slice(1)}`, onRemove: () => ops.remove(a.id) };
    });
  const unchanged = items.filter((it) => it.position != null && !staged.some((a) => a.item_key === it.key)).length;
  const entries = new Set(staged.map((a) => a.item_key)).size;
  const fileProblems = review.file_problems;
  // The row picked, else the first that needs me (the inspector is never empty), in the table's order.
  const shownRows = [...rows].sort((a, b) => {
    const [ra, rb] = [toRow(a, prdRef), toRow(b, prdRef)];
    const order = groupOrder(groupBy ? groupBy(ra) : ra.horizon) - groupOrder(groupBy ? groupBy(rb) : rb.horizon);
    return order || ra.position - rb.position;
  });
  const selectedItem = items.find((x) => x.key === selected) ?? shownRows.find((x) => x.state === "needs_you") ?? shownRows[0] ?? null;
  const source = run.source;
  const prd = source ? `${source.title} v${source.version}` : "the PRD";

  const pick = (it: Item) => {
    setSelected(it.key);
    if (phone) setSheet(true);
  };
  // Enter on a row: its first fix waits for a Confirm (focused); a row with none is picked.
  const activate = (key: string) => {
    const it = byKey.get(key)!;
    const first = mode !== "viewer" && it.state !== "handled" ? rowFixes(openReasons(it))[0] : undefined;
    if (first) {
      setSelected(key);
      setConfirm(key);
    } else pick(it);
  };
  const leaveConfirm = (key: string) => {
    setConfirm(null);
    [...document.querySelectorAll<HTMLElement>(`tr[data-testid="roadmap-item-row"][data-key="${CSS.escape(key)}"]`)].find((el) => el.checkVisibility())?.focus();
  };
  const columns: Column<TableRow>[] = [
    {
      key: "reasons",
      header: "Needs you because",
      wrap: true,
      phone: "meta",
      cell: (r) => <ReasonsCell it={byKey.get(r.key)!} showDiff={filter === "changed"} />,
    },
    {
      key: "call",
      header: "Your call",
      width: "236px",
      align: "right",
      wrap: true,
      phone: "meta",
      cell: (r) => {
        const it = byKey.get(r.key)!;
        return (
          // A row action is not a selection: the click stays in the cell.
          <div className="flex flex-col items-end gap-1 max-[600px]:items-start" onClick={(e) => e.stopPropagation()}>
            <span className="flex min-w-0 flex-wrap items-center justify-end gap-1 max-[600px]:justify-start" data-testid="your-call">
              {confirm === it.key && rowFixes(openReasons(it))[0] ? (
                <ConfirmFix {...rowFixes(openReasons(it))[0]} ops={ops} onDone={() => leaveConfirm(it.key)} />
              ) : (
              <YourCall it={it} open={openReasons(it)} staged={it.actions.filter((a) => a.state === "staged" && a.kind !== "question")} mode={mode} ops={ops} titleOf={titleOf} meId={me?.user_id ?? null} />
              )}
              {mode !== "viewer" && it.position != null && (
                <RowMenu it={it} open={openReasons(it)} mode={mode} ops={ops} menuOpen={menu === it.key} setMenu={(o) => setMenu(o ? it.key : null)} setForm={setForm} onSelect={() => pick(it)} />
              )}
            </span>
            <Suggestions it={it} mode={mode} ops={ops} titleOf={titleOf} meId={me?.user_id ?? null} />
          </div>
        );
      },
    },
  ];

  const inspector = selectedItem && (
    <ReviewInspector
      key={selectedItem.key}
      item={selectedItem}
      items={items}
      rows={items.map((x) => toRow(x, prdRef))}
      count={items.filter((x) => x.position != null).length}
      review={review}
      mode={mode}
      ops={ops}
      form={form?.key === selectedItem.key && form.where === "inspector" ? form : null}
      setForm={setForm}
      prd={prdRef}
      meId={me?.user_id ?? null}
    />
  );

  return (
    <Page>
      <PageHeader
        back={
          <span>
            <Link href="/runs" className="hover:underline">
              Runs
            </Link>{" "}
            /{" "}
            <Link href={`/runs/${run.id}`} className="hover:underline">
              {run.flow_title} from {prd}
            </Link>
          </span>
        }
        title="Roadmap items"
        status={
          <span data-testid="review-status">{cp.status === "pending" ? waitChip(review, mode) : <Chip kind={cp.status === "approved" ? "pass" : "na"}>{decidedText(cp)}</Chip>}</span>
        }
        action={
          <span className="flex flex-wrap gap-2">
            <LinkButton variant="ghost" icon="chevron-left" href={`/runs/${run.id}`}>
              Back to run
            </LinkButton>
            <Button icon="doc" onClick={() => setRaw("file")}>
              Raw file
            </Button>
            {(cp.review as { kind?: string } | null)?.kind === "edits" && <Button onClick={() => setRaw("agents")}>Agents&apos; file</Button>}
          </span>
        }
      />
      <p className="-mt-2 mb-3 flex flex-wrap items-center gap-2 text-sm text-text2" data-testid="review-context">
        <span>
          {run.document_slug ?? "Roadmap"} · draft from{" "}
          {source ? (
            <Link href={`/documents/${source.slug}/v/${source.version}`} className="text-accent-ink hover:underline">
              {prd}
            </Link>
          ) : (
            prd
          )}
          {review.attempt && review.attempt > 1 ? ` · attempt ${review.attempt}` : ""}
        </span>
        <Chip kind="line" title={`The ${cp.approver_role} role or above decides`}>
          {cp.approver_role}+
        </Chip>
      </p>
      {error && (
        <p className="mb-2 text-sm text-crit" role="alert">
          {error}
        </p>
      )}
      <Split inspector={!phone && fileProblems.length === 0 ? inspector : undefined}>
        {fileProblems.length > 0 ? (
          <div className="rounded-panel border border-crit/40 bg-crit-bg p-4" role="alert" data-testid="file-problems">
            <p className="font-semibold text-crit">Oracle can&apos;t read this file as items</p>
            <ul className="mt-1 ml-4 list-disc text-sm break-words">
              {fileProblems.map((p) => (
                <li key={p.code + p.message}>{p.message}</li>
              ))}
            </ul>
            <p className="mt-2 text-sm text-text2">Send it back: the agents get the problems and write the file again.</p>
            <div className="mt-2">
              <Button onClick={() => setRaw("file")}>Raw file</Button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              <span className="font-semibold">{plural(items.filter((x) => x.position != null).length, "item")}</span>
              <FilterChips<Filter>
                label="Show"
                value={filter}
                onChange={setFilter}
                items={[
                  { value: "needs", label: "Needs you", count: needing.length },
                  { value: "all", label: "All", count: items.length },
                  ...(showChanged ? [{ value: "changed" as const, label: "Changed", count: items.filter(changed).length }] : []),
                ]}
              />
              <span className="text-sm text-text2" data-testid="review-summary">
                {tally.blocking_open} blocking · {tally.to_confirm_open} to confirm
              </span>
              <span className="ml-auto flex items-center gap-2 text-sm text-text2">
                Group
                <SegmentedControl<Group> label="Group" size="sm" value={group} onChange={setGroup} items={[{ value: "horizon", label: "Horizon" }, { value: "reason", label: "Reason" }]} />
              </span>
            </div>
            <ItemsTable
              label="Roadmap items"
              rows={tableRows}
              selected={selectedItem?.key ?? null}
              onSelect={(k) => pick(byKey.get(k)!)}
              onActivate={activate}
              hide={["depends_on", "prd", "state"]}
              widths={{ position: "36px", horizon: "72px", milestone: "112px" }}
              extraColumns={columns}
              rowDecorations={(r) => ({ "data-state": byKey.get(r.key)?.state })}
              groupBy={groupBy}
              groupOrder={groupOrder}
              groupLabel={groupHead}
              detail={(r) => (form?.key === r.key && form.where === "row" ? <RowForm it={byKey.get(r.key)!} form={form} mode={mode} ops={ops} onDone={() => setForm(null)} /> : null)}
              empty={filter === "needs" ? "Nothing needs you. Approve, or look at All." : "No items here."}
            />
          </>
        )}
        <DecisionBar
          runId={run.id}
          checkpointId={cp.id}
          title="Roadmap items"
          tally={tallyNode}
          chips={chips}
          changes={chips.length + questions.length + (fileProblems.length ? 1 : 0)}
          edits={edits}
          gate={review.gate ?? null}
          console={cp.console ?? null}
          revision={review.revision}
          savedNote={review.note ?? null}
          canDecide={mode === "approver" && !!review.can_decide}
          canNote={!!review.can_stage}
          approveBlocked={agentOnly ? `${agentOnly.kind === "split" ? "Split" : "Merge"} needs the agents` : null}
          sendBackSummary={
            fileProblems.length
              ? `${plural(fileProblems.length, "problem")} of the file for the agents`
              : `${plural(entries, "entry").replace("entrys", "entries")} · ${plural(unchanged, "unchanged item")} · ${plural(tally.blocking_open, "problem")} left for the agents`
          }
          decidedBy={cp.status === "pending" && mode !== "approver" ? "An approver decides" : null}
          onReload={reload}
          onDecided={() => {
            invalidateWaiting();
            waitingChanged();
            void Promise.all([reloadRun(), reload()]);
          }}
        />
      </Split>
      <Sheet open={phone && sheet && !!inspector} title={selectedItem?.title ?? "Item"} onClose={() => setSheet(false)} testId="sheet-item">
        {inspector}
      </Sheet>
      <RawFileSheet open={raw} onClose={() => setRaw(null)} runId={run.id} seq={review.file?.seq ?? cp.segment_seq ?? 1} />
    </Page>
  );
}

/** The row's reasons: at most two chips ("+n" for the rest), and in Changed the resolution and the diff. */
function ReasonsCell({ it, showDiff }: { it: Item; showDiff: boolean }) {
  const open = openReasons(it);
  const shown = [...open, ...it.reasons.filter((r) => !open.includes(r))];
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex min-w-0 flex-wrap gap-1" data-testid="row-reasons">
        {shown.slice(0, 2).map((r) => (
          <span key={r.code} data-testid="reason-chip" className="max-w-full">
            <Chip kind={!open.includes(r) ? "na" : r.severity === "blocking" ? "crit" : "warn"} title={r.text} wrap>
              {r.label}
            </Chip>
          </span>
        ))}
        {shown.length > 2 && (
          <Chip kind="line" title={shown.slice(2).map((r) => r.label).join(", ")}>
            +{shown.length - 2}
          </Chip>
        )}
        {showDiff && it.resolution && (
          <span data-testid="resolution-chip">
            <Chip kind={it.resolution.outcome === "done" ? "pass" : "warn"} wrap>
              {resolutionText(it.resolution)}
            </Chip>
          </span>
        )}
        {it.position == null && <span className="text-[13px] text-text2">Not in this file</span>}
      </span>
      {showDiff && it.diff.length > 0 && (
        <ul className="text-sm text-text2" data-testid="row-diff">
          {it.diff.map((d) => (
            <li key={d.field} className="break-words">
              {d.field}: <s>{show(d.from)}</s> → {show(d.to)}
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}

/** The row's call: what was done (✓ … · Undo), who was asked, else the first fixes. */
function YourCall({ it, open, staged, mode, ops, titleOf, meId }: { it: Item; open: Reason[]; staged: Action[]; mode: Mode; ops: Ops; titleOf: (k: string) => string; meId: string | null }) {
  const asked = it.actions.find((a) => a.kind === "question" && a.question);
  const askedChip = asked?.question && (
    <span data-testid="asked-chip">
      <Chip kind={asked.question.status === "answered" ? "pass" : "acc"}>{asked.question.status === "answered" ? "Answered" : `Asked ${asked.question.asked_to?.name ?? "a teammate"}`}</Chip>
    </span>
  );
  if (it.state === "handled" && staged.length) {
    const a = staged[0];
    const mayUndo = mode === "approver" || (a.created_by?.id != null && a.created_by.id === meId);
    return (
      <>
        <span className="flex flex-wrap items-center gap-1 text-sm font-medium text-pass" data-testid="row-done">
          ✓ {doneText(a, titleOf)}
          {mayUndo && (
            <>
              <span aria-hidden>·</span>
              <Button variant="ghost" className="h-8 px-2 text-sm max-[600px]:h-10" onClick={() => void ops.remove(a.id)}>
                Undo
              </Button>
            </>
          )}
        </span>
        {askedChip}
      </>
    );
  }
  if (askedChip && it.state === "waiting") return askedChip;
  if (mode === "viewer" || !open.length) return askedChip || (it.reasons.length ? <span className="text-sm text-text2">{it.state === "handled" ? "✓ Handled" : ""}</span> : <span className="text-sm text-text2">—</span>);
  return (
    <>
      {askedChip}
      {rowFixes(open).map(({ reason, fix }, i) => (
        <FixButton key={fix.label} fix={fix} reason={reason} mode={mode} ops={ops} primary={i === 0} />
      ))}
    </>
  );
}

/** Stages a fix (or suggests it, for a commenter), answering its reason when it is the row's. */
const applyFix = (fix: Fix, reason: Reason, ops: Ops) =>
  ops.act({ item_key: fix.action.item, kind: fix.action.kind, field: fix.action.field ?? null, value: fix.action.value ?? null, answers: fix.action.item === reason.item ? [reason.code] : [] });

export function FixButton({ fix, reason, mode, ops, primary }: { fix: Fix; reason: Reason; mode: Mode; ops: Ops; primary?: boolean }) {
  return (
    <Button
      variant={primary ? "primary" : "secondary"}
      className="h-8 px-2.5 text-sm max-[600px]:h-10"
      title={mode === "commenter" ? "Suggest: an approver stages it" : undefined}
      onClick={() => void applyFix(fix, reason, ops)}
    >
      {fix.label}
    </Button>
  );
}

/**
 * Enter on a row (criterion 16): the row's first fix as "Confirm: {fix}", focused, so Enter
 * again applies it; Cancel or Escape goes back to the row with nothing staged.
 */
function ConfirmFix({ fix, reason, ops, onDone }: { fix: Fix; reason: Reason; ops: Ops; onDone: () => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => ref.current?.querySelector("button")?.focus(), []);
  return (
    <span
      ref={ref}
      className="flex flex-wrap items-center justify-end gap-1"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        onDone();
      }}
    >
      <Button variant="primary" className="h-8 px-2.5 text-sm max-[600px]:h-10" onClick={() => void applyFix(fix, reason, ops).then(onDone)}>
        Confirm: {fix.label}
      </Button>
      <Button variant="ghost" className="h-8 px-2.5 text-sm max-[600px]:h-10" onClick={onDone}>
        Cancel
      </Button>
    </span>
  );
}

/** Commenters' suggestions on the row: Stage and Dismiss for approvers; Undo for their author. */
function Suggestions({ it, mode, ops, titleOf, meId }: { it: Item; mode: Mode; ops: Ops; titleOf: (k: string) => string; meId: string | null }) {
  const list = it.actions.filter((a) => a.state === "suggested");
  if (!list.length) return null;
  return (
    <>
      {list.map((a) => {
        const mine = a.created_by?.id != null && a.created_by.id === meId;
        return (
          <p key={a.id} className="flex flex-wrap items-center justify-end gap-2 text-sm text-text2 max-[600px]:justify-start" data-testid="suggested-by">
            <span>
              Suggested by {mine ? "you" : (a.created_by?.name ?? "someone")}: {describe(a, it, titleOf)}
            </span>
            {mode === "approver" && (
              <>
                <Button className="h-8 px-2.5 text-sm" variant="primary" onClick={() => void ops.stage(a.id)}>
                  Stage
                </Button>
                <Button className="h-8 px-2.5 text-sm" variant="ghost" onClick={() => void ops.remove(a.id)}>
                  Dismiss
                </Button>
              </>
            )}
            {mode !== "approver" && mine && (
              <Button className="h-8 px-2.5 text-sm" variant="ghost" onClick={() => void ops.remove(a.id)}>
                Undo
              </Button>
            )}
          </p>
        );
      })}
    </>
  );
}

/** The row's ⋯ menu: move, remove a dependency, split, ask, drop, waive (approvers, waivable reasons). */
function RowMenu({
  it,
  open,
  mode,
  ops,
  menuOpen,
  setMenu,
  setForm,
  onSelect,
}: {
  it: Item;
  open: Reason[];
  mode: Mode;
  ops: Ops;
  menuOpen: boolean;
  setMenu: (open: boolean) => void;
  setForm: (f: Form) => void;
  onSelect: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setMenu(false);
    const esc = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setMenu(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [menuOpen, setMenu]);
  const { can } = useMe();
  const waive = open.find((r) => mayWaive(r, can("waive_strategy_finding")));
  const answers = open.map((r) => r.code);
  const entries: { label: string; run: () => void }[] = [
    ...HORIZONS.filter((h) => h !== it.horizon).map((h) => ({
      label: `Move to ${horizonLabel(h)}`,
      run: () => void ops.act({ item_key: it.key, kind: "edit", field: "horizon", value: h, answers: [] }),
    })),
    ...(it.depends_on.length ? [{ label: "Remove dependency…", run: onSelect }] : []),
    { label: "Edit outcome", run: onSelect },
    { label: "Split…", run: () => setForm({ key: it.key, kind: "split", where: "row" }) },
    { label: "Ask a teammate…", run: () => setForm({ key: it.key, kind: "ask", where: "row" }) },
    { label: "Drop", run: () => void ops.act({ item_key: it.key, kind: "drop", answers }) },
    ...(mode === "approver" && waive ? [{ label: "Waive…", run: () => setForm({ key: it.key, kind: "waive", code: waive.code, where: "row" }) }] : []),
  ];
  return (
    <div ref={ref} className="relative">
      <Button variant="ghost" className="h-8 w-8 justify-center px-0 max-[600px]:h-10 max-[600px]:w-10" aria-label={`More actions for ${it.title ?? it.key}`} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenu(!menuOpen)}>
        ⋯
      </Button>
      {menuOpen && (
        <div role="menu" aria-label={`Actions for ${it.title ?? it.key}`} className="absolute right-0 z-30 mt-1 flex w-56 flex-col rounded-button border border-line bg-surface py-1 shadow-panel">
          {entries.map((e) => (
            <button
              key={e.label}
              type="button"
              role="menuitem"
              className="px-3 py-2 text-left text-sm hover:bg-surface2 focus-visible:bg-surface2 focus-visible:outline-2 focus-visible:outline-accent"
              onClick={() => {
                setMenu(false);
                e.run();
              }}
            >
              {e.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Waive…, Split… and Ask a teammate…: a small form under the row (or in the inspector). */
export function RowForm({ it, form, mode, ops, onDone }: { it: Item; form: NonNullable<Form>; mode: Mode; ops: Ops; onDone: () => void }) {
  const [text, setText] = useState("");
  const [who, setWho] = useState("");
  const people = useQuery(form.kind === "ask" ? "people|writers" : "people|none", () =>
    form.kind === "ask" ? unwrap(api.GET("/v1/people", { params: { query: { limit: 100 } } })) : Promise.resolve([] as Schemas["PersonOut"][]),
  );
  const submit = async () => {
    if (form.kind === "waive") await ops.act({ item_key: it.key, kind: "waive", value: { reason: text.trim() }, answers: form.code ? [form.code] : [] });
    if (form.kind === "split")
      await ops.act({
        item_key: it.key,
        kind: "split",
        value: { into: text.split("\n").map((x) => x.trim()).filter(Boolean) },
        answers: [],
      });
    if (form.kind === "ask") await ops.act({ item_key: it.key, kind: "question", value: { asked_to: who, text: text.trim() }, answers: [] });
    onDone();
  };
  const ok = form.kind === "ask" ? !!who && !!text.trim() : form.kind === "split" ? text.split("\n").filter((x) => x.trim()).length >= 2 : !!text.trim();
  return (
    <div className="flex flex-col gap-2" data-testid={`form-${form.kind}`}>
      {form.kind === "ask" && (
        <label className="text-sm">
          <span className="mr-2">Ask</span>
          <select aria-label="Ask" value={who} onChange={(e) => setWho(e.target.value)} className={`${INPUT} max-w-xs`}>
            <option value="">Pick a member</option>
            {(people.data ?? [])
              .filter((p) => p.can_write)
              .map((p) => (
                <option key={p.user_id} value={p.user_id}>
                  {p.name}
                </option>
              ))}
          </select>
        </label>
      )}
      <textarea
        aria-label={form.kind === "waive" ? "Why waive it" : form.kind === "split" ? "Split into" : "Question"}
        placeholder={form.kind === "waive" ? "Why waive it" : form.kind === "split" ? "One new item per line" : "Your question (500 characters)"}
        value={text}
        maxLength={500}
        rows={2}
        onChange={(e) => setText(e.target.value)}
        className={INPUT}
      />
      <span className="flex gap-2">
        <Button variant="solid" disabled={!ok} title={mode === "commenter" && form.kind !== "ask" ? "Suggest: an approver stages it" : undefined} onClick={() => void submit()}>
          {form.kind === "waive" ? "Waive" : form.kind === "split" ? "Stage split" : "Ask"}
        </Button>
        <Button onClick={onDone}>Cancel</Button>
      </span>
    </div>
  );
}

/**
 * D1: one item in E2's ItemInspector: its reasons as cards with their fixes first, then the
 * Horizon control, Outcome with Edit, the milestone's Remove date, a remove (×) per dependency,
 * why its rank, From the PRD, the footer (Ask a teammate, Split, Drop) and the History tab.
 */
function ReviewInspector({
  item,
  items,
  rows,
  count,
  review,
  mode,
  ops,
  form,
  setForm,
  prd,
  meId,
}: {
  item: Item;
  items: Item[];
  rows: TableRow[];
  count: number;
  review: Review;
  mode: Mode;
  ops: Ops;
  form: Form;
  setForm: (f: Form) => void;
  prd: { slug: string; version: number } | null;
  meId: string | null;
}) {
  const [editing, setEditing] = useState(false);
  const { can } = useMe();
  const titleOf = (key: string) => items.find((x) => x.key === key)?.title ?? key;
  const open = openReasons(item);
  const edit = mode !== "viewer" && item.position != null;
  const staged = (field: string) => item.actions.find((a) => a.kind === "edit" && a.field === field && (a.state === "staged" || a.created_by?.id === meId));
  const horizon = (staged("horizon")?.value as string | undefined) ?? item.horizon ?? "now";
  const outcome = (staged("outcome")?.value as string | undefined) ?? item.outcome ?? "";
  const removedDeps = ((staged("depends_on")?.value as { remove?: string[] } | undefined)?.remove ?? []) as string[];
  const act = ops.act;
  const row = { ...toRow(item, prd), outcome: outcome || null };

  const reasons: ReactNode = (
    <>
      {item.reasons.length > 0 && (
        <InspectorSection label="Needs you because" testId="item-reasons-cards">
          <ul className="flex flex-col gap-2">
            {item.reasons.map((r) => {
              const isOpen = open.includes(r);
              const by = item.actions.find((a) => a.state === "staged" && a.kind !== "question" && (a.kind === "waive" || !a.answers.length || a.answers.includes(r.code)));
              return (
                <li key={r.code} className="rounded-button border border-line p-2.5" data-testid="reason-card">
                  <Chip kind={!isOpen ? "na" : r.severity === "blocking" ? "crit" : "warn"} wrap>
                    {r.severity === "blocking" ? "Blocking" : "To confirm"} · {r.label}
                  </Chip>
                  <p className="mt-1.5 text-sm break-words">{r.text}</p>
                  {!isOpen && by ? (
                    <p className="mt-1.5 flex items-center gap-2 text-sm font-medium text-pass">
                      ✓ {doneText(by, titleOf)}
                      {(mode === "approver" || by.created_by?.id === meId) && (
                        <Button variant="ghost" className="h-8 px-2 text-sm" onClick={() => void ops.remove(by.id)}>
                          Undo
                        </Button>
                      )}
                    </p>
                  ) : (
                    mode !== "viewer" && (
                      <p className="mt-1.5 flex flex-wrap gap-1.5">
                        {r.fixes
                          .filter((f) => f.action.kind !== "waive")
                          .map((f, i) => (
                            <FixButton key={f.label} fix={f} reason={r} mode={mode} ops={ops} primary={i === 0} />
                          ))}
                        {mode === "approver" && mayWaive(r, can("waive_strategy_finding")) && (
                          <Button className="h-8 px-2.5 text-sm" onClick={() => setForm({ key: item.key, kind: "waive", code: r.code, where: "inspector" })}>
                            Waive…
                          </Button>
                        )}
                      </p>
                    )
                  )}
                </li>
              );
            })}
          </ul>
        </InspectorSection>
      )}
      {form && (
        <InspectorSection>
          <RowForm it={item} form={form} mode={mode} ops={ops} onDone={() => setForm(null)} />
        </InspectorSection>
      )}
    </>
  );

  return (
    <ItemInspector
      row={row}
      total={count}
      rows={rows}
      eyebrow={item.position == null ? "Not in this file · selected" : undefined}
      reasons={reasons}
      horizonControl={
        edit ? (
          <SegmentedControl<string>
            label="Horizon"
            size="sm"
            value={horizon}
            onChange={(h) => void act({ item_key: item.key, kind: "edit", field: "horizon", value: h, answers: [] })}
            items={HORIZONS.map((h) => ({ value: h, label: horizonLabel(h) }))}
          />
        ) : (
          <p className="text-sm">{horizonLabel(item.horizon)}</p>
        )
      }
      outcomeEdit={
        editing ? (
          <OutcomeEdit
            value={outcome}
            onCancel={() => setEditing(false)}
            onSave={async (v) => {
              await act({ item_key: item.key, kind: "edit", field: "outcome", value: v, answers: [] });
              setEditing(false);
            }}
          />
        ) : (
          <p className="flex flex-wrap items-start gap-2 text-[15px] break-words">
            <span className="min-w-0 flex-1">{outcome || "—"}</span>
            {edit && (
              <Button variant="ghost" className="h-7 px-2 text-sm" aria-label="Edit outcome" onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
          </p>
        )
      }
      milestoneAction={
        edit && item.milestone?.date && !dateRemoved(item) ? (
          <Button className="h-8 px-2.5 text-sm" onClick={() => void act({ item_key: item.key, kind: "edit", field: "milestone_date", value: null, answers: [] })}>
            Remove date
          </Button>
        ) : null
      }
      removedDependencies={removedDeps}
      dependencyAction={
        edit
          ? (d) => (
              <Button
                variant="ghost"
                className="h-7 w-7 justify-center px-0"
                aria-label={`Remove dependency ${titleOf(d)}`}
                onClick={() => void act({ item_key: item.key, kind: "edit", field: "depends_on", value: { add: [], remove: [...removedDeps, d] }, answers: [] })}
              >
                ×
              </Button>
            )
          : undefined
      }
      priority={item.rank != null ? { rank: item.rank, explanation: `Ranked ${item.rank} in the priority order this run read.` } : undefined}
      tabs={[{ value: "history", label: "History", content: <History item={item} review={review} titleOf={titleOf} /> }]}
    >
      {edit && (
        <InspectorSection>
          <footer className="flex flex-wrap gap-2">
            <Button className="h-8 px-2.5 text-sm" onClick={() => setForm({ key: item.key, kind: "ask", where: "inspector" })}>
              Ask a teammate…
            </Button>
            <Button className="h-8 px-2.5 text-sm" onClick={() => setForm({ key: item.key, kind: "split", where: "inspector" })}>
              Split…
            </Button>
            <Button className="h-8 px-2.5 text-sm" onClick={() => void act({ item_key: item.key, kind: "drop", answers: open.map((r) => r.code) })}>
              Drop
            </Button>
          </footer>
        </InspectorSection>
      )}
    </ItemInspector>
  );
}

function OutcomeEdit({ value, onSave, onCancel }: { value: string; onSave: (v: string) => Promise<void>; onCancel: () => void }) {
  const [text, setText] = useState(value);
  return (
    <div className="flex flex-col gap-2">
      <textarea aria-label="Outcome" value={text} maxLength={OUTCOME_MAX} rows={3} onChange={(e) => setText(e.target.value)} className={INPUT} />
      <span className="flex gap-2">
        <Button variant="solid" disabled={!text.trim() || text === value} onClick={() => void onSave(text.trim())}>
          Save
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </span>
    </div>
  );
}

/** This attempt's changes to the item and its answer to the review (D6), and the draft's actions on it (D8). */
function History({ item, review, titleOf }: { item: Item; review: Review; titleOf: (k: string) => string }) {
  const empty = !item.diff.length && !item.resolution && !item.actions.length;
  return (
    <InspectorSection testId="item-history">
      <div className="flex flex-col gap-3 text-sm">
        {empty && <p className="text-text2">Nothing changed on this item in attempt {review.attempt ?? 1}.</p>}
        {item.resolution && (
          <p>
            The agents&apos; answer to the review:{" "}
            <Chip kind={item.resolution.outcome === "done" ? "pass" : "warn"} wrap>
              {resolutionText(item.resolution)}
            </Chip>
          </p>
        )}
        {item.diff.length > 0 && (
          <ul className="flex flex-col gap-1">
            {item.diff.map((d) => (
              <li key={d.field} className="break-words">
                {d.field}: <s>{show(d.from)}</s> → {show(d.to)}
              </li>
            ))}
          </ul>
        )}
        {item.actions.length > 0 && (
          <ul className="flex flex-col gap-1">
            {item.actions.map((a) => (
              <li key={a.id}>
                {a.created_by?.name ?? "Someone"} {a.state === "staged" ? "staged" : "suggested"}: {a.kind === "question" ? `asked ${a.question?.asked_to?.name ?? "a teammate"}` : doneText(a, titleOf)}
                {a.question?.answer?.body && <span className="block text-text2">Answer: {a.question.answer.body}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </InspectorSection>
  );
}
