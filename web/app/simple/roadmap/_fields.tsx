"use client";
// one-feature-panel: every field of a feature, read and changed in place in its panel. Each
// save is one Simple change (Undo, the "changed by …" conflict rule; a commenter's is a
// suggestion for an approver). Without canChange (a viewer) the fields only read.

import { useState } from "react";

import { Icon } from "@/components/ds/Icon";

import { api, unwrap } from "@/lib/api/client";
import { calendarDay } from "@/lib/dates";
import { useQuery } from "@/lib/use-query";

import type { Act } from "./_card";
import {
  confidenceWord,
  datesFrom,
  statusWord,
  yearSpan,
  type Item,
} from "./_lib";

const LINK = "text-sm font-semibold text-accent-ink hover:underline";
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
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  save: (v: string) => Promise<void>;
  done: () => void;
}) {
  const [v, setV] = useState(value);
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
      <SaveCancel onCancel={done} />
    </form>
  );
}

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

export function PanelFields({
  item,
  items,
  act,
  canChange,
  onOpen,
}: {
  item: Item;
  items: Map<string, Item>;
  act: Act;
  canChange: boolean;
  /** Opens another feature's own panel (a dependency, or one that needs this one). */
  onOpen?: (id: string) => void;
}) {
  const [why, setWhy] = useState(false);
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
  ) => act(what, { op: op as never, target: { ...target, ...more }, before, after });
  const others = [...items.values()].filter(
    (i) => i.id !== item.id && i.status !== "merged",
  );
  const tracks = refs(items, (i) => i.track);
  const prds = refs(items, (i) => i.prd);
  const goals = refs(items, (i) => i.goal);
  const keyOf = (dep: Item) =>
    item.depends_keys.find(
      (k) =>
        k === dep.key ||
        (!!dep.code && k.toLowerCase() === dep.code.toLowerCase()),
    ) ?? dep.key;
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
    .filter((k) => !deps.some((d) => keyOf(d) === k))
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
              className="text-text2 hover:text-text"
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
            save={(v) =>
              change(
                "Status changed",
                "set_status",
                { status: item.status },
                { status: v },
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
              )
            }
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
                  className={LINK}
                  aria-label={`Remove ${d.title} from what it depends on`}
                  onClick={() =>
                    void change(
                      "Dependency removed",
                      "set_depends",
                      { depends_on: item.depends_keys },
                      {
                        depends_on: item.depends_keys.filter(
                          (k) => k !== keyOf(d),
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
                  className={LINK}
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
        </div>
        {canChange && (
          <AddDependency
            item={item}
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
      <dd data-testid="card-needed" className="min-w-0">
        {item.needed_by.length === 0 ? (
          "None"
        ) : (
          <ul className="space-y-0.5">
            {item.needed_by
              .map(shown)
              .filter((i): i is Item => !!i)
              .map((i) => (
                <li key={i.id}>{featureButton(i)}</li>
              ))}
          </ul>
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
  save,
  done,
}: {
  label: string;
  value: string;
  multiline?: boolean;
  /** "date": a day picker (YYYY-MM-DD). */
  type?: "date";
  /** May be saved empty (cleared). */
  optional?: boolean;
  save: (v: string) => Promise<void>;
  done: () => void;
}) {
  const [v, setV] = useState(value);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
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
      <SaveCancel onCancel={done} disabled={!multiline && !optional && !v.trim()} />
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

/** Add a dependency: a feature of the roadmap by code and name, or another PRD's feature by its key. */
function AddDependency({
  item,
  options,
  add,
}: {
  item: Item;
  options: Item[];
  add: (key: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState("");
  const [typed, setTyped] = useState("");
  if (!open)
    return (
      <button
        type="button"
        className={`${LINK} mt-0.5 block`}
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
          <option key={o.id} value={o.id}>
            {o.code ? `${o.code} ${o.title}` : o.title}
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
