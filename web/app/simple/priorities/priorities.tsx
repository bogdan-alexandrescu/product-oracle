"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

import { Button, Sheet, toast } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { useSetParams } from "@/lib/use-set-params";
import { errorMessage, useQuery } from "@/lib/use-query";

type Out = Schemas["SimplePrioritiesOut"];
type Row = Schemas["SimplePriorityRow"];
type Proposal = Schemas["SimplePriorityProposal"];
type Draft = Schemas["SimplePriorityDraft"];
type Bucket = Schemas["SimpleGoalBucket"];
type ChangeIn = Schemas["SimpleChangeIn"];
type Tab = "ranked" | "value-effort" | "buckets";

const TABS: { key: Tab; label: string }[] = [
  { key: "ranked", label: "Ranked list" },
  { key: "value-effort", label: "Value / effort" },
  { key: "buckets", label: "Goal buckets" },
];
/** Shapes by goal (never colour alone), in the order the goals first rank. */
const SHAPES = ["circle", "square", "triangle", "diamond", "pentagon"] as const;
type Shape = (typeof SHAPES)[number] | "cross";

/** Whether the screen is a phone's (under 640 px). */
function usePhone(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const q = window.matchMedia("(max-width: 639px)");
    const on = () => setPhone(q.matches);
    on();
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return phone;
}

const fmt = (n: number | null | undefined, digits = 1): string => (n == null ? "–" : Number(n.toFixed(digits)).toString());

type Sent = { ok: true; change: Schemas["SimpleChangeOut"] } | { ok: false; status: number; message: string; pushback: boolean };

/** POST /v1/simple/changes; a refusal comes back with its words (409 Oracle's pushback included). */
/** The API's reason for a refusal: its detail, or its detail's message. */
function detailMessage(error: unknown, response: Response): string {
  const detail = (error as { detail?: unknown } | undefined)?.detail;
  return typeof detail === "string" ? detail : detail && typeof detail === "object" && "message" in detail ? String((detail as { message: unknown }).message) : response.statusText;
}

async function send(body: ChangeIn): Promise<Sent> {
  try {
    const { data, error, response } = await api.POST("/v1/simple/changes", { body });
    if (response.ok && data) return { ok: true, change: data.change };
    const detail = (error as { detail?: unknown } | undefined)?.detail;
    const pushback = !!detail && typeof detail === "object" && "pushback" in detail;
    return { ok: false, status: response.status, message: detailMessage(error, response), pushback };
  } catch (e) {
    return { ok: false, status: 0, message: errorMessage(e), pushback: false };
  }
}

export function Priorities() {
  const params = useSearchParams();
  const setParams = useSetParams();
  const phone = usePhone();
  const { can, capsReady } = useMe();
  const tab = (TABS.find((t) => t.key === params.get("tab"))?.key ?? "ranked") as Tab;
  const compare = params.get("compare") === "1";
  const q = useQuery<Out>("simple-priorities", () => unwrap(api.GET("/v1/simple/priorities")), { keepPrevious: true });
  const data = q.data;
  // Roles through can() and the rows' own fields: the API says who applies and who proposes.
  const mayChange = capsReady && can("create_simple_change") && !!data?.can_change;

  async function changed(r: Sent, done: string, proposedTo: string): Promise<void> {
    if (!r.ok) {
      toast({ message: r.message });
      return;
    }
    await q.reload();
    const c = r.change;
    if (c.status === "applied")
      toast({
        message: done,
        action: c.can_undo
          ? {
              label: "Undo",
              onClick: async () => {
                const u = await api.POST("/v1/simple/changes/{change_id}/undo", { params: { path: { change_id: c.id } } });
                await q.reload();
                toast({ message: u.response.ok ? "Undone" : "Could not undo" });
              },
            }
          : undefined,
      });
    else toast({ message: `Proposed: waiting for ${proposedTo}` });
  }

  const shapes = goalShapes(data?.rows ?? []);

  return (
    <div data-mode="simple" className="mx-auto w-full max-w-6xl px-4 py-6 text-[length:var(--simple-text)] leading-[var(--simple-leading)] text-text" data-testid="simple-priorities">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[length:var(--simple-h1)] font-semibold leading-[var(--simple-h1-leading)]">Priorities</h1>
          <p className="text-text2" data-testid="prio-subtitle">
            By score, in dependency order: a feature never ranks above one it depends on.
            {data ? ` ${data.quarter.label}.` : ""}
          </p>
        </div>
        <Link href="/priorities" className="text-[length:var(--simple-small)] font-medium text-accent-ink underline">
          Open the detailed view
        </Link>
      </header>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Priorities views" className="flex max-w-full gap-1 overflow-x-auto rounded-[var(--simple-card-radius)] border border-line bg-surface p-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setParams({ tab: t.key === "ranked" ? null : t.key })}
              className={`whitespace-nowrap rounded-[10px] px-2.5 py-1.5 text-[length:var(--simple-small)] font-medium sm:px-3 ${tab === t.key ? "bg-accent text-on-accent" : "text-text2 hover:bg-surface2"}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === "ranked" && (
          <label className="flex cursor-pointer items-center gap-2 text-[length:var(--simple-small)]">
            <button
              role="switch"
              aria-checked={compare}
              aria-label="Compare with Oracle"
              onClick={() => setParams({ compare: compare ? null : "1" })}
              className={`relative h-6 w-11 rounded-full border border-line-strong ${compare ? "bg-accent" : "bg-surface2"}`}
            >
              <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-surface shadow transition-all ${compare ? "left-6" : "left-0.5"}`} />
            </button>
            <span aria-hidden>Compare with Oracle</span>
          </label>
        )}
      </div>

      {q.error && !data && <p role="alert" className="text-crit">{q.error}</p>}
      {!data && !q.error && <p className="text-text2">Loading priorities…</p>}
      {data && tab === "ranked" && (
        <Ranked data={data} phone={phone} compare={compare} mayChange={mayChange} changed={changed} />
      )}
      {data && tab === "value-effort" && <ValueEffort data={data} shapes={shapes} mayChange={mayChange} changed={changed} />}
      {data && tab === "buckets" && <Buckets data={data} />}
    </div>
  );
}

