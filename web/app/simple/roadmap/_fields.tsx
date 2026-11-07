"use client";
// one-feature-panel: every field of a feature, read and changed in place in its panel. Each
// save is one Simple change (Undo, the "changed by …" conflict rule; a commenter's is a
// suggestion for an approver). Without canChange (a viewer) the fields only read.

import { useState } from "react";

import { Icon } from "@/components/ds/Icon";

import { api, unwrap } from "@/lib/api/client";
import { calendarDay } from "@/lib/dates";
import { byPrdOrderOf, usePrdOrder } from "@/lib/prd-order";
import { useQuery } from "@/lib/use-query";

import type { Act } from "./_card";
import {
  confidenceWord,
  datesFrom,
  goalMilestoneWords,
  milestoneWords,
  partsWords,
  placeable,
  statusWord,
  yearSpan,
  type GoalMilestone,
  type Item,
} from "./_lib";

/** pre-demo QA P-8: on a phone (the sheet), a 44 px hit area; the desktop look is unchanged. */
const TAP = "max-sm:min-h-11 max-sm:min-w-11 max-sm:inline-flex max-sm:items-center max-sm:justify-center";
const LINK = `text-sm font-semibold text-accent-ink hover:underline ${TAP}`;
/** roadmap-edit-fixes round 1: a dependency's x, a 24 px target of its own (a bare 16 px icon on the line's baseline was missed). */
const REMOVE = "relative inline-flex h-6 w-6 flex-none items-center justify-center self-center rounded text-accent-ink hover:bg-surface2 max-sm:h-11 max-sm:w-11";
const INPUT =
  "w-full rounded-md border border-line bg-surface px-2 py-1 text-[15px]";

/** A feature's code chip, then its name: "F-12 Alert rules engine". */
export function Named({ item }: { item: Pick<Item, "code" | "title"> }) {
  return (
    <>
      {item.code && <span className="simple-code mr-1.5">{item.code}</span>}
      {item.title}
    </>
  );
}

/** "Mar 31, 2027": a goal's date, month first. */
const dayWords = (day: string) => calendarDay(day, { month: "short", day: "numeric", year: "numeric" });

/** "61%", "3 days": a goal's reading in its unit. */
const readingWords = (n: number, unit?: string | null) => `${n.toLocaleString("en-US")}${unit ? (unit === "%" ? "%" : ` ${unit}`) : ""}`;

/** One field: its value, and (canChange) a Change button that opens its editor in place. */
function Field({
  label,
  testId,
  value,
  canChange,
  editor,
}: {
  label: string;
  testId: string;
  value: React.ReactNode;
  canChange: boolean;
  editor: (done: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <dt className="text-text2">{label}</dt>
      <dd className="min-w-0 [overflow-wrap:anywhere]">
        {open ? (
          <div data-testid={`${testId}-edit`}>{editor(() => setOpen(false))}</div>
        ) : (
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span data-testid={testId} className="min-w-0">{value}</span>
            {canChange && (
              <button
                type="button"
                className={LINK}
                aria-label={`Change the ${label.toLowerCase()}`}
                onClick={() => setOpen(true)}
              >
                Change
              </button>
            )}
          </span>
        )}
      </dd>
    </>
  );
}

function SaveCancel({
  onCancel,
  disabled,
}: {
  onCancel: () => void;
  disabled?: boolean;
}) {
  return (
    <span className="mt-1 flex gap-3">
      <button
        type="submit"
        disabled={disabled}
        className="rounded-md bg-accent px-3 py-1 text-sm font-semibold text-white disabled:opacity-50"
      >
        Save
      </button>
      <button type="button" className={LINK} onClick={onCancel}>
        Cancel
      </button>
    </span>
  );
}

/** A select editor: the options, the current value, saved by `save`. */
function Pick({
  label,
  value,
  options,
  save,
  done,
  note,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  save: (v: string) => Promise<void>;
  done: () => void;
  /** What the picked value does beyond itself, shown before Save (panel-menu: a cut feature's parts). */
  note?: (v: string) => string | undefined;
}) {
  const [v, setV] = useState(value);
  const said = note?.(v);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        done();
        if (v !== value) void save(v);
      }}
    >
      <select
        aria-label={label}
        className={INPUT}
        value={v}
        onChange={(e) => setV(e.target.value)}
        autoFocus
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {said && (
        <p className="mt-1 text-sm text-text2" data-testid="pick-note">
          {said}
        </p>
      )}
      <SaveCancel onCancel={done} />
    </form>
  );
}

