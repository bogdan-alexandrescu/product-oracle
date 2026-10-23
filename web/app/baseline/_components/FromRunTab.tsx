"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import { Button, Chip, FilterChips, InspectorSection } from "@/components/ds";
import { INPUT } from "@/components/ui";
import { api, unwrap, type EntityOut, type Schemas } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";

/**
 * B2 Baseline review from this run (/baseline?run=<id>): the band naming the run, the rows of
 * what it wrote to the baseline with the reasons each needs a person and its actions, and (for
 * approvers, while Confirm the baseline waits) the bottom bar that approves or sends back.
 */

export type FromRunOut = Schemas["FromRunOut"];
type Row = Schemas["FromRunRow"];
type Reason = Schemas["RowReason"];
type Action = Schemas["ReviewAction"];
type Filter = "needs" | "all" | "new" | "changed";

const GROUPS: { label: string; of: (t: string) => boolean }[] = [
  { label: "Goals", of: (t) => t === "goal" },
  { label: "Products", of: (t) => t === "product" },
  { label: "Features", of: (t) => t === "feature" },
  { label: "Other", of: (t) => !["goal", "product", "feature"].includes(t) },
];
const CHANGE: Record<Row["change"], string> = { new: "New", changed: "Changed", proposal: "Proposal" };
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Each write goes through the page (busy, errors, the lists' refresh). */
export type Act = (run: () => Promise<string>) => Promise<void>;

function waiveOf(row: Row): Action | undefined {
  return row.actions.find((a) => a.kind === "waive" && a.state === "staged");
}

function ReasonChip({ r }: { r: Reason }) {
  return (
    <Chip kind={r.severity === "blocking" ? "crit" : "warn"} title={r.detail ?? r.text} data-testid="reason-chip">
      {r.label}
    </Chip>
  );
}

/** The band above the tabs: the run, its counts, and once decided who decided it. */
export function FromRunBand({ view }: { view: FromRunOut }) {
  const cp = view.checkpoint;
  const s = view.summary;
  const decided = cp && cp.status !== "pending";
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-button border border-line bg-surface2 px-3 py-2" data-testid="from-run-band">
      <span className="font-semibold">
        From run ·{" "}
        <Link href={`/runs/${view.run.id}`} className="text-accent-ink hover:underline">
          {view.run.flow_title}
        </Link>{" "}
        · {formatDateTime(view.run.created_at)}
      </span>
      <Chip kind="line">{plural(s.items, "item")}</Chip>
      <Chip kind={s.need_you ? "warn" : "pass"} data-testid="band-need-you">
        {s.need_you} need you
      </Chip>
      <Chip kind={s.not_decided ? "crit" : "pass"} data-testid="band-not-decided">
        {s.not_decided} not decided
      </Chip>
      {decided && (
        <span className="text-text2" data-testid="band-decided">
          {cp.status === "approved" ? "Approved" : "Sent back"} by {cp.decided_by_name ?? "someone"}
          {cp.decided_at ? ` · ${formatDateTime(cp.decided_at)}` : ""}
        </span>
      )}
      {(decided || !cp?.can_suggest) && <Chip kind="na">View only</Chip>}
    </div>
  );
}

/** The drawer's first card: one sentence per reason, and its fixes as buttons. */
export function WhyCard({ row, fixes }: { row: Row; fixes: ReactNode }) {
  if (!row.reasons.length) return null;
  return (
    <InspectorSection label="Why it needs you">
      <ul className="flex flex-col gap-1.5" data-testid="why-card">
        {row.reasons.map((r) => (
          <li key={r.code} className="text-[15px]">
            <ReasonChip r={r} /> <span className="text-text2">{r.text}</span>
            {r.detail && <span className="block text-sm text-text2">{r.detail}</span>}
          </li>
        ))}
      </ul>
      {fixes && <div className="mt-2 flex flex-wrap gap-2">{fixes}</div>}
    </InspectorSection>
  );
}

type Props = {
  view: FromRunOut;
  /** Items of the baseline (Merge into…'s targets). */
  entities: EntityOut[];
  busy: boolean;
  selectedId: string | null;
  act: Act;
  onOpen: (id: string) => void;
};

