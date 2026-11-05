"use client";

/**
 * build-feature-panel: Simple's one feature panel, drawn to the owner's picks
 * (mk-featurepanel): FP1 B "Panel with talk beside", an 880 px panel on the right, the
 * details at left and the feature's talk with Oracle at right, the page behind dimmed (a
 * phone: the whole screen, Details and Talk tabs); FP2 A "Each field in place", every value
 * a field with Save and Cancel right under it, a replaced Oracle date kept on one line with
 * Restore; FP3 A "Two lists with search", Depends on and Needed by with counts, who made
 * each link, Oracle's removed links struck with Restore, "+ Add" searching every roadmap.
 * Every Simple page that shows a feature opens it (Roadmap's four views through its card,
 * the other pages through FeaturePanelHost).
 */

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ds";
import { api, unwrap } from "@/lib/api/client";
import { calendarDay, displayZone, todayIn } from "@/lib/dates";
import { useQuery } from "@/lib/use-query";

import type { Act } from "@/app/simple/roadmap/_card";
import { confidenceWord, datesFrom, statusWord, storedDates, yearSpan, type Item } from "@/app/simple/roadmap/_lib";

const DAY = 86_400_000;
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const isoOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => isoOf(ms(d) + n * DAY);
/** Month first, the year only when it is not the company's this one ("Nov 27", "Jan 17, 2027"). */
const day = (d: string) => (d.slice(0, 4) === todayIn(displayZone()).slice(0, 4) ? calendarDay(d) : `${calendarDay(d)}, ${d.slice(0, 4)}`);
const span = (a: string, b: string) => yearSpan(a, b);
const SOURCE_WORDS: Record<string, string> = {
  engineering: "Engineering estimate",
  tracker: "From the tracker",
  // build-feature-panel review 3: as the picked frames say it (an accepted date is Oracle's plan of who is free when).
  accepted: "From the capacity plan",
  estimated: "Oracle's estimate",
  prd: "From the PRD",
  typed: "Set by a person",
};
const sourceWords = (s: string | null | undefined) => (s ? (SOURCE_WORDS[s] ?? `From ${s}`) : "Oracle's estimate");
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** A typed date ("Nov 27", "Nov 27, 2027", "2026-11-27") as a day, near `near`; null when unreadable. */
export function readDay(text: string, near: string): string | null {
  const t = text.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/i.exec(t);
  if (!m) return null;
  const mo = MONTHS.indexOf(m[1].toLowerCase());
  if (mo < 0) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (m[3]) return `${m[3]}-${pad(mo + 1)}-${pad(Number(m[2]))}`;
  const y = Number(near.slice(0, 4));
  const options = [y - 1, y, y + 1].map((yy) => `${yy}-${pad(mo + 1)}-${pad(Number(m[2]))}`);
  return options.reduce((a, b) => (Math.abs(ms(b) - ms(near)) < Math.abs(ms(a) - ms(near)) ? b : a));
}

type Ctx = { item: Item; items: Map<string, Item>; act: Act; edit: boolean };