/** item-milestone: the Milestone picker's option for the milestone shown now when it was not picked there. */
const SHOWN = "shown";

/** The distinct refs (track, PRD, goal) the roadmap's items have: what an item may be moved to. */
function refs<T extends { id: string }>(
  items: Map<string, Item>,
  of: (i: Item) => T | null | undefined,
): T[] {
  const out = new Map<string, T>();
  for (const i of items.values()) {
    const r = of(i);
    if (r) out.set(r.id, r);
  }
  return [...out.values()];
}

/** Why the item has its dates, for the (i) beside them. */
function datesReason(item: Item): string {
  if (item.estimated)
    return `Oracle estimated these dates from the ${item.horizon} window and what the feature depends on. Set dates to override them.`;
  if (item.source === "typed")
    return "Someone set these dates here. They override Oracle's estimate and any date source.";
  return `${datesFrom(item)}. Set dates here to override them.`;
}

/** Which the dates are: set here, from a date source, or Oracle's estimate. */
function datesKind(item: Item): string {
  if (item.estimated) return "Oracle's estimate";
  if (item.source === "typed") return "Set here";
  return datesFrom(item);
}

/** item-milestone: the milestone a feature reads: the goal milestone picked for it, else its
 * PRD plan's (its slices'), else its own; "" with none. */
function milestoneShown(item: Item, milestones: readonly GoalMilestone[]): string {
  const picked = item.milestone?.id ? milestones.find((m) => m.id === item.milestone!.id) : undefined;
  if (picked) return goalMilestoneWords(picked, milestones);
  if (!item.milestone?.id && item.slices.length)
    return [...new Map(item.slices.map((x) => [x.milestone, `${x.milestone} ${x.milestone_name}`])).values()].join(", ");
  return item.milestone?.name ? milestoneWords(item.milestone.name) : "";
}