/** Each goal's shape (first ranked first); rows with no goal are crosses. */
function goalShapes(rows: Row[]): Map<string, Shape> {
  const out = new Map<string, Shape>();
  for (const r of rows) if (r.goal && !out.has(r.goal.key)) out.set(r.goal.key, SHAPES[out.size % SHAPES.length]);
  return out;
}

type Changed = (r: Sent, done: string, proposedTo: string) => Promise<void>;

// --------------------------------------------------------------------------- ranked list

function Ranked({ data, phone, compare, mayChange, changed }: { data: Out; phone: boolean; compare: boolean; mayChange: boolean; changed: Changed }) {
  const [side, setSide] = useState<"yours" | "oracle">("yours");
  const [move, setMove] = useState<{ row: Row; position: number } | null>(null);
  const list = <YourList data={data} mayChange={mayChange} onMove={(row, position) => setMove({ row, position })} changed={changed} />;
  return (
    <>
      {compare && phone && (
        <div role="radiogroup" aria-label="Which order" className="mb-3 flex gap-1 rounded-[var(--simple-card-radius)] border border-line bg-surface p-1">
          {(["yours", "oracle"] as const).map((s) => (
            <button key={s} role="radio" aria-checked={side === s} onClick={() => setSide(s)} className={`flex-1 rounded-[10px] px-3 py-1.5 text-[length:var(--simple-small)] ${side === s ? "bg-accent text-on-accent" : "text-text2"}`}>
              {s === "yours" ? "Yours" : "Oracle's"}
            </button>
          ))}
        </div>
      )}
      {compare && !phone ? (
        <div className="grid grid-cols-2 gap-4">
          <section aria-label="Your order">
            <h2 className="mb-2 text-[length:var(--simple-h2)] font-semibold leading-[var(--simple-h2-leading)]">Your order</h2>
            {list}
          </section>
          <OracleOrder rows={data.rows} />
        </div>
      ) : compare && side === "oracle" ? (
        <OracleOrder rows={data.rows} />
      ) : (
        list
      )}
      {data.drafts.length > 0 && <Drafts drafts={data.drafts} proposals={data.proposals} mayChange={mayChange} changed={changed} />}
      {move && (
        <MoveDialog
          move={move}
          onClose={() => setMove(null)}
          changed={async (r, done, to) => {
            setMove(null);
            await changed(r, done, to);
          }}
        />
      )}
    </>
  );
}