/** One row's controls; `inDrawer` draws the fixes for the Why it needs you card. */
export function RowActions({ view, row, entities, busy, act, onOpen, inDrawer = false }: Omit<Props, "selectedId"> & { row: Row; inDrawer?: boolean }) {
  const cp = view.checkpoint;
  const pending = cp?.status === "pending";
  const stages = pending && !!cp?.can_stage;
  const suggests = pending && !!cp?.can_suggest;
  const [form, setForm] = useState<"waive" | "look" | "merge" | "more" | null>(null);
  const [text, setText] = useState("");
  const [into, setInto] = useState("");
  const e = row.entity;
  const path = { params: { path: { run_id: view.run.id, checkpoint_id: cp?.id ?? "" } } };
  const entityPath = { params: { path: { entity_id: e.id } } };
  const stageAction = (body: Schemas["ActionIn"], done: string) =>
    act(async () => {
      await unwrap(api.POST("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/actions", { ...path, body }));
      setForm(null);
      setText("");
      return done;
    });
  const undoAction = (a: Action, done: string) =>
    act(async () => {
      await unwrap(
        api.DELETE("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/actions/{action_id}", {
          params: { path: { run_id: view.run.id, checkpoint_id: cp!.id, action_id: a.id } },
        }),
      );
      return done;
    });
  const look = row.actions.find((a) => a.kind === "look_again");
  const lookChip = look && (
    <Chip kind={look.state === "staged" ? "acc" : "line"} data-testid="look-again-chip">
      {look.state === "staged" ? "Look again" : `Suggested by ${look.created_by?.name ?? "someone"}`}
    </Chip>
  );
  const open = !inDrawer && (
    <Button variant="ghost" onClick={() => onOpen(e.id)}>
      Open
    </Button>
  );
  const lookForm = (label: string) =>
    form === "look" ? (
      <form
        className="flex w-full flex-wrap items-center gap-2"
        onSubmit={(ev) => {
          ev.preventDefault();
          void stageAction({ item_key: row.key, kind: "look_again", answers: [], value: { note: text.trim() } }, stages ? "Look again staged." : "Look again suggested.");
        }}
      >
        <input aria-label="What should the agents look at" className={`${INPUT} min-w-0 flex-1`} value={text} onChange={(x) => setText(x.target.value)} />
        <Button type="submit" variant="solid" disabled={busy || !text.trim()}>
          {label}
        </Button>
        <Button variant="ghost" onClick={() => setForm(null)}>
          Cancel
        </Button>
      </form>
    ) : null;

  if (!pending) return <div className="flex flex-wrap items-center gap-2">{open}</div>;
  // Commenters suggest a look again; viewers read.
  if (!stages) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {lookChip}
        {suggests && !look && form !== "look" && (
          <Button onClick={() => setForm("look")}>Look again…</Button>
        )}
        {lookForm("Suggest")}
        {open}
      </div>
    );
  }

  // A proposal row: Accept or Reject the run's change.
  if (row.change === "proposal") {
    const pid = row.proposal_ids[0];
    const decided = row.proposals[row.proposals.length - 1];
    if (!pid) {
      return (
        <div className="flex flex-wrap items-center gap-2" data-testid="row-result">
          <span className="font-medium text-pass">{decided?.status === "accepted" ? "✓ Accepted" : "✓ Rejected"}</span>
          {open}
        </div>
      );
    }
    const decide = (accept: boolean) =>
      act(async () => {
        const params = { params: { path: { proposal_id: pid } } };
        if (accept) await unwrap(api.POST("/v1/baseline/proposals/{proposal_id}/accept", params));
        else await unwrap(api.POST("/v1/baseline/proposals/{proposal_id}/reject", params));
        return accept ? `Accepted the change to “${e.title}”.` : `Rejected the change to “${e.title}”.`;
      });
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="solid" disabled={busy} onClick={() => void decide(true)}>
          Accept
        </Button>
        <Button disabled={busy} onClick={() => void decide(false)}>
          Reject
        </Button>
        {open}
      </div>
    );
  }

  const waive = waiveOf(row);
  const setStatus = (status: "proposed" | "rejected", done: string) =>
    act(async () => {
      await unwrap(api.PATCH("/v1/baseline/entities/{entity_id}", { ...entityPath, body: { status, origin: "user" } }));
      return done;
    });
  if (e.status !== "proposed" || waive) {
    const result = e.status === "confirmed" ? "✓ Confirmed" : e.status === "rejected" ? "✓ Rejected" : `Left proposed: ${(waive?.value as { reason?: string } | null)?.reason ?? ""}`;
    return (
      <div className="flex flex-wrap items-center gap-2" data-testid="row-result">
        <span className="font-medium text-pass">{result}</span>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => void (waive && e.status === "proposed" ? undoAction(waive, "Undone: the goal is not decided again.") : setStatus("proposed", "Undone: the item is proposed again."))}
        >
          Undo
        </Button>
        {lookChip}
        {open}
      </div>
    );
  }

  const others = entities.filter((x) => x.type === e.type && x.id !== e.id && x.status !== "rejected");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="solid"
        disabled={busy}
        onClick={() =>
          void act(async () => {
            await unwrap(api.POST("/v1/baseline/entities/{entity_id}/confirm", entityPath));
            return `Confirmed “${e.title}”.`;
          })
        }
      >
        Confirm
      </Button>
      <Button disabled={busy} onClick={() => void setStatus("rejected", `Rejected “${e.title}”.`)}>
        Reject
      </Button>
      {e.type === "goal" && row.reasons.some((r) => r.code === "goal_undecided") && form !== "waive" && (
        <Button disabled={busy} onClick={() => setForm("waive")}>
          Leave proposed…
        </Button>
      )}
      {lookChip}
      {!inDrawer && (
        <Button variant="ghost" aria-label={`More actions for ${e.title}`} aria-expanded={form === "more"} onClick={() => setForm(form === "more" ? null : "more")}>
          ⋯
        </Button>
      )}
      {(form === "more" || inDrawer) && (
        <span className="flex flex-wrap gap-2" role="group" aria-label="More actions">
          <Button
            disabled={busy || !row.merge.allowed}
            title={row.merge.why_not ?? undefined}
            onClick={() => setForm("merge")}
          >
            Merge into…
          </Button>
          {!look && <Button onClick={() => setForm("look")}>Look again…</Button>}
          {!inDrawer && (
            <Button variant="ghost" onClick={() => onOpen(e.id)}>
              Open
            </Button>
          )}
        </span>
      )}
      {form === "waive" && (
        <form
          className="flex w-full flex-wrap items-center gap-2"
          onSubmit={(ev) => {
            ev.preventDefault();
            void stageAction(
              { item_key: row.key, kind: "waive", answers: ["goal_undecided"], value: { reason: text.trim() } },
              `“${e.title}” is left proposed.`,
            );
          }}
        >
          <input aria-label="Why leave it proposed" className={`${INPUT} min-w-0 flex-1`} value={text} onChange={(x) => setText(x.target.value)} />
          <Button type="submit" variant="solid" disabled={busy || !text.trim()}>
            Leave proposed
          </Button>
          <Button variant="ghost" onClick={() => setForm(null)}>
            Cancel
          </Button>
        </form>
      )}
      {lookForm("Look again")}
      {form === "merge" && (
        <form
          className="flex w-full flex-wrap items-center gap-2"
          onSubmit={(ev) => {
            ev.preventDefault();
            const target = others.find((x) => x.id === into);
            void act(async () => {
              await unwrap(api.POST("/v1/baseline/entities/{entity_id}/merge", { ...entityPath, body: { into, reason: null } }));
              setForm(null);
              return `Merged “${e.title}” into “${target?.title ?? "the item"}”.`;
            });
          }}
        >
          <select aria-label="Merge into" className={`${INPUT} min-w-0 flex-1`} value={into} onChange={(x) => setInto(x.target.value)}>
            <option value="">Choose an item</option>
            {others.map((x) => (
              <option key={x.id} value={x.id}>
                {x.title}
              </option>
            ))}
          </select>
          <Button type="submit" variant="solid" disabled={busy || !into}>
            Merge
          </Button>
          <Button variant="ghost" onClick={() => setForm(null)}>
            Cancel
          </Button>
        </form>
      )}
    </div>
  );
}