export function PanelFields({
  item,
  items,
  act,
  canChange,
  onOpen,
  milestones = [],
}: {
  item: Item;
  items: Map<string, Item>;
  act: Act;
  canChange: boolean;
  /** Opens another feature's own panel (a dependency, or one that needs this one). */
  onOpen?: (id: string) => void;
  /** item-milestone: the roadmap read's goal milestones (the item's roadmap's are offered). */
  milestones?: readonly GoalMilestone[];
}) {
  const [why, setWhy] = useState(false);
  const prdOrderOf = usePrdOrder();
  const shownMilestone = milestoneShown(item, milestones);
  const goal = item.goal;
  const people = useQuery(`people:panel:${canChange}`, () =>
    canChange
      ? unwrap(api.GET("/v1/people", { params: { query: { limit: 200 } } }))
      : Promise.resolve([]),
  );
  const target = { item_id: item.id };
  const change = (
    what: string,
    op: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    more?: Record<string, string>,
    note?: string,
  ) => act(what, { op: op as never, target: { ...target, ...more }, before, after }, note);
  // panel-menu: a feature with parts says, as it is cut or moved, that they stay as they are.
  const parts = (how: Parameters<typeof partsWords>[1]) => partsWords(item.parts.length, how) || undefined;
  const others = [...items.values()].filter(
    (i) => i.id !== item.id && i.status !== "merged",
  );
  const tracks = refs(items, (i) => i.track);
  // prd-order: the PRD picker in the company PRD order.
  const prds = refs(items, (i) => i.prd).sort(byPrdOrderOf(prdOrderOf));
  const goals = refs(items, (i) => i.goal);
  // roadmap-edit-fixes: the stored key the read says names it (another PRD's feature key is
  // neither its key nor its code), else the one matching its key or code.
  // roadmap-edit-fixes round 1: every stored key that names it (the read's, and its key or code
  // in any case), so a removal drops them all and none shows again as a loose chip.
  const keysOf = (dep: Item) => keysIn(item, dep);
  const shown = (id: string) => items.get(id);
  const featureButton = (i: Item) =>
    onOpen ? (
      <button
        type="button"
        className="text-left text-accent-ink hover:underline"
        onClick={() => onOpen(i.id)}
      >
        <Named item={i} />
      </button>
    ) : (
      <Named item={i} />
    );
  const deps = item.depends_on.map(shown).filter((i): i is Item => !!i);
  // A key the dependency checks did not match here (another PRD's feature key): the item the
  // roadmap read has under that key or code, else the key as typed.
  const loose = item.depends_keys
    .filter((k) => !deps.some((d) => keysOf(d).has(k)))
    .map((k) => ({
      k,
      found: others.find(
        (i) => i.key === k || (!!i.code && i.code.toLowerCase() === k.toLowerCase()),
      ),
    }));

  return (
    <dl
      className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5"
      data-testid="panel-fields"
    >
      <Field
        label="Outcome"
        testId="card-outcome"
        canChange={canChange}
        value={
          item.outcome ?? <span className="text-text2">Not written yet</span>
        }
        editor={(done) => (
          <TextEdit
            label="Outcome"
            value={item.outcome ?? ""}
            multiline
            done={done}
            save={(v) =>
              change(
                "Outcome changed",
                "edit_outcome",
                { outcome: item.outcome ?? null },
                { outcome: v || null },
              )
            }
          />
        )}
      />
      <Field
        label="Notes"
        testId="card-notes"
        canChange={canChange}
        value={item.note ?? <span className="text-text2">No notes yet</span>}
        editor={(done) => (
          <TextEdit
            label="Notes"
            value={item.note ?? ""}
            multiline
            max={500}
            done={done}
            save={(v) =>
              change(
                "Notes changed",
                "edit_note",
                { note: item.note ?? null },
                { note: v || null },
              )
            }
          />
        )}
      />
      <Field
        label="Dates"
        testId="card-dates"
        canChange={canChange}
        value={
          <>
            {yearSpan(item.start.date, item.end.date)} ·{" "}
            <span data-testid="card-dates-kind">{datesKind(item)}</span>{" "}
            <button
              type="button"
              aria-label="Why these dates"
              aria-expanded={why}
              className={`text-text2 hover:text-text ${TAP}`}
              onClick={() => setWhy(!why)}
            >
              (i)
            </button>
            {why && (
              <span
                className="mt-1 block text-sm text-text2"
                data-testid="card-dates-why"
              >
                {datesReason(item)}
              </span>
            )}
          </>
        }
        editor={(done) => (
          <DatesEdit
            item={item}
            done={done}
            save={(s, e) =>
              change(
                "Dates set",
                "move_dates",
                { start_date: item.start.date, end_date: item.end.date },
                { start_date: s, end_date: e },
              )
            }
          />
        )}
      />
      <Field
        label="Status"
        testId="card-status"
        canChange={canChange}
        value={statusWord(item.status)}
        editor={(done) => (
          <Pick
            label="Status"
            value={item.status}
            done={done}
            options={[
              ...(["planned", "done", "cut"].includes(item.status)
                ? []
                : [{ value: item.status, label: statusWord(item.status) }]),
              { value: "planned", label: "Planned" },
              { value: "done", label: "Done" },
              { value: "cut", label: "Cut" },
            ]}
            note={(v) => (v === "cut" && item.status !== "cut" ? parts("stay") : undefined)}
            save={(v) =>
              change(
                "Status changed",
                "set_status",
                { status: item.status },
                { status: v },
                undefined,
                v === "cut" && item.status !== "cut" ? parts("stay") : undefined,
              )
            }
          />
        )}
      />
      <Field
        label="Confidence"
        testId="card-confidence"
        canChange={canChange}
        value={item.confidence ? confidenceWord(item.confidence) : "Not rated"}
        editor={(done) => (
          <Pick
            label="Confidence"
            value={item.confidence ?? ""}
            done={done}
            options={[
              { value: "", label: "Not rated" },
              ...["low", "medium", "high"].map((c) => ({
                value: c,
                label: confidenceWord(c),
              })),
            ]}
            save={(v) =>
              change(
                "Confidence changed",
                "set_confidence",
                { confidence: item.confidence ?? null },
                { confidence: v || null },
              )
            }
          />
        )}
      />
      <Field
        label="Owner"
        testId="card-owner"
        canChange={canChange}
        value={
          item.owner?.name ?? <span className="text-text2">No owner yet</span>
        }
        editor={(done) => (
          <Pick
            label="Owner"
            value={item.own_owner_id ?? ""}
            done={done}
            options={[
              { value: "", label: "The track's owner" },
              ...(people.data ?? [])
                .filter((p) => p.can_write)
                .map((p) => ({ value: p.user_id, label: p.name })),
            ]}
            save={(v) =>
              change(
                "Owner changed",
                "set_owner",
                { owner_id: item.own_owner_id ?? null },
                { owner_id: v || null },
              )
            }
          />
        )}
      />
      <Field
        label="Track"
        testId="card-track"
        canChange={canChange}
        value={
          item.track?.title ?? <span className="text-text2">No track</span>
        }
        editor={(done) => (
          <Pick
            label="Track"
            value={item.track?.id ?? ""}
            done={done}
            options={[
              { value: "", label: "No track" },
              ...tracks.map((t) => ({ value: t.id, label: t.title })),
            ]}
            save={(v) =>
              change(
                "Track changed",
                "set_track",
                { track_id: item.track?.id ?? null },
                { track_id: v || null },
              )
            }
          />
        )}
      />
      <Field
        label="Goal"
        testId="card-goal"
        canChange={canChange}
        value={
          item.goal ? (
            item.goal.title
          ) : (
            <span className="text-text2">No goal yet</span>
          )
        }
        editor={(done) => (
          <Pick
            label="Goal"
            value={item.goal?.id ?? ""}
            done={done}
            options={[
              { value: "", label: "Its feature's goal" },
              ...goals.map((g) => ({
                value: g.id,
                label: g.metric
                  ? `${g.title} (measured by ${g.metric})`
                  : g.title,
              })),
            ]}
            save={(v) =>
              change(
                "Goal changed",
                "set_goal",
                { goal_id: item.goal?.id ?? null },
                { goal_id: v || null },
                undefined,
                parts("goal"),
              )
            }
          />
        )}
      />
      {goal && (
        // How the goal is measured, its target and date: one change to the goal (set_goal_measure),
        // checked against what was read, with Undo; a commenter's is a suggestion.
        <>
          {(["measure", "target", "due"] as const).map((f) => {
            const now = { measure: goal.metric ?? null, target: goal.target ?? null, due: goal.due ?? null };
            const label = { measure: "Measure", target: "Target", due: "Date" }[f];
            const value = now[f];
            return (
              <Field
                key={f}
                label={label}
                testId={`card-goal-${f === "due" ? "date" : f}`}
                canChange={canChange}
                value={
                  value ? (f === "due" ? dayWords(value) : value) : (
                    <span className="text-text2">{f === "measure" ? "No measure set for this goal yet" : `No ${label.toLowerCase()} yet`}</span>
                  )
                }
                editor={(done) => (
                  <TextEdit
                    label={label}
                    value={value ?? ""}
                    type={f === "due" ? "date" : undefined}
                    optional={f !== "measure"}
                    done={done}
                    save={(v) =>
                      change(
                        `${label} changed`,
                        "set_goal_measure",
                        now,
                        { ...now, [f]: v || null },
                        { goal_id: goal.id },
                      )
                    }
                  />
                )}
              />
            );
          })}
          {goal.current != null && (
            // build-feature-panel (AN PR 1204): the goal's latest reading beside its target, read
            // here and set on the goal ("Today 61% · target 70% by Jun 30, 2027").
            <>
              <dt className="text-text2">Reading</dt>
              <dd className="min-w-0 tnum" data-testid="card-goal-reading">
                Today {readingWords(goal.current, goal.unit)}
                {goal.target ? ` · target ${goal.target}` : ""}
                {goal.due ? ` by ${dayWords(goal.due)}` : ""}
              </dd>
            </>
          )}
        </>
      )}
      <Field
        label="PRD"
        testId="card-prd"
        canChange={canChange}
        value={item.prd?.title ?? <span className="text-text2">No PRD</span>}
        editor={(done) => (
          <Pick
            label="PRD"
            value={item.prd?.id ?? ""}
            done={done}
            options={[
              ...(item.prd ? [] : [{ value: "", label: "No PRD" }]),
              ...prds.map((p) => ({ value: p.id, label: p.title })),
            ]}
            save={(v) =>
              change(
                "PRD changed",
                "set_prd",
                { prd_document_id: item.prd?.id ?? null },
                { prd_document_id: v || null },
                undefined,
                parts("PRD"),
              )
            }
          />
        )}
      />
      <Field
        label="Milestone"
        testId="card-milestone"
        canChange={canChange}
        value={shownMilestone || <span className="text-text2">No milestone</span>}
        editor={(done) => (
          <Pick
            label="Milestone"
            value={item.milestone?.id ?? (shownMilestone ? SHOWN : "")}
            done={done}
            options={[
              // A milestone the feature reads that is not one picked here (its plan's, or typed in chat).
              ...(shownMilestone && !item.milestone?.id ? [{ value: SHOWN, label: shownMilestone }] : []),
              { value: "", label: "No milestone" },
              ...placeable(milestones, item.roadmap.id, byPrdOrderOf(prdOrderOf)).map((m) => ({ value: m.id, label: goalMilestoneWords(m, milestones) })),
            ]}
            save={async (v) => {
              if (v === SHOWN) return;
              const m = item.milestone;
              await change(
                "Milestone changed",
                "set_milestone",
                // The item's own milestone as it reads it (one from its track or plan is not its own).
                { milestone: m && m.source === "item" ? { id: m.id ?? null, name: m.name ?? null, date: m.date ?? null } : null },
                { milestone: v ? { id: v } : null },
              );
            }}
          />
        )}
      />
      <dt className="text-text2">Depends on</dt>
      <dd className="min-w-0">
        <div data-testid="card-depends">
        {deps.length + loose.length === 0 && (
          <span className="text-text2">Nothing</span>
        )}
        <ul className="space-y-0.5">
          {deps.map((d) => (
            <li
              key={d.id}
              className="flex flex-wrap items-baseline gap-x-2"
              data-testid="card-depends-row"
            >
              {featureButton(d)}
              {canChange && (
                <button
                  type="button"
                  className={REMOVE}
                  aria-label={`Remove ${d.title} from what it depends on`}
                  onClick={() =>
                    void change(
                      "Dependency removed",
                      "set_depends",
                      { depends_on: item.depends_keys },
                      {
                        depends_on: item.depends_keys.filter(
                          (k) => !keysOf(d).has(k),
                        ),
                      },
                    )
                  }
                >
                  <Icon name="x" size={16} />
                </button>
              )}
            </li>
          ))}
          {loose.map(({ k, found }) => (
            <li
              key={k}
              className="flex flex-wrap items-baseline gap-x-2"
              data-testid="card-depends-row"
            >
              {found ? featureButton(found) : <span>{k}</span>}
              {canChange && (
                <button
                  type="button"
                  className={REMOVE}
                  aria-label={`Remove ${found?.title ?? k} from what it depends on`}
                  onClick={() =>
                    void change(
                      "Dependency removed",
                      "set_depends",
                      { depends_on: item.depends_keys },
                      { depends_on: item.depends_keys.filter((x) => x !== k) },
                    )
                  }
                >
                  <Icon name="x" size={16} />
                </button>
              )}
            </li>
          ))}
        </ul>
        {/* roadmap-edit-fixes: Oracle's ideas of what a new item depends on: a person adds them. */}
        {canChange &&
          (item.suggested_depends ?? []).map((k) => {
            const found = others.find((i) => i.key === k);
            return (
              <p
                key={k}
                className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-sm text-text2"
                data-testid="card-depends-idea"
              >
                <span>
                  Oracle suggests {found ? <Named item={found} /> : k}
                </span>
                <button
                  type="button"
                  className={LINK}
                  aria-label={`Add ${found?.title ?? k} to what it depends on`}
                  onClick={() =>
                    void change(
                      "Dependency added",
                      "set_depends",
                      { depends_on: item.depends_keys },
                      { depends_on: [...item.depends_keys, k] },
                    )
                  }
                >
                  Add
                </button>
              </p>
            );
          })}
        </div>
        {canChange && (
          <AddDependency
            item={item}
            loops={needsMe(item, items)}
            options={others.filter((o) => !item.depends_on.includes(o.id) && !loose.some((l) => l.found?.id === o.id))}
            add={(key) =>
              change(
                "Dependency added",
                "set_depends",
                { depends_on: item.depends_keys },
                { depends_on: [...item.depends_keys, key] },
              )
            }
          />
        )}
      </dd>
      <dt className="text-text2">Needed by</dt>
      <dd className="min-w-0">
        <div data-testid="card-needed">
        {item.needed_by.length === 0 ? (
          "None"
        ) : (
          <ul className="space-y-0.5">
            {item.needed_by
              .map(shown)
              .filter((i): i is Item => !!i)
              .map((i) => (
                <li
                  key={i.id}
                  className="flex flex-wrap items-baseline gap-x-2"
                  data-testid="card-needed-row"
                >
                  {featureButton(i)}
                  {/* pre-demo QA S-4: the same dependency edit, from the other side (its set_depends). */}
                  {canChange && (
                    <button
                      type="button"
                      className={REMOVE}
                      aria-label={`Remove ${i.title} from what needs it`}
                      onClick={() =>
                        void change(
                          "Dependency removed",
                          "set_depends",
                          { depends_on: i.depends_keys },
                          { depends_on: i.depends_keys.filter((k) => !keysIn(i, item).has(k)) },
                          { item_id: i.id },
                        )
                      }
                    >
                      <Icon name="x" size={16} />
                    </button>
                  )}
                </li>
              ))}
          </ul>
        )}
        </div>
        {canChange && (
          <AddDependent
            loops={iNeed(item, items)}
            options={others.filter((o) => !item.needed_by.includes(o.id))}
            add={(o) =>
              change(
                "Dependency added",
                "set_depends",
                { depends_on: o.depends_keys },
                // The same roadmap: this item's key; another roadmap's feature: its code.
                { depends_on: [...o.depends_keys, o.roadmap.id === item.roadmap.id ? item.key : (item.code ?? item.key)] },
                { item_id: o.id },
              )
            }
          />
        )}
      </dd>
    </dl>
  );
}

