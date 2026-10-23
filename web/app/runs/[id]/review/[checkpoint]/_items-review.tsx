"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { Button, Chip, FilterChips, Page, PageHeader, Ring, SegmentedControl, Sheet, Split } from "@/components/ds";
import { DecisionBar, type StagedChip } from "@/components/review/DecisionBar";
import { ErrorNote, INPUT, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { hasRole, useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";
import { invalidateWaiting, waitingChanged } from "@/lib/waiting";

import { ItemsInspector } from "./_items-inspector";
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
  rowFixes,
  show,
  waivable,
  type Action,
  type Fix,
  type Item,
  type Mode,
  type Reason,
  type Review,
} from "./_items-lib";
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
  const { role, can, me } = useMe();
  const phone = usePhone();
  const path = { params: { path: { run_id: run.id, checkpoint_id: cp.id } } };
  const reviewQ = useQuery(`draft|${run.id}|${cp.id}`, () => unwrap(api.GET("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/review", path)));
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
  const tableRef = useRef<HTMLDivElement>(null);

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
      : review.can_stage && can("stage_checkpoint_action", hasRole(role, cp.approver_role))
        ? "approver"
        : review.can_suggest && can("create_checkpoint_action", hasRole(role, "commenter"))
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
  const groups: { label: string; rows: Item[] }[] = [];
  const order = group === "horizon" ? [...HORIZONS.map(horizonLabel), horizonLabel(null)] : [];
  for (const it of rows) {
    const label = group === "horizon" ? horizonLabel(it.horizon) : (openReasons(it)[0]?.label ?? (it.reasons.length ? "Handled" : "Nothing open"));
    const g = groups.find((x) => x.label === label);
    if (g) g.rows.push(it);
    else groups.push({ label, rows: [it] });
  }
  if (group === "horizon") groups.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
  const groupHead = (g: { label: string; rows: Item[] }) => {
    if (group !== "horizon") return `${g.label} · ${g.rows.length}`;
    const all = items.filter((x) => horizonLabel(x.horizon) === g.label);
    const need = all.filter((x) => x.reasons.length > 0).length;
    return `${g.label} · ${need} of ${all.length} need you`;
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
  // The row picked, else the first that needs me (the inspector is never empty).
  const shownRows = groups.flatMap((g) => g.rows);
  const selectedItem = items.find((x) => x.key === selected) ?? shownRows.find((x) => x.state === "needs_you") ?? shownRows[0] ?? null;
  const source = run.source;
  const prd = source ? `${source.title} v${source.version}` : "the PRD";

  const pick = (it: Item) => {
    setSelected(it.key);
    if (phone) setSheet(true);
  };
  // ↑/↓ move the selection between rows; no single-key decisions.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select, [role=menu]")) return;
    // From the focused row, else the selected one.
    const focused = target.closest<HTMLElement>("[data-key]")?.dataset.key;
    const at = shownRows.findIndex((x) => x.key === (focused ?? selectedItem?.key));
    const next = shownRows[Math.min(shownRows.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)))];
    if (!next) return;
    e.preventDefault();
    setSelected(next.key);
    tableRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(next.key)}"] [data-testid="item-title"]`)?.focus();
  };

  const inspector = selectedItem && (
    <ItemsInspector
      item={selectedItem}
      items={items}
      count={items.filter((x) => x.position != null).length}
      review={review}
      mode={mode}
      ops={ops}
      form={form?.key === selectedItem.key && form.where === "inspector" ? form : null}
      setForm={setForm}
      prd={source ? { slug: source.slug, version: source.version } : null}
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
            <div
              ref={tableRef}
              role="table"
              aria-label="Roadmap items"
              onKeyDown={onKey}
              className="min-w-0 rounded-panel border border-line bg-surface max-[600px]:border-0 max-[600px]:bg-transparent"
              data-testid="items-table"
            >
              <div role="row" className={`grid ${COLS} items-center gap-x-2 border-b border-line px-2 py-2 text-[13px] font-semibold text-text2 max-[900px]:hidden`}>
                <span role="columnheader">#</span>
                <span role="columnheader">Item</span>
                <span role="columnheader">Horizon</span>
                <span role="columnheader">Milestone</span>
                <span role="columnheader">Conf.</span>
                <span role="columnheader">Needs you because</span>
                <span role="columnheader" className="text-right">
                  Your call
                </span>
              </div>
              {rows.length === 0 && (
                <p className="px-4 py-6 text-sm text-text2" data-testid="items-empty">
                  {filter === "needs" ? "Nothing needs you. Approve, or look at All." : "No items here."}
                </p>
              )}
              {groups.map((g) => (
                <div key={g.label} role="rowgroup" aria-label={g.label} className="max-[900px]:flex max-[900px]:flex-col max-[900px]:gap-2">
                  <div role="row" className="border-b border-line bg-surface2 px-3 py-1.5 text-sm font-semibold max-[900px]:border-0 max-[900px]:bg-transparent max-[900px]:px-1">
                    <span role="cell" data-testid="group-head">
                      {groupHead(g)}
                    </span>
                  </div>
                  {g.rows.map((it) => (
                    <ItemRow
                      key={it.key}
                      it={it}
                      mode={mode}
                      ops={ops}
                      selected={selectedItem?.key === it.key}
                      showDiff={filter === "changed"}
                      ghost={it.position == null}
                      titleOf={titleOf}
                      menuOpen={menu === it.key}
                      setMenu={(open) => setMenu(open ? it.key : null)}
                      form={form?.key === it.key && form.where === "row" ? form : null}
                      setForm={setForm}
                      onSelect={() => pick(it)}
                      meId={me?.user_id ?? null}
                    />
                  ))}
                </div>
              ))}
            </div>
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
      <RawFile open={raw} onClose={() => setRaw(null)} runId={run.id} seq={review.file?.seq ?? cp.segment_seq ?? 1} />
    </Page>
  );
}

