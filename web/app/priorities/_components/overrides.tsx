"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Button, Chip, InspectorSection, Notice, Panel, Sheet } from "@/components/ds";
import { INPUT } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { errorMessage, useQuery } from "@/lib/use-query";

import { dayText, evidenceName, sourceName } from "./words";

type RankedFeature = Schemas["RankedFeature"];
type OverrideOut = Schemas["OverrideOut"];
type PushbackOut = Schemas["PushbackOut"];
type Kind = OverrideOut["kind"];

/** The most evidence a person may cite for one change. */
export const MAX_CITED = 5;
export const NUMBERS_ONLY = "Oracle checked the numbers only this time.";
const CHECKED = new Set(["contradiction", "no_contradiction"]);

/**
 * What a change asks for: a move above `above`, or a pin at `position`. `below` is the row ▼
 * steps past: the dialog says "Move below <it>" (the move itself is above the row after it).
 */
export type Draft = {
  feature: RankedFeature;
  kind: Kind;
  above: RankedFeature | null;
  position: number | null;
  reason?: string;
  below?: RankedFeature | null;
};

/** A radio group drawn as B1's segmented control (the ranking method, the order, the log filter). */
export function RadioSwitch<V extends string>({
  label,
  items,
  value,
  onChange,
  testIdPrefix,
}: {
  label: string;
  items: { value: V; label: string }[];
  value: V;
  onChange: (v: V) => void;
  testIdPrefix?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent) => {
    if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(e.key)) return;
    e.preventDefault();
    const at = items.findIndex((m) => m.value === value);
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
    const next = items[(at + step + items.length) % items.length]!;
    onChange(next.value);
    ref.current?.querySelector<HTMLElement>(`[data-value="${next.value}"]`)?.focus();
  };
  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKey}
      className="inline-flex max-w-full flex-none overflow-x-auto rounded-button border border-line-strong bg-surface"
    >
      {items.map((m) => {
        const on = value === m.value;
        return (
          <button
            key={m.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            data-value={m.value}
            data-testid={testIdPrefix ? `${testIdPrefix}-${m.value}` : undefined}
            onClick={() => onChange(m.value)}
            className={`flex h-9 items-center border-r border-line px-3.5 text-[15px] font-medium whitespace-nowrap last:border-r-0 max-[600px]:px-2.5 max-[600px]:text-sm ${
              on ? "bg-accent text-on-accent" : "text-text hover:bg-surface2"
            }`}
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}

const pct = (n: number | null | undefined) => (n == null ? "—" : `${Math.round(n * 100)}%`);

/** A cited piece of evidence: title, kind of source, date, confidence (as CitationChip shows them). */
export function EvidenceChip({ e }: { e: Schemas["EvidenceChip"] }) {
  const title = evidenceName(e);
  const kind = sourceName(e.source_kind);
  const date = dayText(e.date);
  return (
    <span
      data-testid="evidence-chip"
      title={[title, kind, date].filter(Boolean).join(" · ")}
      className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-goal border border-line px-2 py-0.5 text-[13px]"
    >
      <span className="min-w-0 truncate font-medium">{title}</span>
      {kind && <span className="flex-none text-text2">{kind}</span>}
      {date && <span className="tnum flex-none text-text2">{date}</span>}
      <span className="tnum flex-none" title="Confidence">
        {pct(e.confidence)}
      </span>
    </span>
  );
}

/** A feature key as its name, where the caller knows the ranking. */
export type NameOf = (key: string) => string;

/**
 * Words for a change: "Moved above Saved addresses" / "Pinned at #1". The feature it moved
 * above by its name: the API's own title for it (the object form's `title`) over a lookup by key, which only works while the key is still in the
 * ranking shown; either way, never the bare key.
 */
export function changeLabel(
  o: {
    kind: Kind;
    above?: { key: string; title?: string } | string | null;
    position?: number | null;
  },
  name?: NameOf,
): string {
  const key = typeof o.above === "string" ? o.above : o.above?.key;
  const own = typeof o.above === "object" ? o.above?.title : undefined;
  const above = key ? (own ?? name?.(key) ?? key) : null;
  return o.kind === "move" ? `Moved above ${above ?? "—"}` : `Pinned at #${o.position}`;
}

/** The chips on an overridden or held row. */
export function RowChips({ f, name }: { f: RankedFeature; name: NameOf }) {
  const o = f.override;
  return (
    <>
      {o && (
        <Chip kind="acc" wrap title={o.reason} data-testid="override-chip">
          {o.kind === "move" ? `Moved by ${o.by}` : `Pinned #${o.position} by ${o.by}`}
        </Chip>
      )}
      {f.held_below && (
        <Chip kind="warn" wrap title={`Held below ${name(f.held_below)}: it depends on it`} data-testid="held-chip">
          Held below {name(f.held_below)}
        </Chip>
      )}
    </>
  );
}

/**
 * ▲ ▼ and ⋯ on a row (approvers and owners), on every row so touch users find them
 * (qa-plan-19). ▼ moves a feature below the next one, in the Move dialog (qa-plan-6,
 * qa-plan-15); a button that cannot act says why.
 */
export function RowActions({
  f,
  index,
  features,
  onDraft,
  onRemove,
}: {
  f: RankedFeature;
  index: number;
  features: RankedFeature[];
  onDraft: (d: Draft) => void;
  onRemove: (overrideId: string) => void;
}) {
  const [menu, setMenu] = useState<{ top: number; right: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e instanceof globalThis.KeyboardEvent && e.key !== "Escape") return;
      if (
        e.type === "pointerdown" &&
        (box.current?.contains(e.target as Node) || list.current?.contains(e.target as Node))
      )
        return;
      setMenu(null);
    };
    const away = () => setMenu(null);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", away);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
      window.removeEventListener("scroll", away, true);
      window.removeEventListener("resize", away);
    };
  }, [menu]);
  const prev = features[index - 1];
  const next = features[index + 1];
  // ▼ moves it below the next row: a move above the row after that. A change can only put a
  // feature above another, so the second-to-last row has no ▼ (a pin at the bottom does it).
  const twoBelow = features[index + 2];
  const down: Draft | null = next && twoBelow ? { feature: f, kind: "move", above: twoBelow, below: next, position: null } : null;
  const upWhy = prev ? null : "Already first";
  const downWhy = down
    ? null
    : !next
      ? "Already last"
      : `${next.title} is last: pin at #${features.length} from More actions`;
  const btn =
    "grid size-7 min-h-6 min-w-6 place-items-center rounded-button text-text2 hover:bg-surface2 hover:text-text disabled:opacity-40 aria-disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:hover:bg-transparent max-[600px]:size-11 max-[600px]:min-h-11 max-[600px]:min-w-11";
  return (
    <div
      ref={box}
      data-testid="row-actions"
      className="flex items-center justify-end gap-0.5"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className={btn}
        aria-label="Move up"
        title={upWhy ?? `Move ${f.title} above ${prev!.title}`}
        aria-disabled={!prev || undefined}
        onClick={() => prev && onDraft({ feature: f, kind: "move", above: prev, position: null })}
      >
        ▲
      </button>
      <button
        type="button"
        className={btn}
        aria-label="Move down"
        title={downWhy ?? `Move ${f.title} below ${next!.title}`}
        aria-disabled={!down || undefined}
        onClick={() => {
          if (down) onDraft(down);
        }}
      >
        ▼
      </button>
      <button
        type="button"
        className={btn}
        aria-label="More actions"
        title={`More for ${f.title}`}
        aria-haspopup="menu"
        aria-expanded={!!menu}
        onClick={(e) => {
          // Fixed to the viewport: the table's cells clip what overflows them.
          const r = e.currentTarget.getBoundingClientRect();
          setMenu((m) => (m ? null : { top: r.bottom + 4, right: window.innerWidth - r.right }));
        }}
      >
        ⋯
      </button>
      {menu &&
        createPortal(
          <div
            ref={list}
            role="menu"
            aria-label={`Change ${f.title}`}
            style={{ top: menu.top, right: menu.right }}
            className="fixed z-40 flex w-48 flex-col rounded-button border border-line bg-surface py-1 shadow-tip"
          >
            <MenuItem
              onClick={() => {
                setMenu(null);
                onDraft({
                  feature: f,
                  kind: "move",
                  above: null,
                  position: null,
                });
              }}
            >
              Move above…
            </MenuItem>
            <MenuItem
              onClick={() => {
                setMenu(null);
                onDraft({
                  feature: f,
                  kind: "pin",
                  above: null,
                  position: null,
                });
              }}
            >
              Pin at…
            </MenuItem>
            {f.override && (
              <MenuItem
                onClick={() => {
                  setMenu(null);
                  onRemove(f.override!.id);
                }}
              >
                Remove my change
              </MenuItem>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}

function MenuItem({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="min-h-10 px-3 text-left text-[15px] hover:bg-surface2"
    >
      {children}
    </button>
  );
}

function PushbackView({ p, name }: { p: PushbackOut; name: NameOf }) {
  const rules = p.pushback.filter((m) => m.code !== "reason_contradicts_evidence");
  const reason = p.pushback.find((m) => m.code === "reason_contradicts_evidence");
  return (
    <div className="flex flex-col gap-3" data-testid="pushback">
      <h3 className="font-display text-lg font-bold tracking-heading">Oracle disagrees</h3>
      {rules.length > 0 && (
        <ul className="flex flex-col gap-2">
          {rules.map((m) => (
            <li key={m.code} data-testid={`pushback-${m.code}`} className="rounded-button border border-line px-3 py-2">
              {/* The message gives the numbers in words; the raw figures stay out of the view. */}
              <p>{m.message}</p>
            </li>
          ))}
        </ul>
      )}
      {reason && (
        <section data-testid="pushback-reason" className="rounded-button border border-line px-3 py-2">
          <h4 className="text-[13px] font-semibold text-text2">About your reason</h4>
          <p className="mt-1">{reason.message}</p>
          {reason.evidence && reason.evidence.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {reason.evidence.map((e) => (
                <EvidenceChip key={e.id} e={e} />
              ))}
            </div>
          )}
        </section>
      )}
      {!CHECKED.has(p.reason_check.status) && <p className="text-sm text-text2">{NUMBERS_ONLY}</p>}
      {p.held_below && <p className="text-sm text-text2">Held below {name(p.held_below)}: it depends on it.</p>}
    </div>
  );
}

/**
 * The sheet a move or pin is made in: the target, Why? (required), the evidence the person
 * cites, then Save. Oracle's pushback replaces the body: Keep my change or Take Oracle's advice.
 */
export function OverrideSheet({
  draft,
  features,
  onClose,
  onStored,
}: {
  draft: Draft;
  features: RankedFeature[];
  onClose: () => void;
  onStored: (o: OverrideOut) => void;
}) {
  const f = draft.feature;
  const [above, setAbove] = useState<RankedFeature | null>(draft.above);
  const [position, setPosition] = useState<string>(draft.position ? String(draft.position) : "");
  const [find, setFind] = useState("");
  const [reason, setReason] = useState(draft.reason ?? "");
  const [cited, setCited] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pushback, setPushback] = useState<PushbackOut | null>(null);
  const evidence = f.explanation.confidence.evidence;
  const rank = Number(position);
  const ready =
    reason.trim().length > 0 &&
    reason.length <= 500 &&
    (draft.kind === "move" ? !!above : Number.isInteger(rank) && rank >= 1);

  async function save(confirm: boolean) {
    setBusy(true);
    setError(null);
    try {
      const {
        data,
        error: err,
        response,
      } = await api.POST("/v1/priorities/overrides", {
        body: {
          feature_id: f.entity_id,
          kind: draft.kind,
          above_feature_id: draft.kind === "move" ? (above?.entity_id ?? null) : null,
          position: draft.kind === "pin" ? rank : null,
          reason: reason.trim(),
          evidence_ids: cited,
          confirm,
        },
      });
      if (response.status === 409 && err && typeof err === "object" && "pushback" in err) {
        setPushback(err as PushbackOut);
        return;
      }
      if (!response.ok || !data) {
        await unwrap(Promise.resolve({ data, error: err, response }));
        return;
      }
      onStored(data);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const choices = features.filter(
    (x) => x.key !== f.key && `${x.key} ${x.title}`.toLowerCase().includes(find.trim().toLowerCase()),
  );
  const title = draft.kind === "move" ? `Move ${f.title}` : `Pin ${f.title}`;

  return (
    <Sheet open title={title} onClose={onClose} testId="override-sheet">
      <div className="mx-auto flex w-full max-w-[640px] flex-col gap-3 px-4 py-3 text-[15px]">
        {pushback ? (
          <>
            <PushbackView p={pushback} name={(k) => features.find((x) => x.key === k)?.title ?? k} />
            {error && <Notice tone="error">{error}</Notice>}
            <div className="flex flex-wrap justify-end gap-2 pb-2">
              <Button variant="ghost" onClick={onClose}>
                Take Oracle&apos;s advice
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => void save(true)}>
                Keep my change
              </Button>
            </div>
          </>
        ) : (
          <>
            {draft.kind === "move" ? (
              <div className="flex flex-col gap-2">
                <p className="font-semibold" data-testid="move-target">
                  {draft.below && above?.key === draft.above?.key
                    ? `Move below ${draft.below.title}`
                    : above
                      ? `Move above ${above.title}`
                      : "Move above…"}
                </p>
                {!draft.above && (
                  <>
                    <label className="flex flex-col gap-1">
                      <span className="text-[13px] font-semibold text-text2">Find a feature</span>
                      <input className={INPUT} value={find} onChange={(e) => setFind(e.target.value)} />
                    </label>
                    <ul
                      aria-label="Features"
                      className="flex max-h-48 flex-col overflow-y-auto rounded-button border border-line"
                    >
                      {choices.map((x) => (
                        <li key={x.key}>
                          <button
                            type="button"
                            aria-pressed={above?.key === x.key}
                            onClick={() => setAbove(x)}
                            className={`flex min-h-10 w-full items-center gap-2 px-3 text-left hover:bg-surface2 ${above?.key === x.key ? "bg-accent-bg font-semibold" : ""}`}
                          >
                            <span className="tnum w-8 flex-none text-text2">#{x.rank}</span>
                            <span className="min-w-0 truncate">{x.title}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            ) : (
              <label className="flex flex-col gap-1">
                <span className="text-[13px] font-semibold text-text2">Rank</span>
                <input
                  type="number"
                  min={1}
                  max={features.length}
                  className={`${INPUT} max-w-32`}
                  value={position}
                  onChange={(e) => setPosition(e.target.value)}
                />
              </label>
            )}
            <label className="flex flex-col gap-1">
              <span className="text-[13px] font-semibold text-text2">Why?</span>
              <textarea
                className={INPUT}
                rows={3}
                maxLength={500}
                required
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                data-autofocus
              />
            </label>
            {evidence.length > 0 && (
              <fieldset className="flex flex-col gap-1.5 rounded-button border border-line px-3 py-2">
                <legend className="px-1 text-[13px] font-semibold text-text2">Cite evidence (optional)</legend>
                {/* Never "0 of 5" over one item: how many may be picked, then how many are (qa-plan-16). */}
                <p className="tnum text-[13px] text-text2" data-testid="cited-count">
                  {cited.length === 0 ? `Pick up to ${MAX_CITED}` : `${cited.length} picked, up to ${MAX_CITED}`}
                </p>
                {evidence.map((e) => {
                  const on = cited.includes(e.id);
                  return (
                    <label key={e.id} className="flex min-w-0 items-center gap-2">
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={!on && cited.length >= MAX_CITED}
                        onChange={(ev) =>
                          setCited(ev.target.checked ? [...cited, e.id] : cited.filter((c) => c !== e.id))
                        }
                      />
                      <EvidenceChip
                        e={{
                          id: e.id,
                          title: evidenceName(e),
                          source_kind: e.source_kind ?? "link",
                          date: e.date ?? null,
                          confidence: e.confidence,
                        }}
                      />
                    </label>
                  );
                })}
              </fieldset>
            )}
            {error && <Notice tone="error">{error}</Notice>}
            <div className="flex justify-end gap-2 pb-2">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy || !ready} onClick={() => void save(false)}>
                {busy ? "Checking…" : "Save"}
              </Button>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}

/** Inspector section "Your change": the override that placed the row, and why. */
export function YourChange({
  f,
  o,
  canChange,
  onRemove,
  onMoveToo,
  name,
}: {
  f: RankedFeature;
  o: OverrideOut | undefined;
  canChange: boolean;
  onRemove: (id: string) => void;
  onMoveToo: (prerequisite: string) => void;
  name: NameOf;
}) {
  if (!f.override && !f.held_below) return null;
  return (
    <InspectorSection label="Your change">
      <div data-testid="your-change" className="flex flex-col gap-2 text-sm">
        {f.override && (
          <>
            <p className="flex flex-wrap items-center gap-1.5">
              <b>{changeLabel(f.override, name)}</b>
              {f.override.kept_after_pushback && <Chip kind="warn">kept after pushback</Chip>}
            </p>
            <p>“{f.override.reason}”</p>
            <p className="text-text2">
              {f.override.by}
              {f.override.created_at && <> · {formatDateTime(f.override.created_at)}</>}
            </p>
            {o && (
              <>
                {o.evidence && o.evidence.length > 0 && (
                  <ul data-testid="cited-evidence" aria-label="Cited evidence" className="flex flex-col gap-1">
                    {o.evidence.map((e) => (
                      <li key={e.id}>
                        <EvidenceChip e={e} />
                      </li>
                    ))}
                  </ul>
                )}
                {o.pushback.length > 0 && (
                  <ul aria-label="Oracle's pushback" className="flex flex-col gap-1 text-text2">
                    {o.pushback.map((m) => (
                      <li key={m.code}>{m.message}</li>
                    ))}
                  </ul>
                )}
                <p>
                  <Chip kind={CHECKED.has(o.reason_check.status) ? "pass" : "na"}>
                    {CHECKED.has(o.reason_check.status) ? "Reason checked by Oracle" : "Numbers only"}
                  </Chip>
                </p>
              </>
            )}
          </>
        )}
        {f.held_below && (
          <div className="flex flex-wrap items-center gap-2">
            <span>Held below {name(f.held_below)}: it depends on it</span>
            {canChange && f.override && (
              <Button variant="ghost" onClick={() => onMoveToo(f.held_below!)}>
                Move {name(f.held_below)} too
              </Button>
            )}
          </div>
        )}
        {canChange && f.override && (
          <div>
            <Button variant="ghost" icon="x" onClick={() => onRemove(f.override!.id)}>
              Remove my change
            </Button>
          </div>
        )}
      </div>
    </InspectorSection>
  );
}

/** Panel "Changes": the override log, newest first, active or all. */
export function ChangesPanel({
  reloadKey,
  features,
  canChange = false,
}: {
  reloadKey: number;
  features: RankedFeature[];
  /** Who can move and pin: the empty list says how (qa-plan-20). */
  canChange?: boolean;
}) {
  const [filter, setFilter] = useState<"active" | "all">("active");
  const q = useQuery(
    `priority-overrides|${filter}|${reloadKey}`,
    () =>
      unwrap(
        api.GET("/v1/priorities/overrides", {
          params: { query: { include_removed: filter === "all", limit: 200 } },
        }),
      ),
    { keepPrevious: true },
  );
  const title = (key: string, fallback: string) => features.find((f) => f.key === key)?.title ?? fallback;
  return (
    <Panel
      title="Changes"
      count={q.data?.length || undefined}
      tools={
        <RadioSwitch
          label="Changes filter"
          items={[
            { value: "active", label: "Active" },
            { value: "all", label: "All" },
          ]}
          value={filter}
          onChange={setFilter}
        />
      }
    >
      {q.error && (
        <div className="p-3">
          <Notice tone="error">{q.error}</Notice>
        </div>
      )}
      {q.data && q.data.length === 0 && (
        <p data-testid="changes-empty" className="px-4 py-6 text-center text-text2">
          {filter === "active" && canChange
            ? "No changes yet. Use ▲ ▼ or More actions on a row to move or pin a feature, with a reason."
            : "No changes yet."}
        </p>
      )}
      <ul data-testid="change-log">
        {(q.data ?? []).map((o) => (
          <li
            key={o.id}
            className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-4 py-1.5 first:border-t-0 max-[600px]:px-3"
          >
            <span className="font-medium">{title(o.feature.key, o.feature.title)}</span>
            <span className="text-text2">{changeLabel(o, (k) => title(k, k))}</span>
            <span className="min-w-0 [overflow-wrap:anywhere]">“{o.reason}”</span>
            <span className="text-text2">
              {o.created_by.name} · {formatDateTime(o.created_at)}
            </span>
            {o.kept_after_pushback && <Chip kind="warn">kept after pushback</Chip>}
            {o.no_longer_applies && <Chip kind="na">no longer applies</Chip>}
            {o.removed_at && (
              <Chip kind="na" title={o.removed_reason ?? undefined}>
                {o.replaced_by ? "replaced" : "removed"}
                {o.removed_by ? ` by ${o.removed_by.name}` : ""}
              </Chip>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