function TextEdit({
  label,
  value,
  multiline,
  type,
  optional,
  max,
  save,
  done,
}: {
  label: string;
  value: string;
  /** build-feature-panel: the most characters the API takes; past it, Save waits and says so. */
  max?: number;
  multiline?: boolean;
  /** "date": a day picker (YYYY-MM-DD). */
  type?: "date";
  /** May be saved empty (cleared). */
  optional?: boolean;
  save: (v: string) => Promise<void>;
  done: () => void;
}) {
  const [v, setV] = useState(value);
  const over = max != null && v.trim().length > max;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (over) return;
        done();
        if (v.trim() !== value) void save(v.trim());
      }}
    >
      {multiline ? (
        <textarea
          aria-label={label}
          className={INPUT}
          rows={3}
          value={v}
          onChange={(e) => setV(e.target.value)}
          autoFocus
        />
      ) : (
        <input
          aria-label={label}
          type={type}
          className={INPUT}
          value={v}
          onChange={(e) => setV(e.target.value)}
          autoFocus
        />
      )}
      {over && (
        <span role="alert" data-testid="field-too-long" className="mt-1 block text-sm text-crit">
          Keep the {label.toLowerCase()} to {max} characters
        </span>
      )}
      <SaveCancel onCancel={done} disabled={over || (!multiline && !optional && !v.trim())} />
    </form>
  );
}