const COLS = "grid-cols-[24px_minmax(100px,1.5fr)_64px_minmax(72px,1fr)_40px_minmax(110px,1.4fr)_minmax(150px,1.6fr)]";

function ItemRow({
  it,
  mode,
  ops,
  selected,
  showDiff,
  ghost,
  titleOf,
  menuOpen,
  setMenu,
  form,
  setForm,
  onSelect,
  meId,
}: {
  it: Item;
  mode: Mode;
  ops: Ops;
  selected: boolean;
  showDiff: boolean;
  ghost: boolean;
  titleOf: (key: string) => string;
  menuOpen: boolean;
  setMenu: (open: boolean) => void;
  form: Form;
  setForm: (f: Form) => void;
  onSelect: () => void;
  meId: string | null;
}) {
  const open = openReasons(it);
  const staged = it.actions.filter((a) => a.state === "staged" && a.kind !== "question");
  const dropped = staged.some((a) => a.kind === "drop");
  const dateGone = it.actions.some((a) => a.kind === "edit" && a.field === "milestone_date" && a.value == null);
  const handled = it.state === "handled";
  const shown = [...open, ...it.reasons.filter((r) => !open.includes(r))];
  return (
    <div
      role="row"
      aria-selected={selected}
      data-testid="item-row"
      data-key={it.key}
      className={`border-b border-line last:border-b-0 max-[900px]:rounded-button max-[900px]:border max-[900px]:bg-surface ${selected ? "bg-accent-soft/50 shadow-[inset_4px_0_0_var(--accent)]" : ""} ${ghost ? "opacity-80" : ""}`}
    >
      <div className={`grid ${COLS} items-center gap-x-2 px-2 py-2 max-[900px]:flex max-[900px]:flex-wrap max-[900px]:gap-2 max-[900px]:px-3`}>
        <span role="cell" className="tnum text-sm text-text2 max-[900px]:hidden">
          {it.position ?? "—"}
        </span>
        <span role="cell" className="flex min-w-0 flex-col max-[900px]:basis-full">
          <button
            type="button"
            onClick={onSelect}
            className={`min-w-0 text-left font-medium break-words hover:underline focus-visible:outline-2 focus-visible:outline-accent ${handled ? "text-text2" : ""} ${dropped || ghost ? "line-through" : ""}`}
            data-testid="item-title"
          >
            {it.title ?? it.key}
          </button>
          {ghost && <span className="text-[13px] text-text2">Not in this file</span>}
          <span className="hidden text-[13px] text-text2 max-[900px]:block">
            {[horizonLabel(it.horizon), it.milestone?.name, it.depends_on.length ? `depends on ${it.depends_on.map(titleOf).join(", ")}` : null].filter(Boolean).join(" · ")}
          </span>
        </span>
        <span role="cell" className="max-[900px]:hidden">
          {it.horizon && <Chip kind={it.horizon === "now" ? "now" : "line"}>{horizonLabel(it.horizon)}</Chip>}
        </span>
        <span role="cell" className="min-w-0 text-sm break-words max-[900px]:hidden">
          {it.milestone?.name}
          {it.milestone?.date && (
            <span className="block text-text2">
              {dateGone ? <s title="Date removed">{day(it.milestone.date)}</s> : day(it.milestone.date)}
            </span>
          )}
        </span>
        <span role="cell" className="max-[900px]:hidden" title={it.confidence ? `Confidence ${it.confidence}` : undefined}>
          {it.confidence && (/^[\d.]+$/.test(it.confidence) ? <Ring value={Math.round(Number(it.confidence) * (Number(it.confidence) <= 1 ? 100 : 1))} size={32} stroke={4} /> : <span className="text-sm">{it.confidence}</span>)}
        </span>
        <span role="cell" className="flex min-w-0 flex-wrap gap-1" data-testid="row-reasons">
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
        </span>
        <span role="cell" className="flex min-w-0 flex-wrap items-center justify-end gap-1 max-[900px]:basis-full max-[900px]:justify-start" data-testid="your-call">
          <YourCall it={it} open={open} staged={staged} mode={mode} ops={ops} titleOf={titleOf} meId={meId} />
          {mode !== "viewer" && !ghost && <RowMenu it={it} open={open} mode={mode} ops={ops} menuOpen={menuOpen} setMenu={setMenu} setForm={setForm} onSelect={onSelect} />}
        </span>
      </div>
      {showDiff && it.diff.length > 0 && (
        <ul className="px-3 pb-2 pl-10 text-sm text-text2 max-[900px]:pl-3" data-testid="row-diff">
          {it.diff.map((d) => (
            <li key={d.field} className="break-words">
              {d.field}: <s>{show(d.from)}</s> → {show(d.to)}
            </li>
          ))}
        </ul>
      )}
      <Suggestions it={it} mode={mode} ops={ops} titleOf={titleOf} meId={meId} />
      {form && <RowForm it={it} form={form} mode={mode} ops={ops} onDone={() => setForm(null)} />}
    </div>
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

export function FixButton({ fix, reason, mode, ops, primary }: { fix: Fix; reason: Reason; mode: Mode; ops: Ops; primary?: boolean }) {
  return (
    <Button
      variant={primary ? "primary" : "secondary"}
      className="h-8 px-2.5 text-sm max-[600px]:h-10"
      title={mode === "commenter" ? "Suggest: an approver stages it" : undefined}
      onClick={() =>
        void ops.act({ item_key: fix.action.item, kind: fix.action.kind, field: fix.action.field ?? null, value: fix.action.value ?? null, answers: fix.action.item === reason.item ? [reason.code] : [] })
      }
    >
      {fix.label}
    </Button>
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
          <p key={a.id} className="flex flex-wrap items-center gap-2 px-3 pb-2 pl-10 text-sm text-text2 max-[900px]:pl-3" data-testid="suggested-by">
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
  const waive = open.find((r) => waivable(r));
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
    <div className="flex flex-col gap-2 px-3 pb-3 pl-10 max-[900px]:pl-3" data-testid={`form-${form.kind}`}>
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

/** roadmap_items.yaml as it is now, or the agents' text when Approve with edits changed it (D7). */
function RawFile({ open, onClose, runId, seq }: { open: "file" | "agents" | null; onClose: () => void; runId: string; seq: number }) {
  const [loaded, setLoaded] = useState<{ which: string; text: string } | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    api
      .GET("/v1/runs/{run_id}/segments/{seq}/artifacts/{name}", {
        params: { path: { run_id: runId, seq, name: "roadmap_items.yaml" }, query: open === "agents" ? { agents: true } : {} },
        parseAs: "text",
      })
      .then(({ data, response }) => {
        if (live) setLoaded({ which: open, text: response.ok ? (data as string) : `Could not load roadmap_items.yaml (${response.status}).` });
      });
    return () => {
      live = false;
    };
  }, [open, runId, seq]);
  return (
    <Sheet open={!!open} title={open === "agents" ? "Agents' file" : "Raw file"} onClose={onClose} testId="sheet-raw-file">
      <pre className="mx-4 my-3 max-h-[70vh] overflow-auto rounded-button bg-surface2 p-3 font-mono text-[13px] whitespace-pre-wrap break-words" data-testid="raw-file-content">
        {loaded?.which === open ? loaded.text : "Loading…"}
      </pre>
    </Sheet>
  );
}