function YourList({ data, mayChange, onMove, changed }: { data: Out; mayChange: boolean; onMove: (row: Row, position: number) => void; changed: Changed }) {
  const rows = data.rows;
  const refs = useRef<(HTMLLIElement | null)[]>([]);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const maxValue = Math.max(1, ...rows.map((r) => r.goal_value ?? 0));

  function targetIndex(y: number): number {
    let to = 0;
    refs.current.forEach((el, i) => {
      if (!el) return;
      const box = el.getBoundingClientRect();
      if (y > box.top + box.height / 2) to = i;
    });
    return to;
  }

  function start(e: ReactPointerEvent, from: number) {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    setDrag({ from, to: from });
  }

  function end(e: ReactPointerEvent) {
    if (!drag) return;
    const to = targetIndex(e.clientY);
    setDrag(null);
    if (to !== drag.from) onMove(rows[drag.from], to + 1);
  }

  function key(e: KeyboardEvent, i: number) {
    if (e.key === "ArrowUp" && i > 0) {
      e.preventDefault();
      onMove(rows[i], i);
    } else if (e.key === "ArrowDown" && i < rows.length - 1) {
      e.preventDefault();
      onMove(rows[i], i + 2);
    }
  }

  return (
    <ol aria-label="Ranked list" className="flex flex-col gap-[var(--simple-gap)]">
      {rows.map((r, i) => {
        // Any of the feature's items (a proposal on its later item shows here too).
        const proposals = data.proposals.filter((p) => p.feature_id === r.feature_id && (p.op === "override_priority" || p.op === "estimate_feature"));
        const target = drag && drag.to === i && drag.from !== i;
        return (
          <li
            key={r.feature_id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            data-testid="prio-row"
            data-code={r.code}
            className={`rounded-[var(--simple-card-radius)] border bg-surface p-3 ${target ? "border-accent ring-2 ring-accent" : "border-line"} ${drag?.from === i ? "opacity-60" : ""}`}
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {mayChange && r.can_reorder && (
                <button
                  aria-label={`Drag ${r.code} to reorder`}
                  title="Drag to reorder (or use the arrow keys)"
                  className="cursor-grab touch-none rounded-md px-1 text-[length:var(--simple-h2)] leading-none text-text2 hover:bg-surface2"
                  onPointerDown={(e) => start(e, i)}
                  onPointerMove={(e) => drag && setDrag({ ...drag, to: targetIndex(e.clientY) })}
                  onPointerUp={end}
                  onPointerCancel={() => setDrag(null)}
                  onKeyDown={(e) => key(e, i)}
                >
                  <svg width="14" height="20" viewBox="0 0 14 20" aria-hidden fill="currentColor">
                    {[3, 10, 17].flatMap((y) => [4, 10].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.8" />))}
                  </svg>
                </button>
              )}
              <span className="w-8 text-right text-[length:var(--simple-lead)] font-semibold tabular-nums" data-testid="prio-rank">
                {r.rank}
              </span>
              {r.oracle_rank != null && r.oracle_rank !== r.rank && (
                <span
                  data-testid="prio-ghost"
                  title="Oracle's rank"
                  className="rounded-full border border-dashed border-[var(--simple-ghost)] px-2 text-[length:var(--simple-small)] text-text2"
                >
                  Oracle #{r.oracle_rank}
                </span>
              )}
              <span className="rounded-md bg-surface2 px-1.5 font-mono text-[length:var(--simple-small)]">{r.code}</span>
              <span className="min-w-[12rem] flex-1 font-medium">{r.title}</span>
              <span className="ml-auto flex flex-wrap items-center gap-x-3 text-[length:var(--simple-small)] text-text2">
                {r.no_goal ? (
                  <span className="rounded-full bg-warn-bg px-2 text-warn">No goal</span>
                ) : (
                  <span>{r.goal?.title}</span>
                )}
                {r.milestone && <span>Milestone {r.milestone}</span>}
                <span className="flex items-center gap-1" aria-label={`Goal value ${fmt(r.goal_value)}`}>
                  <span className="h-2 w-16 overflow-hidden rounded-full bg-surface2">
                    <span className="block h-full rounded-full bg-accent" style={{ width: `${((r.goal_value ?? 0) / maxValue) * 100}%` }} />
                  </span>
                  {fmt(r.goal_value)}
                </span>
                <span>{fmt(r.effort)} wk</span>
                <span className="font-semibold text-text" data-testid="prio-score">
                  {fmt(r.score, 2)}
                </span>
              </span>
            </div>
            {r.after && (
              <p className="mt-1 pl-12 text-[length:var(--simple-small)] text-text2" data-testid="prio-after">
                After {r.after.code}, which it needs.
              </p>
            )}
            {r.override && (
              <p className="mt-1 pl-12 text-[length:var(--simple-small)] text-text2" data-testid="prio-override">
                Moved by {r.override.by_name}: “{r.override.reason}”
              </p>
            )}
            {proposals.map((p) => (
              <ProposalCard key={p.change_id} p={p} changed={changed} />
            ))}
          </li>
        );
      })}
    </ol>
  );
}

function OracleOrder({ rows }: { rows: Row[] }) {
  const sorted = [...rows].sort((a, b) => (a.oracle_rank ?? 1e9) - (b.oracle_rank ?? 1e9));
  return (
    <section aria-label="Oracle's order">
      <h2 className="mb-2 text-[length:var(--simple-h2)] font-semibold leading-[var(--simple-h2-leading)]">Oracle&apos;s order</h2>
      <ol className="flex flex-col gap-[var(--simple-gap)]">
        {sorted.map((r) => (
          <li key={r.feature_id} data-testid="oracle-row" data-code={r.code} className="rounded-[var(--simple-card-radius)] border border-dashed border-line-strong bg-surface p-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className="w-8 text-right text-[length:var(--simple-lead)] font-semibold tabular-nums">{r.oracle_rank ?? "–"}</span>
              <span className="rounded-md bg-surface2 px-1.5 font-mono text-[length:var(--simple-small)]">{r.code}</span>
              <span className="flex-1 font-medium">{r.title}</span>
              <span className="text-[length:var(--simple-small)] text-text2">score {fmt(r.score, 2)}</span>
            </div>
            {r.oracle_rank !== r.rank && (
              <p className="mt-1 pl-12 text-[length:var(--simple-small)] text-text2" data-testid="oracle-why">
                {r.override
                  ? `Yours: #${r.rank}. ${r.override.by_name} moved it: “${r.override.reason}”`
                  : `Yours: #${r.rank}, moved by other people's moves.`}
              </p>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function MoveDialog({ move, onClose, changed }: { move: { row: Row; position: number }; onClose: () => void; changed: Changed }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [pushback, setPushback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { row, position } = move;
  const verb = row.applies ? "Move" : "Propose";

  async function submit(confirm = false) {
    if (!reason.trim()) return;
    setBusy(true);
    setError(null);
    const r = await send({
      op: "override_priority",
      target: { item_id: row.item_id },
      before: { override: row.before_override ?? null },
      after: { position, reason: reason.trim(), ...(confirm ? { confirm: true } : {}) },
      reason: reason.trim(),
    });
    setBusy(false);
    if (!r.ok && r.pushback) setPushback(r.message);
    else if (!r.ok) setError(r.message);
    else await changed(r, `Moved ${row.code} to rank ${position}`, "the decider");
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Why move ${row.code}`}
        className="w-full max-w-md rounded-[var(--simple-card-radius)] border border-line bg-surface p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[length:var(--simple-h2)] font-semibold leading-[var(--simple-h2-leading)]">
          {verb} {row.code} to rank {position}
        </h2>
        <p className="mb-2 text-[length:var(--simple-small)] text-text2">
          Oracle ranks it #{row.oracle_rank ?? row.rank}. A manual move is an override: say why in one line{row.applies ? "" : "; the decider accepts or declines it"}.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="block text-[length:var(--simple-small)] font-medium" htmlFor="prio-reason">
            Reason
          </label>
          <input
            id="prio-reason"
            autoFocus
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value.replace(/[\r\n]/g, " "))}
            className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 text-[length:var(--simple-small)]"
          />
          {pushback && (
            <div role="alert" className="mt-3 rounded-lg bg-warn-bg p-2 text-[length:var(--simple-small)] text-warn">
              Oracle disagrees: {pushback}
              <div className="mt-2">
                <Button type="button" onClick={() => void submit(true)} disabled={busy}>
                  Keep my order
                </Button>
              </div>
            </div>
          )}
          {error && (
            <p role="alert" className="mt-2 text-[length:var(--simple-small)] text-crit">
              {error}
            </p>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !reason.trim()}>
              {verb}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function proposalWords(p: Proposal): string {
  const a = p.after as Record<string, unknown>;
  if (p.op === "override_priority") {
    const o = (a.override ?? a) as { position?: number; reason?: string };
    return `${p.by_name} proposes rank ${o.position}: “${o.reason ?? p.reason ?? ""}”`;
  }
  if (p.op === "confirm_item") return `${p.by_name} proposes confirming it`;
  if (p.op === "cut") return `${p.by_name} proposes merging it: “${p.reason ?? ""}”`;
  const parts = [a.goal_value != null ? `goal value ${a.goal_value}` : null, a.effort != null ? `effort ${a.effort} wk` : null].filter(Boolean);
  return `${p.by_name} proposes ${parts.join(" and ")}`;
}

/** A proposal inline under its row: the flow thumbnail (or "No flow yet") widens the card in place; a phone opens a full-height sheet. */
function ProposalCard({ p, changed }: { p: Proposal; changed: Changed }) {
  const [open, setOpen] = useState(false);
  const phone = usePhone();
  const [busy, setBusy] = useState(false);

  async function decide(action: "accept" | "decline") {
    setBusy(true);
    const r = await api.POST(`/v1/simple/changes/{change_id}/${action}`, { params: { path: { change_id: p.change_id } }, body: {} });
    setBusy(false);
    await changed(
      r.response.ok && r.data
        ? { ok: true, change: { ...r.data.change, status: "applied", can_undo: false } }
        : { ok: false, status: r.response.status, message: `Could not decide: ${detailMessage(r.error, r.response)}`, pushback: false },
      action === "accept" ? `Accepted ${p.code}'s proposal` : `Declined ${p.code}'s proposal`,
      "",
    );
  }

  const flow = p.flow ? <FlowDetail flow={p.flow} /> : null;
  return (
    <div
      data-testid="prio-proposal"
      data-wide={open && !phone ? "true" : "false"}
      className={`mt-2 rounded-[var(--simple-card-radius)] border border-dashed border-accent bg-accent-soft p-3 text-[length:var(--simple-small)] transition-all ${open && !phone ? "ml-0" : "ml-12 max-w-xl"}`}
    >
      <div className="flex flex-wrap items-center gap-3">
        {p.flow ? (
          <button aria-label={`Open the flow for ${p.code}`} onClick={() => setOpen(!open)} className="rounded-md border border-line bg-surface p-1" data-testid="flow-thumb">
            <FlowThumb flow={p.flow} />
          </button>
        ) : (
          <span className="rounded-md border border-dashed border-line px-2 py-1 text-text2" data-testid="flow-none">
            No flow yet
          </span>
        )}
        <span className="flex-1">
          {proposalWords(p)} · waiting for {p.waiting_for.join(", ") || "the company's owners"}
        </span>
        {p.can_decide && (
          <span className="flex gap-2">
            <Button onClick={() => void decide("accept")} disabled={busy}>
              Accept
            </Button>
            <Button variant="secondary" onClick={() => void decide("decline")} disabled={busy}>
              Decline
            </Button>
          </span>
        )}
      </div>
      {open && !phone && flow}
      {phone && p.flow && (
        <Sheet open={open} title={p.flow.title} onClose={() => setOpen(false)} full testId="flow-sheet">
          {flow}
        </Sheet>
      )}
    </div>
  );
}

export function FlowThumb({ flow }: { flow: Schemas["SimpleFlow"] }) {
  return (
    <svg width="64" height="40" viewBox="0 0 64 40" aria-hidden className="text-text2">
      {flow.steps.slice(0, 4).map((_, i) => (
        <g key={i}>
          <rect x={2 + i * 16} y={12} width={11} height={16} rx={2} fill="none" stroke="currentColor" />
          {i > 0 && <line x1={i * 16 - 3} y1={20} x2={i * 16 + 2} y2={20} stroke="currentColor" />}
        </g>
      ))}
    </svg>
  );
}

export function FlowDetail({ flow }: { flow: Schemas["SimpleFlow"] }) {
  return (
    <div className="mt-3 grid gap-4 sm:grid-cols-2" data-testid="flow-detail">
      <div>
        <h3 className="font-semibold">User flow: {flow.title}</h3>
        <ol className="mt-1 list-decimal pl-5">
          {flow.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      </div>
      <div aria-label={`Wireframe of ${flow.screen.title}`} role="img">
        <h3 className="font-semibold">Screen: {flow.screen.title}</h3>
        <div className="mt-1 flex flex-col gap-1 rounded-lg border border-line-strong bg-surface p-2">
          {flow.screen.regions.map((r) => (
            <div key={r} className="rounded border border-dashed border-line-strong px-2 py-1 text-[length:var(--simple-small)] text-text2">
              {r}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Drafts({ drafts, proposals, mayChange, changed }: { drafts: Draft[]; proposals: Proposal[]; mayChange: boolean; changed: Changed }) {
  const [merging, setMerging] = useState<string | null>(null);
  const [into, setInto] = useState("");
  return (
    <section aria-label="Not ranked yet" className="mt-6">
      <h2 className="mb-2 text-[length:var(--simple-h2)] font-semibold leading-[var(--simple-h2-leading)]">Not ranked yet</h2>
      <ul className="flex flex-col gap-[var(--simple-gap)]">
        {drafts.map((d) => (
          <li key={d.item_id} data-testid="prio-draft" data-code={d.code} className="rounded-[var(--simple-card-radius)] border border-dashed border-line-strong bg-surface p-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className="rounded-full bg-na-bg px-2 text-[length:var(--simple-small)] text-na">Draft</span>
              <span className="rounded-md bg-surface2 px-1.5 font-mono text-[length:var(--simple-small)]">{d.code}</span>
              <span className="flex-1 font-medium">{d.title}</span>
              <span className="text-[length:var(--simple-small)] text-text2">{d.goal?.title ?? "No goal"}</span>
              {mayChange && (
                <span className="flex gap-2">
                  <Button
                    onClick={async () =>
                      changed(await send({ op: "confirm_item", target: { item_id: d.item_id }, before: { draft: true }, after: { draft: false } }), `Confirmed ${d.code}`, "the decider")
                    }
                  >
                    Confirm
                  </Button>
                  <Button variant="secondary" onClick={() => setMerging(merging === d.item_id ? null : d.item_id)}>
                    Merge
                  </Button>
                </span>
              )}
            </div>
            {merging === d.item_id && (
              <form
                className="mt-2 flex flex-wrap items-center gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const target = d.merge_into.find((m) => m.item_id === into);
                  if (!target) return;
                  setMerging(null);
                  await changed(
                    await send({ op: "cut", target: { item_id: d.item_id }, before: { cut: false }, after: { cut: true }, reason: `Merged into ${target.code}` }),
                    `Merged ${d.code} into ${target.code}`,
                    "the decider",
                  );
                }}
              >
                <label htmlFor={`merge-${d.item_id}`} className="text-[length:var(--simple-small)]">
                  Merge into
                </label>
                <select id={`merge-${d.item_id}`} value={into} onChange={(e) => setInto(e.target.value)} className="rounded-lg border border-line bg-bg px-2 py-1 text-[length:var(--simple-small)]">
                  <option value="">Choose an item…</option>
                  {d.merge_into.map((m) => (
                    <option key={m.item_id} value={m.item_id}>
                      {m.code} · {m.title}
                    </option>
                  ))}
                </select>
                <Button type="submit" disabled={!into}>
                  Merge
                </Button>
              </form>
            )}
            {/* A Confirm or Merge waiting for the decider. */}
            {proposals
              .filter((p) => p.item_id === d.item_id && (p.op === "confirm_item" || p.op === "cut"))
              .map((p) => (
                <ProposalCard key={p.change_id} p={p} changed={changed} />
              ))}
          </li>
        ))}
      </ul>
    </section>
  );
}

// --------------------------------------------------------------------------- value / effort

function ShapeMark({ shape, hollow, rank }: { shape: Shape; hollow: boolean; rank?: number }) {
  const fill = hollow ? "var(--surface)" : "var(--accent)";
  const text = hollow ? "var(--text)" : "var(--on-accent)";
  const common = { fill, stroke: "var(--accent)", strokeWidth: 2 };
  const path: Record<Shape, React.ReactNode> = {
    circle: <circle cx="16" cy="16" r="13" {...common} />,
    square: <rect x="4" y="4" width="24" height="24" rx="2" {...common} />,
    triangle: <polygon points="16,2 30,28 2,28" {...common} />,
    diamond: <polygon points="16,1 31,16 16,31 1,16" {...common} />,
    pentagon: <polygon points="16,2 30,12 25,29 7,29 2,12" {...common} />,
    cross: <polygon points="11,2 21,2 21,11 30,11 30,21 21,21 21,30 11,30 11,21 2,21 2,11 11,11" {...common} />,
  };
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden>
      {path[shape]}
      {rank != null && (
        <text x="16" y={shape === "triangle" ? 23 : 20.5} textAnchor="middle" fontSize="12" fontWeight="700" fill={text}>
          {rank}
        </text>
      )}
    </svg>
  );
}

function ValueEffort({ data, shapes, mayChange, changed }: { data: Out; shapes: Map<string, Shape>; mayChange: boolean; changed: Changed }) {
  const box = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ code: string; x0: number; y0: number; dx: number; dy: number } | null>(null);
  const rows = data.rows;
  const maxE = Math.max(4, ...rows.map((r) => (r.effort ?? 0) * 1.25));
  const maxV = Math.max(4, ...rows.map((r) => (r.goal_value ?? 0) * 1.25));
  const shapeOf = (r: Row): Shape => (r.goal ? (shapes.get(r.goal.key) ?? "circle") : "cross");

  async function estimate(r: Row, after: { goal_value?: number; effort?: number }) {
    const words = after.effort != null ? `effort ${after.effort} wk` : `goal value ${after.goal_value}`;
    await changed(
      await send({
        op: "estimate_feature",
        target: { item_id: r.item_id },
        before: { goal_value: r.value_estimated ? (r.goal_value ?? null) : null, effort: r.effort ?? null },
        after,
      }),
      `Re-estimated ${r.code}: ${words}`,
      "the decider",
    );
  }

  function drop(r: Row) {
    if (!drag || !box.current) return;
    const { width, height } = box.current.getBoundingClientRect();
    const { dx, dy } = drag;
    setDrag(null);
    const round = (n: number) => Math.max(0.5, Math.round(n * 2) / 2);
    if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
    // Sideways changes effort, up/down goal value.
    if (Math.abs(dx) >= Math.abs(dy)) void estimate(r, { effort: round((r.effort ?? 0) + (dx / (width * 0.92)) * maxE) });
    else void estimate(r, { goal_value: round((r.goal_value ?? 0) - (dy / (height * 0.92)) * maxV) });
  }

  function key(e: KeyboardEvent, r: Row) {
    if (!mayChange || !r.can_reorder) return;
    const step = 0.5;
    const map: Record<string, { goal_value?: number; effort?: number }> = {
      ArrowRight: { effort: (r.effort ?? 0) + step },
      ArrowLeft: { effort: Math.max(step, (r.effort ?? 0) - step) },
      ArrowUp: { goal_value: (r.goal_value ?? 0) + step },
      ArrowDown: { goal_value: Math.max(step, (r.goal_value ?? 0) - step) },
    };
    if (map[e.key]) {
      e.preventDefault();
      void estimate(r, map[e.key]);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <section aria-label="Value / effort">
        <div className="flex">
          <div className="flex w-6 items-center justify-center">
            <span className="-rotate-90 whitespace-nowrap text-[length:var(--simple-small)] text-text2">Goal value ↑</span>
          </div>
          <div ref={box} data-testid="vxe-plot" className="relative aspect-[4/3] flex-1 touch-none rounded-[var(--simple-card-radius)] border border-line bg-surface">
            <div className="pointer-events-none absolute inset-0 grid grid-cols-2 grid-rows-2 text-[length:var(--simple-small)] text-text-faint">
              <span className="border-b border-r border-dashed border-line p-2">Quick wins</span>
              <span className="border-b border-dashed border-line p-2 text-right">Big bets</span>
              <span className="border-r border-dashed border-line p-2">Fill-ins</span>
              <span className="p-2 text-right">Later</span>
            </div>
            {rows.map((r, n) => {
              const d = drag?.code === r.code ? drag : null;
              // Marks on the same spot fan out sideways so each stays visible.
              const twins = rows.slice(0, n).filter((x) => x.effort === r.effort && x.goal_value === r.goal_value).length;
              const left = `calc(${4 + ((r.effort ?? 0) / maxE) * 92}% + ${(d?.dx ?? 0) + twins * 34}px)`;
              const top = `calc(${4 + (1 - (r.goal_value ?? 0) / maxV) * 92}% + ${d?.dy ?? 0}px)`;
              return (
                <button
                  key={r.feature_id}
                  data-testid="vxe-point"
                  data-code={r.code}
                  aria-label={`#${r.rank} ${r.code}: goal value ${fmt(r.goal_value)}, effort ${fmt(r.effort)} weeks${r.above_line ? "" : ", below the line"}`}
                  className={`absolute -translate-x-1/2 -translate-y-1/2 ${mayChange && r.can_reorder ? "cursor-grab" : "cursor-default"}`}
                  style={{ left, top }}
                  onPointerDown={(e) => {
                    if (!mayChange || !r.can_reorder) return;
                    e.preventDefault();
                    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                    setDrag({ code: r.code, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0 });
                  }}
                  onPointerMove={(e) => drag?.code === r.code && setDrag({ ...drag, dx: e.clientX - drag.x0, dy: e.clientY - drag.y0 })}
                  onPointerUp={() => drop(r)}
                  onPointerCancel={() => setDrag(null)}
                  onKeyDown={(e) => key(e, r)}
                >
                  <ShapeMark shape={shapeOf(r)} hollow={!r.above_line} rank={r.rank} />
                </button>
              );
            })}
          </div>
        </div>
        <p className="mt-1 pl-6 text-center text-[length:var(--simple-small)] text-text2">Effort (weeks) →</p>
        <ul className="mt-2 flex flex-wrap gap-4 pl-6 text-[length:var(--simple-small)] text-text2" aria-label="Legend">
          {[...shapes.entries()].map(([k, s]) => (
            <li key={k} className="flex items-center gap-1">
              <ShapeMark shape={s} hollow={false} />
              {rows.find((r) => r.goal?.key === k)?.goal?.title}
            </li>
          ))}
          {rows.some((r) => r.no_goal) && (
            <li className="flex items-center gap-1">
              <ShapeMark shape="cross" hollow={false} />
              No goal
            </li>
          )}
          <li>Numbers are ranks; hollow is below the line (not this quarter).</li>
        </ul>
        {mayChange && <p className="mt-1 pl-6 text-[length:var(--simple-small)] text-text-faint">Drag a mark sideways to change its effort, up or down to change its goal value (or use the arrow keys).</p>}
      </section>
      <section aria-label="Ranked side list">
        <h2 className="mb-2 text-[length:var(--simple-h2)] font-semibold leading-[var(--simple-h2-leading)]">Ranked</h2>
        <ol className="flex flex-col gap-1">
          {rows.map((r) => (
            <li key={r.feature_id} data-testid="side-row" data-code={r.code} className="flex items-center gap-2 rounded-lg border border-line bg-surface px-2 py-1 text-[length:var(--simple-small)]">
              <span className="w-6 text-right font-semibold tabular-nums">{r.rank}</span>
              <span className="font-mono text-[length:var(--simple-small)]">{r.code}</span>
              <span className="min-w-0 flex-1 truncate">{r.title}</span>
              <span className="tabular-nums text-text2">{fmt(r.score, 2)}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

// --------------------------------------------------------------------------- goal buckets

function Buckets({ data }: { data: Out }) {
  const buckets: Bucket[] = data.buckets;
  return (
    <section aria-label="Goal buckets">
      <p className="mb-3 text-text2">
        Share of {data.quarter.label}&apos;s plan per confirmed goal, by engineer-weeks ({fmt(data.weeks_total)} wk in all).
      </p>
      <div className="hidden overflow-hidden rounded-[var(--simple-card-radius)] border border-line sm:flex" data-testid="bucket-bar" aria-hidden>
        {buckets
          .filter((b) => b.weeks > 0)
          .map((b) => (
            <div key={b.key} style={{ width: `${b.share * 100}%` }} className={`min-h-12 border-r border-surface p-2 text-[length:var(--simple-small)] ${b.no_goal ? "bg-warn-bg text-warn" : "bg-accent-soft text-accent-ink"}`}>
              {b.title}
            </div>
          ))}
      </div>
      <ul className="mt-3 grid gap-[var(--simple-gap)] sm:grid-cols-2">
        {buckets.map((b) => (
          <li key={b.key} data-testid="goal-bucket" data-key={b.key} className={`rounded-[var(--simple-card-radius)] border bg-surface p-3 ${b.no_goal ? "border-warn" : "border-line"}`}>
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="font-semibold">{b.title}</h3>
              <span className="tabular-nums">
                {fmt(b.weeks)} wk · {Math.round(b.share * 100)}%
              </span>
            </div>
            <div className="mt-2 h-3 overflow-hidden rounded-full bg-surface2">
              <div className={`h-full ${b.no_goal ? "bg-warn" : "bg-accent"}`} style={{ width: `${b.share * 100}%` }} />
            </div>
            {b.no_goal && <p className="mt-1 text-[length:var(--simple-small)] text-warn">⚠ Serves no confirmed goal</p>}
            <p className="mt-1 text-[length:var(--simple-small)] text-text2">{b.codes.length ? b.codes.join(", ") : "Nothing this quarter"}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