/** The name, edited in the panel's header. */
export function NameEdit({
  item,
  act,
  done,
}: {
  item: Item;
  act: Act;
  done: () => void;
}) {
  return (
    <TextEdit
      label="Name"
      value={item.title}
      max={200}
      done={done}
      save={(v) =>
        act("Renamed", {
          op: "edit_title",
          target: { item_id: item.id },
          before: { title: item.title },
          after: { title: v },
        })
      }
    />
  );
}

function DatesEdit({
  item,
  save,
  done,
}: {
  item: Item;
  save: (start: string, end: string) => Promise<void>;
  done: () => void;
}) {
  const [start, setStart] = useState(item.start.date);
  const [end, setEnd] = useState(item.end.date);
  const bad = !start || !end || end < start;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (bad) return;
        done();
        void save(start, end);
      }}
    >
      <span className="flex flex-wrap gap-2">
        <label className="text-sm text-text2">
          Start
          <input
            type="date"
            aria-label="Start"
            className={INPUT}
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <label className="text-sm text-text2">
          End
          <input
            type="date"
            aria-label="End"
            className={INPUT}
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
      </span>
      {bad && (
        <span className="block text-sm text-warn">
          The end cannot come before the start
        </span>
      )}
      <SaveCancel onCancel={done} disabled={bad} />
    </form>
  );
}