/** The "From this run" tab: filters, grouped rows, other proposed goals, the bottom bar. */
export function FromRunTab({ view, entities, busy, selectedId, act, onOpen }: Props) {
  const [filter, setFilter] = useState<Filter>("needs");
  // Needs you keeps a row decided here, with its result and Undo, until the filter changes.
  const needing = () => new Set(view.rows.filter((r) => r.state === "needs_you").map((r) => r.key));
  const [kept, setKept] = useState(needing);
  const show = (next: Filter) => {
    setFilter(next);
    setKept(needing());
  };
  const rows = view.rows.filter((r) =>
    filter === "needs" ? r.state === "needs_you" || kept.has(r.key) : filter === "new" ? r.change === "new" : filter === "changed" ? r.change === "changed" : true,
  );
  const count = (f: (r: Row) => boolean) => view.rows.filter(f).length;
  // #345: a subgoal's parent goal, a row of the run or not (the API lists it right after its parent).
  const parentOf = (r: Row) =>
    r.entity.parent_id ? (view.rows.find((x) => x.entity.id === r.entity.parent_id)?.entity ?? entities.find((x) => x.id === r.entity.parent_id)) : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-3 pb-40">
      <FilterChips<Filter>
        label="Show"
        value={filter}
        onChange={show}
        items={[
          { value: "needs", label: "Needs you", count: count((r) => r.state === "needs_you") },
          { value: "all", label: "All from this run", count: view.rows.length },
          { value: "new", label: "New", count: count((r) => r.change === "new") },
          { value: "changed", label: "Changed", count: count((r) => r.change === "changed") },
        ]}
      />
      {rows.length === 0 && <p className="text-text2">Nothing here needs you.</p>}
      {GROUPS.map((g) => {
        const mine = rows.filter((r) => g.of(r.entity.type));
        if (!mine.length) return null;
        return (
          <section key={g.label} aria-label={g.label} className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold tracking-wide text-text2 uppercase">{g.label}</h3>
            {mine.map((r) => (
              <div
                key={r.key}
                data-testid="from-run-row"
                aria-current={selectedId === r.entity.id ? "true" : undefined}
                className={`flex flex-col gap-2 rounded-button border border-line bg-surface p-3 md:flex-row md:flex-wrap md:items-center aria-[current=true]:border-accent ${parentOf(r) ? "ml-6" : ""}`}
              >
                <div className="min-w-0 md:w-64">
                  <button type="button" className="text-left font-medium hover:underline" onClick={() => onOpen(r.entity.id)}>
                    {r.entity.title}
                  </button>{" "}
                  <Chip kind="acc">{CHANGE[r.change]}</Chip>
                  {parentOf(r) && (
                    <span data-testid="subgoal-of" className="block text-sm text-text2">
                      Subgoal of {parentOf(r)!.title}
                    </span>
                  )}
                  <span className="block font-mono text-sm text-text2">{r.key}</span>
                </div>
                <div className="flex min-w-0 flex-1 flex-wrap gap-1" aria-label="Needs you because">
                  {r.reasons.map((x) => (
                    <ReasonChip key={x.code} r={x} />
                  ))}
                </div>
                <RowActions view={view} row={r} entities={entities} busy={busy} act={act} onOpen={onOpen} />
              </div>
            ))}
          </section>
        );
      })}
      {view.other_proposed_goals.length > 0 && (
        <details className="rounded-button border border-line p-3">
          <summary className="cursor-pointer font-medium">Other proposed goals ({view.other_proposed_goals.length})</summary>
          <ul className="mt-2 flex flex-col gap-1">
            {view.other_proposed_goals.map((g) => (
              <li key={g.id}>
                <button type="button" className="hover:underline" onClick={() => onOpen(g.id)}>
                  {g.title}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      <BottomBar view={view} busy={busy} act={act} />
    </div>
  );
}

/** Approvers, while the stop waits: the tally, staged look agains, the note, Approve and Send back. */
function BottomBar({ view, busy, act }: { view: FromRunOut; busy: boolean; act: Act }) {
  const cp = view.checkpoint;
  const [note, setNote] = useState(cp?.note ?? "");
  const [sheet, setSheet] = useState(false);
  if (!cp || cp.status !== "pending" || !cp.can_decide) return null;
  const path = { params: { path: { run_id: view.run.id, checkpoint_id: cp.id } } };
  const s = view.summary;
  const looks = view.rows.flatMap((r) => r.actions.filter((a) => a.kind === "look_again" && a.state === "staged").map((a) => ({ a, row: r })));
  const gate = cp.gate;
  const closed = gate && !gate.open ? gate : null;
  const message = closed ? `${plural(closed.blocking_open + closed.file_problems, "blocking problem")} left: fix or waive them, or send back to the agents` : null;
  const approveLabel = view.run.flow === "baseline" ? "Approve baseline" : "Approve and continue";
  const saveNote = () =>
    note !== (cp.note ?? "")
      ? unwrap(api.PUT("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/note", { ...path, body: { note: note.trim() ? note : null } }))
      : Promise.resolve(null);
  const decide = (decision: "approved" | "changes_requested") =>
    act(async () => {
      await saveNote();
      await unwrap(api.POST("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/decide", { ...path, body: { decision } }));
      return decision === "approved" ? "Approved: the run goes on." : "Sent back to the agents.";
    });
  return (
    <div
      role="region"
      aria-label="Decide: Confirm the baseline"
      data-testid="from-run-bar"
      className="fixed inset-x-0 bottom-0 z-20 flex flex-wrap items-center gap-2 border-t border-line bg-surface px-4 py-3 shadow-lg md:left-auto md:w-[min(100%,56rem)]"
    >
      <span className="font-medium" data-testid="bar-tally">
        {s.items - s.need_you} of {s.items} handled · {s.not_decided} not decided
      </span>
      <div className={`${sheet ? "flex" : "hidden md:flex"} w-full flex-wrap items-center gap-2 md:w-auto md:flex-1`}>
        {looks.map(({ a, row }) => (
          <Chip key={a.id} kind="acc" data-testid="bar-look-again">
            Look again: {row.entity.title}
            <button
              type="button"
              aria-label={`Remove look again on ${row.entity.title}`}
              className="ml-1"
              onClick={() =>
                void act(async () => {
                  await unwrap(
                    api.DELETE("/v1/runs/{run_id}/checkpoints/{checkpoint_id}/actions/{action_id}", {
                      params: { path: { run_id: view.run.id, checkpoint_id: cp.id, action_id: a.id } },
                    }),
                  );
                  return "Look again removed.";
                })
              }
            >
              ×
            </button>
          </Chip>
        ))}
        <input
          aria-label="Note to the agents (optional)"
          placeholder="Note to the agents (optional)"
          className={`${INPUT} min-w-0 flex-1`}
          value={note}
          onChange={(x) => setNote(x.target.value)}
          onBlur={() => void saveNote()}
        />
        <Button disabled={busy || (!looks.length && !note.trim())} onClick={() => void decide("changes_requested")}>
          Send back to agents
        </Button>
      </div>
      <Button className="md:hidden" variant="ghost" aria-expanded={sheet} onClick={() => setSheet(!sheet)}>
        Send back…
      </Button>
      <Button variant="primary" disabled={busy || !!closed} title={message ?? undefined} onClick={() => void decide("approved")}>
        {approveLabel}
      </Button>
      {closed && (
        <p className="w-full text-sm text-crit" data-testid="bar-gate">
          {message}. Left: {closed.left.map((x) => `${x.label} · ${x.item_title ?? x.item}`).join(", ")}
        </p>
      )}
    </div>
  );
}