/** review 7: a field's button says Save to one who decides the item, else Propose (its can_decide). */
const SaveWord = createContext("Save");

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-2 py-1">
      <dt className="text-sm leading-[22px] text-text2">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function Section({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return (
    <section className="border-b border-line py-3 last:border-0" data-fp-section={id}>
      <h3 className="font-semibold">{title}</h3>
      <div className="mt-1.5">{children}</div>
    </section>
  );
}

/** A value changed in place (FP2 A): the value reads as text; a click makes it a field with Save and Cancel under it. */
function Field({ label, value, shown, edit, note, multiline, number, onSave, testId }: { label: string; value: string; shown?: ReactNode; edit: boolean; note?: ReactNode; multiline?: boolean; number?: boolean; onSave: (v: string) => Promise<string | null> | string | null; testId?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saveWord = useContext(SaveWord);
  if (!edit) return <span data-testid={testId}>{shown ?? value}</span>;
  if (draft === null)
    return (
      <button type="button" data-testid={testId} aria-label={`Change ${label}`} onClick={() => (setDraft(value), setError(null))} className="-mx-1 rounded px-1 text-left decoration-line-strong decoration-dotted underline-offset-4 hover:bg-surface2 hover:underline" title="Click to change">
        {shown ?? value}
      </button>
    );
  const save = async () => {
    const err = await onSave(draft);
    if (err) setError(err);
    else setDraft(null);
  };
  const cls = "w-full rounded-md border-2 border-accent bg-surface px-2 text-[15px]";
  return (
    <div data-testid="fp-edit">
      {multiline ? (
        <textarea autoFocus aria-label={label} rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} className={`${cls} py-1`} />
      ) : (
        <input autoFocus aria-label={label} type={number ? "number" : "text"} min={number ? 0.5 : undefined} step={number ? 0.5 : undefined} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} className={`${cls} h-9`} />
      )}
      {note && <p className="mt-1 text-sm text-text2">{note}</p>}
      {error && (
        <p className="mt-1 text-sm text-crit" role="alert">
          {error}
        </p>
      )}
      <div className="mt-1.5 flex gap-2">
        <Button variant="solid" onClick={() => void save()}>
          {saveWord}
        </Button>
        <Button variant="ghost" onClick={() => setDraft(null)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** A value picked or typed in place (FP2 A), its fields drawn by `fields`, Save and Cancel under them. */
function Editor<T>({ label, shown, edit, start, fields, onSave, testId, after }: { label: string; shown: ReactNode; edit: boolean; start: () => T; fields: (d: T, set: (d: T) => void) => ReactNode; onSave: (d: T) => Promise<string | null> | string | null; testId: string; after?: (open: (() => void) | null) => ReactNode }) {
  const [draft, setDraft] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saveWord = useContext(SaveWord);
  const open = () => (setDraft(start()), setError(null));
  if (!edit)
    return (
      <>
        <span data-testid={testId}>{shown}</span>
        {after?.(null)}
      </>
    );
  if (draft === null)
    return (
      <>
        <button type="button" data-testid={testId} aria-label={`Change ${label}`} onClick={open} className="-mx-1 rounded px-1 text-left decoration-line-strong decoration-dotted underline-offset-4 hover:bg-surface2 hover:underline" title="Click to change">
          {shown}
        </button>
        {after?.(open)}
      </>
    );
  const save = async () => {
    const err = await onSave(draft);
    if (err) setError(err);
    else setDraft(null);
  };
  return (
    <div data-testid="fp-edit">
      {fields(draft, setDraft)}
      {error && (
        <p className="mt-1 text-sm text-crit" role="alert">
          {error}
        </p>
      )}
      <div className="mt-1.5 flex gap-2">
        <Button variant="solid" onClick={() => void save()}>
          {saveWord}
        </Button>
        <Button variant="ghost" onClick={() => setDraft(null)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

const FIELD = "w-full rounded-md border-2 border-accent bg-surface px-2 text-[15px] h-9";

/** review 7: the feature's name, renamed in place (edit_title: 1 to 200 characters, as the API takes it). */
function Title({ c }: { c: Ctx }) {
  const { item, act, edit } = c;
  return (
    <Field
      label="Name"
      value={item.title}
      edit={edit}
      testId="fp-title"
      onSave={async (v) => {
        const title = v.split(/\s+/).filter(Boolean).join(" ");
        if (!title) return "Type a name";
        if (title.length > 200) return "Keep the name to 200 characters";
        if (title === item.title) return null;
        await act(`Renamed ${item.title} to ${title}`, { op: "edit_title", target: { item_id: item.id }, before: { title: item.title }, after: { title } }, { words: () => `Renamed ${item.title} to ${title}` });
        return null;
      }}
    />
  );
}

const weeks = (n: number) => `${n.toLocaleString("en-US")} engineer-week${n === 1 ? "" : "s"}`;
const lineWords = (r: { rank: number; above_line: boolean }) => `ranked ${r.rank}, ${r.above_line ? "above" : "below"} the line`;
const scoreOf = (n: number | null | undefined) => (n == null ? null : (Math.round(n * 10) / 10).toLocaleString("en-US"));

/** review 7: the feature's effort in engineer-weeks (estimate_feature), with its score and where
 * it ranks against the line, read from Priorities' ranking; a feature not ranked has none yet. */
function Effort({ c }: { c: Ctx }) {
  const { item, act, edit } = c;
  const ranking = useQuery("simple-priorities:feature-panel", () => unwrap(api.GET("/v1/simple/priorities", {})));
  const row = ranking.data?.rows.find((r) => r.item_id === item.id);
  if (!ranking.data) return <span className="text-text2">{ranking.error ?? "Loading…"}</span>;
  if (!row) return <span className="text-text2" data-testid="fp-effort">Not in the ranking yet</span>;
  const score = scoreOf(row.score);
  return (
    <>
      <Field
        label="Effort in engineer-weeks"
        value={row.effort != null ? String(row.effort) : ""}
        shown={row.effort != null ? weeks(row.effort) : <span className="text-text2">Not estimated yet</span>}
        edit={edit}
        number
        testId="fp-effort"
        onSave={async (v) => {
          const n = Math.round(Number(v) * 10) / 10;
          if (!v.trim() || !Number.isFinite(n) || n <= 0) return "Type the weeks as a number above 0";
          if (n === row.effort) return null;
          const words = async () => {
            const now = (await unwrap(api.GET("/v1/simple/priorities", {}))).rows.find((r) => r.item_id === item.id);
            return now ? `${item.title}: effort ${weeks(n)}, score ${scoreOf(now.score) ?? "not worked out"}, ${lineWords(now).replace(",", "")}` : `${item.title}: effort ${weeks(n)}`;
          };
          await act(`Set the effort of ${item.title} to ${weeks(n)}`, { op: "estimate_feature", target: { item_id: item.id }, before: { goal_value: row.value_estimated ? (row.goal_value ?? null) : null, effort: row.effort ?? null }, after: { effort: n } }, { words });
          return null;
        }}
      />
      <span className="block text-sm text-text2" data-testid="fp-effort-score">
        {score != null ? `Score ${score}` : "No score yet"} · {lineWords(row)}
      </span>
    </>
  );
}

/** The owner, any active member of the company; "Its track's owner" clears the item's own. */
function Owner({ c }: { c: Ctx }) {
  const { item, act, edit } = c;
  const people = useQuery(edit ? "people:feature-panel" : "people:none", () => (edit ? unwrap(api.GET("/v1/people", { params: { query: { limit: 100 } } })) : Promise.resolve([])));
  const list = people.data ?? [];
  return (
    <Editor<string>
      label="Owner"
      testId="fp-owner"
      edit={edit}
      shown={item.owner?.name ?? <span className="text-text2">No owner yet</span>}
      start={() => item.owner?.id ?? ""}
      fields={(d, set) => (
        <select autoFocus aria-label="Owner" value={d} onChange={(e) => set(e.target.value)} className={FIELD}>
          <option value="">Its track&apos;s owner</option>
          {item.owner && !list.some((p) => p.user_id === item.owner!.id) && <option value={item.owner.id}>{item.owner.name}</option>}
          {list.map((p) => (
            <option key={p.user_id} value={p.user_id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
      onSave={async (d) => {
        if (d === (item.owner?.id ?? "")) return null;
        // Its track's owner already: nothing to change.
        if (!d && item.owner?.source !== "item") return null;
        const name = list.find((p) => p.user_id === d)?.name;
        await act(name ? `Made ${name} the owner of '${item.title}'` : `Gave '${item.title}' back to its track's owner`, { op: "set_owner", target: { item_id: item.id }, before: { owner_id: item.owner?.source === "item" ? item.owner.id : null }, after: { owner_id: d || null } });
        return null;
      }}
    />
  );
}

/** The item's own milestone: a name and, if typed, a day ("Nov 27"); an empty name clears it. */
function MilestoneField({ c }: { c: Ctx }) {
  const { item, act, edit } = c;
  const m = item.milestone;
  // The milestone as the item reads it: set_milestone matches its name and date only.
  const own = m?.source === "item" && (m.name || m.date) ? { name: m.name ?? null, date: m.date ?? null } : null;
  const near = todayIn(displayZone());
  return (
    <Editor<{ name: string; date: string }>
      label="Milestone"
      testId="fp-milestone"
      edit={edit}
      shown={m?.name || m?.date ? `${m.name ?? "Milestone"}${m.date ? ` · ${day(m.date)}` : ""}` : <span className="text-text2">None</span>}
      start={() => ({ name: m?.name ?? "", date: m?.date ? day(m.date) : "" })}
      fields={(d, set) => (
        <div className="grid gap-1.5">
          <input autoFocus aria-label="Milestone name" value={d.name} onChange={(e) => set({ ...d, name: e.target.value })} className={FIELD} />
          <input aria-label="Milestone day" placeholder="Nov 27" value={d.date} onChange={(e) => set({ ...d, date: e.target.value })} className={FIELD} />
        </div>
      )}
      onSave={async (d) => {
        const name = d.name.trim();
        const date = d.date.trim() ? readDay(d.date, near) : null;
        if (d.date.trim() && !date) return "Type the day as Nov 27";
        await act(name ? `Set the milestone of '${item.title}' to ${name}` : `Cleared the milestone of '${item.title}'`, { op: "set_milestone", target: { item_id: item.id }, before: { milestone: own }, after: { milestone: name ? { name, date } : null } });
        return null;
      }}
    />
  );
}

/** The goal it serves and how that is measured (review 2): fields with Save and Cancel, through
 * set_goal; a goal set over Oracle's says so on one line with Restore (restore_goal). */
function GoalFields({ c }: { c: Ctx }) {
  const { item, items, act, edit } = c;
  const gs = item.goal_set;
  const measure = gs?.measure ?? item.goal?.metric ?? null;
  // Every goal the roadmap's features serve, and Oracle's for this one.
  const goals = useMemo(() => {
    const out = new Map<string, string>();
    for (const i of items.values()) if (i.goal) out.set(i.goal.id, i.goal.title);
    if (item.goal) out.set(item.goal.id, item.goal.title);
    if (gs?.oracle) out.set(gs.oracle.id, gs.oracle.title);
    return [...out].sort((a, b) => a[1].localeCompare(b[1]));
  }, [items, item.goal, gs]);
  const save = async (goal: string, m: string) => {
    const typed = m.trim() || null;
    if (goal === (item.goal?.id ?? "") && typed === (gs?.measure ?? null)) return null;
    if (goal === (item.goal?.id ?? "") && typed === (item.goal?.metric ?? null) && !gs) return null;
    const title = goals.find(([id]) => id === goal)?.[1];
    await act(title ? `Set the goal of '${item.title}' to ${title}` : `Took the goal off '${item.title}'`, { op: "set_goal", target: { item_id: item.id }, before: { goal_ids: item.goal_ids }, after: { goal_ids: goal ? [goal] : [], measure: typed } });
    return null;
  };
  return (
    <dl>
      <Row label="Serves">
        <Editor<string>
          label="Goal"
          testId="fp-goal"
          edit={edit}
          shown={item.goal ? item.goal.title : <span className="text-text2">No goal yet</span>}
          start={() => item.goal?.id ?? ""}
          fields={(d, set) => (
            <select autoFocus aria-label="Goal" value={d} onChange={(e) => set(e.target.value)} className={FIELD}>
              <option value="">No goal</option>
              {goals.map(([id, title]) => (
                <option key={id} value={id}>
                  {title}
                </option>
              ))}
            </select>
          )}
          onSave={(d) => save(d, gs?.measure ?? "")}
          after={(open) =>
            gs ? null : item.goal ? (
              <span className="block text-sm text-text2">
                Oracle linked it from the PRD
                {open && (
                  <>
                    {" · "}
                    <button type="button" onClick={open} className="font-medium text-accent-ink underline">
                      Change
                    </button>
                  </>
                )}
              </span>
            ) : null
          }
        />
        {gs && (
          <span className="block text-sm text-text2" data-testid="fp-goal-override">
            Oracle suggested {gs.oracle?.title ?? "no goal"}; set to {item.goal?.title ?? "no goal"} by {gs.by ?? "a person"}
            {edit && (
              <>
                {" · "}
                <button type="button" onClick={() => void act(`Put Oracle's goal back on '${item.title}'`, { op: "restore_goal", target: { item_id: item.id }, before: { goal_ids: item.goal_ids }, after: {} })} className="font-medium text-accent-ink underline">
                  Restore
                </button>
              </>
            )}
          </span>
        )}
      </Row>
      <Row label="Measure">
        <Field label="Measure" value={measure ?? ""} shown={measure ?? <span className="text-text2">Not set yet</span>} edit={edit} onSave={(v) => save(item.goal?.id ?? "", v)} testId="fp-measure" />
      </Row>
      {item.goal && (
        <Row label="Reading">
          <Reading goal={item.goal} />
        </Row>
      )}
    </dl>
  );
}

/** build-feature-panel review 3 (FP1 B): the goal's latest reading and its target, as the frames draw them ("Today 61% · target 70% by Jun 30, 2027"); it is read here and set on the goal. */
function Reading({ goal }: { goal: NonNullable<Item["goal"]> }) {
  const n = (v: number) => `${v.toLocaleString("en-US")}${goal.unit ? (goal.unit === "%" ? "%" : ` ${goal.unit}`) : ""}`;
  const now = goal.current ?? null;
  const target = goal.target ?? null;
  if (now === null && target === null) return <span className="text-text2" data-testid="fp-reading">No reading yet</span>;
  return (
    <span className="tnum" data-testid="fp-reading">
      {now !== null ? (
        <>
          Today <b className="font-semibold">{n(now)}</b>
        </>
      ) : (
        "No reading yet"
      )}
      {target !== null && (
        <>
          {" · "}target <b className="font-semibold">{n(target)}</b>
          {goal.due ? ` by ${day(goal.due)}` : ""}
        </>
      )}
    </span>
  );
}

/** What the item's dependencies' late ends are: every link that ends on or after it starts. */
function lateLinks(item: Item, items: Map<string, Item>): Item[] {
  return item.depends_on.map((id) => items.get(id)).filter((d): d is Item => !!d && d.end.date >= item.start.date && d.status !== "cut");
}

/** A date clash in words, naming every late link ("… and 3 more"), and its fixes. */
function Clash({ c, late, lateMilestone, added }: { c: Ctx; late: Item[]; lateMilestone: boolean; added: Item | null }) {
  const { item, act, edit } = c;
  const [note, setNote] = useState<string | null>(null);
  if (!late.length && !lateMilestone) return null;
  const byEnd = [...late].sort((a, b) => (a.end.date < b.end.date ? 1 : -1));
  const last = byEnd[0];
  const parts: string[] = [];
  if (late.length === 1) parts.push(`Starts ${day(item.start.date)}, before ${late[0].title} ends ${day(late[0].end.date)}.`);
  else if (late.length === 2) parts.push(`Starts ${day(item.start.date)}, before ${late[0].title} ends ${day(late[0].end.date)} and before ${late[1].title} ends ${day(late[1].end.date)}.`);
  else if (late.length > 2) {
    const rest = late.slice(1).map((d) => d.title);
    parts.push(`Starts ${day(item.start.date)}, before ${late[0].title} and ${rest.length} more end: ${rest.slice(0, -1).join(", ")} and ${rest[rest.length - 1]}. The last ends ${day(last.end.date)}.`);
  }
  const ms_ = item.milestone;
  if (lateMilestone && ms_?.date) parts.push(`Ends ${day(item.end.date)}, after its milestone ${ms_.name ?? "Milestone"} (${day(ms_.date)}).`);
  const length = Math.round((ms(item.end.date) - ms(item.start.date)) / DAY);
  const movedStart = last ? addDays(last.end.date, 1) : null;
  const before = (ids: Item[]) => Object.fromEntries([item, ...ids].map((i) => [i.id, storedDates(i)]));
  const moveDependents = () => last && void act(`Moved '${item.title}' after '${last.title}'`, { op: "shift_dependents", target: { item_id: item.id, subject: last.id }, before: before([last]), after: {} });
  const moveDependencies = async () => {
    for (const d of late) await act(`Moved '${d.title}'`, { op: "move_dependency", target: { item_id: item.id, subject: d.id }, before: before([d]), after: {} });
  };
  const flags = item.flags.filter((f) => f.state === "red" && (f.kind === "dependency_order" || f.kind === "outside_milestone"));
  // fix4 qa-simple-roadmap-18: one who may not decide the item (a commenter) only proposes the fix, and its button says so.
  const say = (w: string) => (item.can_decide ? w : `Propose: ${w[0].toLowerCase()}${w.slice(1)}`);
  return (
    <div className="mt-2 rounded-lg border border-crit/40 bg-crit-bg px-3 py-2" data-testid="fp-clash">
      <p className="text-sm font-medium text-crit">{parts.join(" ")}</p>
      {edit && note === null && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {last && movedStart && (
            <Button variant="solid" onClick={moveDependents}>
              {say(`Move the dependents: ${span(movedStart, addDays(movedStart, length))}`)}
            </Button>
          )}
          {late.length > 0 && <Button onClick={() => void moveDependencies()}>{say(late.length > 1 ? "Move the dependencies" : "Move the dependency")}</Button>}
          {flags.length > 0 && <Button onClick={() => setNote("")}>{say("Accept as risk")}</Button>}
          {added && (
            <Button onClick={() => void act(`Removed the link to '${added.title}'`, { op: "remove_link", target: { item_id: item.id, subject: added.id }, before: { depends_on: depKeys(item, c.items) }, after: {} })}>
              Remove the new link
            </Button>
          )}
        </div>
      )}
      {edit && note !== null && (
        <form
          className="mt-1.5 flex flex-wrap items-center gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!note.trim()) return;
            for (const f of flags)
              await act("Accepted as a risk", { op: "accept_risk", target: { item_id: item.id, flag: f.kind, subject: f.subject ?? null }, before: { risk: null }, after: { risk: { note: note.trim() } } });
            setNote(null);
          }}
        >
          <input autoFocus aria-label="Why it is an accepted risk" placeholder="One line: why it is fine" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} className="h-8 min-w-0 flex-1 rounded-lg border border-line-strong bg-surface px-2 text-sm" />
          <Button type="submit" variant="solid">
            Save the risk
          </Button>
          <Button variant="ghost" onClick={() => setNote(null)}>
            Cancel
          </Button>
        </form>
      )}
    </div>
  );
}

const depKeys = (item: Item, items: Map<string, Item>) => item.depends_on.map((id) => items.get(id)?.key).filter((k): k is string => !!k);

function Dates({ c, late, lateMilestone, added }: { c: Ctx; late: Item[]; lateMilestone: boolean; added: Item | null }) {
  const { item, act, edit } = c;
  const o = item.override;
  const oracleSays = !o && item.source !== "typed" && !item.estimated ? item.end.date : null;
  // Oracle's delivery the new one replaces (FP1 B's toast: "(Oracle suggested Dec 10)").
  const oracleEnd = o?.end_date ?? oracleSays;
  const move = async (start: string, end: string): Promise<string | null> => {
    if (end < start) return "The delivery can't come before the start.";
    const parts = [start !== item.start.date && `start ${day(start)}`, end !== item.end.date && `delivery ${day(end)}`].filter(Boolean).join(" and ");
    const words = (r: { change: { by_name: string } }) => `${item.title} saved: ${parts || `dates ${span(start, end)}`}, set by ${r.change.by_name}${oracleEnd && end !== oracleEnd ? ` (Oracle suggested ${day(oracleEnd)})` : ""}.`;
    await act(`Moved '${item.title}' to ${span(start, end)}`, { op: "move_dates", target: { item_id: item.id }, before: storedDates(item), after: { start_date: start, end_date: end } }, { words });
    return null;
  };
  // An item's own date basis (an approved roadmap's "founder commitment") reads as the Gantt says it.
  const from = (which: "start" | "end") => (item.estimated ? "Oracle's estimate from its horizon" : item.date_basis?.trim() ? datesFrom(item) : which === "end" || !item.start.source ? sourceWords(item.end.source ?? item.source) : sourceWords(item.start.source));
  return (
    <div>
      <dl>
        <Row label="Start">
          <Field label="Start" value={calendarDay(item.start.date)} shown={day(item.start.date)} edit={edit} onSave={(v) => { const d = readDay(v, item.start.date); return d ? move(d, item.end.date) : "Type a date like Nov 11."; }} testId="fp-start" />
          {/* build-feature-panel review 3 (FP1 B saved): a start the person left keeps its own source. */}
          <span className="block text-sm text-text2" data-testid="fp-start-note">
            {o ? (o.start_date === item.start.date ? sourceWords(o.start_source ?? o.source) : `Set by ${o.by ?? "a person"}`) : from("start")}
          </span>
        </Row>
        <Row label="Delivery">
          <Field
            label="Delivery"
            value={calendarDay(item.end.date)}
            shown={day(item.end.date)}
            edit={edit}
            note={oracleSays ? <>Oracle suggests {day(oracleSays)} ({sourceWords(item.end.source ?? item.source).toLowerCase()}). Your date replaces it; you can restore it later.</> : undefined}
            onSave={(v) => { const d = readDay(v, item.end.date); return d ? move(item.start.date, d) : "Type a date like Nov 27."; }}
            testId="fp-delivery"
          />
          {o?.end_date ? (
            <span className="block text-sm text-text2" data-testid="fp-override">
              Oracle suggested {day(o.end_date)}; set to {day(item.end.date)} by {o.by ?? "a person"}
              {edit && (
                <>
                  {" · "}
                  <button type="button" onClick={() => void act(`Put Oracle's dates back on '${item.title}'`, { op: "restore_dates", target: { item_id: item.id }, before: storedDates(item), after: {} })} className="font-medium text-accent-ink underline">
                    Restore
                  </button>
                </>
              )}
            </span>
          ) : (
            <span className="block text-sm text-text2">{from("end")}</span>
          )}
        </Row>
      </dl>
      <Clash c={c} late={late} lateMilestone={lateMilestone} added={added} />
    </div>
  );
}

type Dep = { item: Item; by: string | null; removed: boolean; removedBy: string | null; late: boolean };

function DepList({ c, title, deps, add, onRemove, onRestore, onAdd, adding }: { c: Ctx; title: string; deps: Dep[]; add: string; onRemove: (d: Dep) => void; onRestore: (d: Dep) => void; onAdd: () => void; adding: ReactNode }) {
  return (
    <div className="py-1" data-testid={`fp-list-${title === "Depends on" ? "depends" : "needed"}`}>
      <h4 className="text-sm text-text2">
        {title} <span className="tnum">({deps.filter((d) => !d.removed).length})</span>
      </h4>
      {/* An empty list says so in words, as the old card did (qa4-42). */}
      {deps.every((d) => d.removed) && (
        <p className="text-sm text-text2" data-testid="fp-empty">
          {title === "Depends on" ? "Nothing" : "None"}
        </p>
      )}
      <ul>
        {/* build-feature-panel review 3: as the frames list them, the live links first, then Oracle's removed ones. */}
        {[...deps].sort((a, b) => Number(a.removed) - Number(b.removed)).map((d) => (
          <li key={d.item.id} className="flex items-start gap-2 border-b border-line py-1.5 last:border-0" data-testid="fp-dep">
            <div className="min-w-0 flex-1">
              <span className={`block ${d.removed ? "text-text2 line-through" : "font-medium"}`}>{d.item.title}</span>
              <span className="block text-sm text-text2">
                {span(d.item.start.date, d.item.end.date)} ·{" "}
                {d.removed ? (
                  <>
                    Oracle&apos;s link, removed by {d.removedBy ?? "a person"}
                    {c.edit && (
                      <>
                        {" · "}
                        <button type="button" onClick={() => onRestore(d)} className="font-medium text-accent-ink underline">
                          Restore
                        </button>
                      </>
                    )}
                  </>
                ) : d.by ? (
                  `Added by ${d.by}`
                ) : (
                  "Found by Oracle"
                )}
              </span>
              {d.late && !d.removed && <span className="mt-0.5 inline-block rounded-full bg-crit-bg px-2 py-px text-xs font-medium text-crit">Ends after this starts</span>}
            </div>
            {c.edit && !d.removed && (
              <button type="button" aria-label={`Remove ${d.item.title}`} onClick={() => onRemove(d)} className="h-7 w-7 flex-none rounded text-text2 hover:bg-surface2">
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      {adding}
      {c.edit && (
        <button type="button" onClick={onAdd} className="mt-1 text-sm font-medium text-accent-ink hover:underline">
          + {add}
        </button>
      )}
    </div>
  );
}

/** "+ Add": a search across every roadmap; items already linked and links that would make a loop are shown, not offered. */
function Search({ c, side, onPick, onClose }: { c: Ctx; side: "depends" | "needed"; onPick: (other: Item) => void; onClose: () => void }) {
  const { item, items } = c;
  const [q, setQ] = useState("");
  const waits = (from: Item, on: Item): boolean => {
    // Whether `from` already waits on `on`, directly or through others.
    const seen = new Set<string>();
    const queue = [from.id];
    while (queue.length) {
      const cur = items.get(queue.shift()!);
      for (const d of cur?.depends_on ?? []) {
        if (d === on.id) return true;
        if (!seen.has(d)) {
          seen.add(d);
          queue.push(d);
        }
      }
    }
    return false;
  };
  const found = q.trim()
    ? [...items.values()]
        .filter((i) => i.id !== item.id && i.title.toLowerCase().includes(q.trim().toLowerCase()))
        .slice(0, 6)
        .map((i) => {
          const linked = side === "depends" ? item.depends_on.includes(i.id) : i.depends_on.includes(item.id);
          const loop = side === "depends" ? waits(i, item) : waits(item, i);
          const away = i.roadmap.id !== item.roadmap.id;
          const note = linked ? "Already linked" : loop ? (side === "depends" ? "Needs this one: it would make a loop" : "This one needs it: it would make a loop") : away ? "On another roadmap: links join items of one roadmap" : "";
          return { i, note };
        })
        .sort((a, b) => Number(!!a.note) - Number(!!b.note))
    : [];
  return (
    <div className="my-2 rounded-lg border border-line-strong bg-surface p-2 shadow-tip" data-testid="fp-search">
      <input autoFocus aria-label="Find an item" placeholder="Type an item's name" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onClose())} className="h-9 w-full rounded-md border-2 border-accent bg-surface px-2 text-[15px]" />
      {found.length > 0 && (
        <ul className="mt-1">
          {found.map(({ i, note }, n) => (
            <li key={i.id}>
              <button type="button" disabled={!!note} onClick={() => onPick(i)} className={`block w-full rounded px-2 py-1.5 text-left ${n === 0 && !note ? "bg-surface2" : ""} ${note ? "cursor-default text-text2" : "hover:bg-surface2"}`}>
                <span className="block">{i.title}</span>
                <span className="block text-sm text-text2">
                  {span(i.start.date, i.end.date)} · {i.roadmap.title}
                  {note && ` · ${note}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {q.trim() && !found.length && <p className="px-2 py-1.5 text-sm text-text2">No item is called that.</p>}
    </div>
  );
}

function Links({ c, late, onAdded }: { c: Ctx; late: Item[]; onAdded: (i: Item) => void }) {
  const { item, items, act } = c;
  const [adding, setAdding] = useState<"depends" | "needed" | null>(null);
  const dependsOn: Dep[] = (item.links.length ? item.links : item.depends_on.map((id) => ({ item_id: id, by: null, removed: false, removed_by: null })))
    .map((l) => ({ l, it: items.get(l.item_id) }))
    .filter((x): x is { l: (typeof item.links)[number]; it: Item } => !!x.it)
    .map(({ l, it }) => ({ item: it, by: l.by ?? null, removed: !!l.removed, removedBy: l.removed_by ?? null, late: late.includes(it) }));
  const neededBy: Dep[] = [...items.values()].flatMap((o) => {
    const l = o.links.find((x) => x.item_id === item.id) ?? (o.depends_on.includes(item.id) ? { item_id: item.id, by: null, removed: false, removed_by: null } : null);
    return l ? [{ item: o, by: l.by ?? null, removed: !!l.removed, removedBy: l.removed_by ?? null, late: false }] : [];
  });
  // build-feature-panel review 3 (FP3 A done): a new link says where the item now starts when it moved to start after it.
  const added = async (from: Item, to: Item) => {
    const now = (await unwrap(api.GET("/v1/simple/roadmap", {}))).items.find((i: Item) => i.id === from.id);
    const moved = now && now.start.date !== from.start.date && now.start.date > to.end.date;
    return `${from.title} now depends on ${to.title}${moved ? `, and starts after it: ${span(now.start.date, now.end.date)}` : ""}.`;
  };
  const link = (op: "add_link" | "remove_link" | "restore_link", from: Item, to: Item, what: string) =>
    act(what, { op, target: { item_id: from.id, subject: to.id }, before: { depends_on: depKeys(from, items) }, after: {} }, op === "add_link" ? { words: () => added(from, to) } : op === "remove_link" ? { words: () => `Removed the link: ${from.title} no longer depends on ${to.title}` } : undefined);
  return (
    <div>
      <DepList
        c={c}
        title="Depends on"
        deps={dependsOn}
        add="Add an item it depends on"
        onAdd={() => setAdding(adding === "depends" ? null : "depends")}
        onRemove={(d) => void link("remove_link", item, d.item, `Removed the link to '${d.item.title}'`)}
        onRestore={(d) => void link("restore_link", item, d.item, `Put back the link to '${d.item.title}'`)}
        adding={adding === "depends" && <Search c={c} side="depends" onClose={() => setAdding(null)} onPick={(o) => (setAdding(null), onAdded(o), void link("add_link", item, o, `'${item.title}' now depends on '${o.title}'`))} />}
      />
      <DepList
        c={c}
        title="Needed by"
        deps={neededBy}
        add="Add an item that needs it"
        onAdd={() => setAdding(adding === "needed" ? null : "needed")}
        onRemove={(d) => void link("remove_link", d.item, item, `Removed the link from '${d.item.title}'`)}
        onRestore={(d) => void link("restore_link", d.item, item, `Put back the link from '${d.item.title}'`)}
        adding={adding === "needed" && <Search c={c} side="needed" onClose={() => setAdding(null)} onPick={(o) => (setAdding(null), void link("add_link", o, item, `'${o.title}' now depends on '${item.title}'`))} />}
      />
    </div>
  );
}

export function FeaturePanel({ item, items, act, canChange, phone, onClose, talk, more, onSuggest, testId = "feature-panel" }: { item: Item; items: Map<string, Item>; act: Act; canChange: boolean; phone: boolean; onClose: () => void; talk: ReactNode; more?: ReactNode; onSuggest?: () => void; testId?: string }) {
  const [tab, setTab] = useState<"details" | "talk">("details");
  // The link added here last: while it is late, the clash offers to remove it.
  const [added, setAdded] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", k);
    ref.current?.focus({ preventScroll: true });
    return () => removeEventListener("keydown", k);
  }, [onClose]);
  const c: Ctx = { item, items, act, edit: canChange };
  // A cut item sits below the line: its date clash and the fixes for it no longer apply (qa4-13).
  const cut = item.status === "cut";
  const late = useMemo(() => (cut ? [] : lateLinks(item, items)), [cut, item, items]);
  const lateMilestone = !cut && item.flags.some((f) => f.kind === "outside_milestone" && f.state === "red");
  const addedItem = added && late.some((d) => d.id === added) ? (items.get(added) ?? null) : null;
  const clash = late.length > 0 || lateMilestone;
  const head = (
    <div>
      <div className="flex items-start gap-2">
        {/* review 7: the name is changed in place, as every other field. */}
        <h2 className="min-w-0 flex-1 text-lg leading-6 font-semibold break-words" title={item.title} aria-label={item.title}>
          <Title c={c} />
        </h2>
        <button type="button" aria-label="Close" onClick={onClose} className="h-8 w-8 flex-none rounded text-text2 hover:bg-surface2">
          ×
        </button>
      </div>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text2">
        <span className="rounded-full bg-accent-soft px-2 py-px font-medium text-accent-ink" data-testid="fp-status">{statusWord(item.status)}</span>
        {item.owner && <span>Owner {item.owner.name}</span>}
        {item.owner && item.confidence && <span aria-hidden>·</span>}
        {item.confidence && <span data-testid="fp-confidence">{confidenceWord(item.confidence)} confidence</span>}
        {clash && <span className="rounded-full bg-crit-bg px-2 py-px font-medium text-crit" data-testid="fp-clash-flag">Dates clash</span>}
      </p>
      {!canChange && (
        <p className="mt-2 rounded-lg bg-surface2 px-3 py-2 text-sm text-text2" data-testid="fp-read-only">
          You can read this feature. Its owner and approvers can change it.{" "}
          <button type="button" onClick={() => (setTab("talk"), onSuggest?.())} className="font-medium text-accent-ink underline">
            Suggest a change
          </button>
        </p>
      )}
    </div>
  );
  const body = (
    <div>
      <Section title="Dates" id="dates">
        <Dates c={c} late={late} lateMilestone={lateMilestone} added={addedItem} />
      </Section>
      <Section title="Goal" id="goal">
        <GoalFields c={c} />
      </Section>
      <Section title="Links" id="links">
        <Links c={c} late={late} onAdded={(o) => setAdded(o.id)} />
      </Section>
      <Section title="Milestone" id="milestone">
        <dl>
          <Row label="Milestone">
            <MilestoneField c={c} />
          </Row>
        </dl>
      </Section>
      <Section title="Details" id="details">
        <dl>
          <Row label="Outcome">
            <Field label="Outcome" value={item.outcome ?? ""} shown={item.outcome ?? <span className="text-text2">Not written yet</span>} edit={canChange} multiline onSave={async (v) => (await act(`Changed the outcome of '${item.title}'`, { op: "edit_outcome", target: { item_id: item.id }, before: { outcome: item.outcome ?? null }, after: { outcome: v.trim() || null } }), null)} testId="fp-outcome" />
          </Row>
          <Row label="Status">{statusWord(item.status)}</Row>
          <Row label="Owner">
            <Owner c={c} />
          </Row>
          <Row label="Effort">
            <Effort c={c} />
          </Row>
          <Row label="Confidence">{item.confidence ? confidenceWord(item.confidence) : "Not rated"}</Row>
          {/* build-feature-panel review 3: the Notes row the picked frames draw (edit_note). */}
          <Row label="Notes">
            <Field label="Notes" value={item.note ?? ""} shown={item.note ?? <span className="text-text2">No notes yet</span>} edit={canChange} multiline onSave={async (v) => (v.trim() === (item.note ?? "") ? null : (await act(`Changed the notes of '${item.title}'`, { op: "edit_note", target: { item_id: item.id }, before: { note: item.note ?? null }, after: { note: v.trim() || null } }), null))} testId="fp-notes" />
          </Row>
        </dl>
      </Section>
      {more}
    </div>
  );
  const talkCol = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {talk}
    </div>
  );
  // The rail stays usable under the dimmed page: a click on one of its links closes the panel and goes there (fix4).
  const backdrop = (
    <div
      aria-hidden
      data-testid="feature-panel-backdrop"
      onClick={(e) => {
        const link = document.elementsFromPoint(e.clientX, e.clientY).map((el) => el.closest<HTMLAnchorElement>('nav[aria-label="Simple"] a[href]')).find(Boolean);
        onClose();
        link?.click();
      }}
      className="fixed inset-0 z-[55] bg-black/30"
    />
  );
  const base = "fixed z-[60] flex flex-col overflow-hidden border-line bg-surface text-[15px] leading-[22px] text-text shadow-tip outline-none";
  if (phone)
    return (
      <SaveWord.Provider value={item.can_decide ? "Save" : "Propose"}>
        {backdrop}
        <aside ref={ref} tabIndex={-1} role="dialog" aria-label={item.title} data-testid={testId} data-sheet="full" className={`${base} inset-0`}>
          <div className="flex-none border-b border-line px-4 pt-3.5 pb-2.5">
            {head}
            <div role="tablist" aria-label="The feature" className="mt-2.5 flex gap-1 rounded-lg bg-surface2 p-1 text-sm">
              {(["details", "talk"] as const).map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} type="button" onClick={() => setTab(t)} className={`flex-1 rounded-md px-2 py-1 ${tab === t ? "bg-surface font-medium shadow-sm" : "text-text2"}`}>
                  {t === "details" ? "Details" : "Talk to Oracle"}
                </button>
              ))}
            </div>
          </div>
          {tab === "talk" ? (
            <div role="tabpanel" aria-label="Talk to Oracle" className="flex min-h-0 flex-1 flex-col">
              {talkCol}
            </div>
          ) : (
            <div role="tabpanel" aria-label="Details" className="min-h-0 flex-1 overflow-y-auto px-4 pb-6" data-testid="fp-details">
              {body}
            </div>
          )}
        </aside>
      </SaveWord.Provider>
    );
  return (
    <SaveWord.Provider value={item.can_decide ? "Save" : "Propose"}>
      {backdrop}
      <aside ref={ref} tabIndex={-1} role="dialog" aria-label={item.title} data-testid={testId} data-sheet="panel" className={`${base} top-4 right-4 bottom-4 w-[880px] max-w-[calc(100vw-32px)] rounded-xl border`}>
        <div className="flex-none border-b border-line px-4 pt-3.5 pb-2.5">{head}</div>
        <div className="grid min-h-0 flex-1 grid-cols-[460px_minmax(0,1fr)]">
          <div className="min-h-0 overflow-y-auto border-r border-line px-4 pb-4" data-testid="fp-details">
            {body}
          </div>
          {talkCol}
        </div>
      </aside>
    </SaveWord.Provider>
  );
}