/** The stored keys of `owner`'s dependencies that name `dep` (the read's, and its key or code in any case). */
function keysIn(owner: Item, dep: Item): Set<string> {
  return new Set(
    owner.depends_keys.filter(
      (k) =>
        k === owner.depends_key_of?.[dep.id] ||
        (owner.depends_keys_of?.[dep.id] ?? []).includes(k) ||
        k.toLowerCase() === dep.key.toLowerCase() ||
        (!!dep.code && k.toLowerCase() === dep.code.toLowerCase()),
    ),
  );
}

/** pre-demo QA S-4: the features the item waits on, directly or through others (picked as one that needs it, they would make a loop). */
function iNeed(item: Item, items: Map<string, Item>): Set<string> {
  const out = new Set<string>();
  const queue = [item.id];
  while (queue.length) {
    const id = queue.shift()!;
    for (const n of items.get(id)?.depends_on ?? []) {
      if (n !== item.id && !out.has(n)) {
        out.add(n);
        queue.push(n);
      }
    }
  }
  return out;
}

/** build-feature-panel (AN PR 1204): the features that wait on the item, directly or through others. */
function needsMe(item: Item, items: Map<string, Item>): Set<string> {
  const out = new Set<string>();
  const queue = [item.id];
  while (queue.length) {
    const id = queue.shift()!;
    for (const n of items.get(id)?.needed_by ?? []) {
      if (n !== item.id && !out.has(n)) {
        out.add(n);
        queue.push(n);
      }
    }
  }
  return out;
}

/** Add a dependency: a feature of the roadmap by code and name, or another PRD's feature by its key. */
function AddDependency({
  item,
  options,
  loops,
  add,
}: {
  item: Item;
  options: Item[];
  /** The features that already wait on this one (directly or through others): picked, they would make a loop. */
  loops: Set<string>;
  add: (key: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState("");
  const [typed, setTyped] = useState("");
  if (!open)
    return (
      <button
        type="button"
        className={`${LINK} mt-0.5 block max-sm:flex max-sm:w-fit`}
        onClick={() => setOpen(true)}
      >
        Add a dependency
      </button>
    );
  const chosen = options.find((o) => o.id === pick);
  // The same roadmap: its item key; another roadmap's feature: its code (a feature key).
  const key = chosen
    ? chosen.roadmap.id === item.roadmap.id
      ? chosen.key
      : (chosen.code ?? chosen.key)
    : typed.trim();
  return (
    <form
      className="mt-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (!key) return;
        setOpen(false);
        setPick("");
        setTyped("");
        void add(key);
      }}
    >
      <select
        aria-label="Feature it depends on"
        className={INPUT}
        value={pick}
        onChange={(e) => setPick(e.target.value)}
        autoFocus
      >
        <option value="">Pick a feature</option>
        {options.map((o) => (
          <option key={o.id} value={o.id} disabled={loops.has(o.id)}>
            {o.code ? `${o.code} ${o.title}` : o.title}
            {loops.has(o.id) ? " · Needs this one: it would make a loop" : ""}
          </option>
        ))}
      </select>
      {!pick && (
        <input
          aria-label="Or another PRD's feature key"
          placeholder="Or another PRD's feature key, like F-12"
          className={`${INPUT} mt-1`}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
      )}
      <SaveCancel onCancel={() => setOpen(false)} disabled={!key} />
    </form>
  );
}

/** pre-demo QA S-4: add a feature that needs this one (its own dependency, set from here). */
function AddDependent({
  options,
  loops,
  add,
}: {
  options: Item[];
  /** The features this one already waits on (directly or through others): picked, they would make a loop. */
  loops: Set<string>;
  add: (o: Item) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState("");
  if (!open)
    return (
      <button
        type="button"
        className={`${LINK} mt-0.5 block max-sm:flex max-sm:w-fit`}
        onClick={() => setOpen(true)}
      >
        Add a feature that needs it
      </button>
    );
  const chosen = options.find((o) => o.id === pick);
  return (
    <form
      className="mt-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (!chosen) return;
        setOpen(false);
        setPick("");
        void add(chosen);
      }}
    >
      <select
        aria-label="Feature that needs it"
        className={INPUT}
        value={pick}
        onChange={(e) => setPick(e.target.value)}
        autoFocus
      >
        <option value="">Pick a feature</option>
        {options.map((o) => (
          <option key={o.id} value={o.id} disabled={loops.has(o.id)}>
            {o.code ? `${o.code} ${o.title}` : o.title}
            {loops.has(o.id) ? " · This one needs it: it would make a loop" : ""}
          </option>
        ))}
      </select>
      <SaveCancel onCancel={() => setOpen(false)} disabled={!chosen} />
    </form>
  );
}
