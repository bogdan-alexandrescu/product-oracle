"use client";
// MOCK-HOOK mk-edit-tasks-restore (Decision 1, ?ec1=a|b|c|d): four ways to add, edit, set the
// status of and drop the tasks under a feature, inside the feature panel. Mock-ups only.

import { useEffect, useRef, useState } from "react"; // MOCK-HOOK

import { Button } from "@/components/ds"; // MOCK-HOOK
import { api, unwrap } from "@/lib/api/client"; // MOCK-HOOK
import { formatDay } from "@/lib/format"; // MOCK-HOOK
import { useQuery } from "@/lib/use-query"; // MOCK-HOOK

import type { Act } from "./_card"; // MOCK-HOOK
import type { Item } from "./_lib"; // MOCK-HOOK

type Task = Item["tasks"][number]; // MOCK-HOOK
const MK_PEOPLE = ["Avery Stone", "Priya Raman", "Theo Brandt", "Lena Ortiz"].map((name) => ({ id: `mk-${name}`, name, email: "" })); // MOCK-HOOK
type Status = Task["status"]; // MOCK-HOOK
const WORDS: Record<Status, string> = { todo: "To do", doing: "Doing", done: "Done", dropped: "Dropped" }; // MOCK-HOOK
const TONE: Record<Status, string> = { todo: "bg-surface2 text-text2", doing: "bg-accent-soft text-accent-ink", done: "bg-pass-bg text-pass", dropped: "bg-surface2 text-text2 line-through" }; // MOCK-HOOK

/** MOCK-HOOK: the variant the URL picks (?ec1=a|b|c|d), else none (the panel as built). */
export function useEc1(): string | null {
  const [v, setV] = useState<string | null>(null); // MOCK-HOOK
  useEffect(() => setV(new URLSearchParams(window.location.search).get("ec1")), []); // MOCK-HOOK
  return v; // MOCK-HOOK
}

function useMembers() {
  // MOCK-HOOK: the people a task can be given to (a role that cannot list members picks from the company's people the mock knows).
  return useQuery("mk-members", () => unwrap(api.GET("/v1/members", {})).catch(() => MK_PEOPLE).then((m) => (m as { id: string; name?: string | null; email: string; status?: string }[]).filter((x) => x.status !== "disabled").map((x) => ({ id: x.id, name: x.name ?? x.email }))));
}

/** MOCK-HOOK: the change each control sends, worded as Save or Propose by the item's own can_decide. */
function useSend(item: Item, act: Act) {
  const verb = item.can_decide ? "Save" : "Propose"; // MOCK-HOOK
  const add = (title: string, owner: { id: string; name: string } | null, due: string | null) =>
    act(`Task added: “${title}”`, { op: "add_item_task", target: { item_id: item.id }, before: {}, after: { title, owner_id: owner?.id ?? null, owner_name: owner?.name ?? null, due_date: due } } as never); // MOCK-HOOK
  const edit = (t: Task, after: Record<string, unknown>) =>
    act(`Task changed: “${t.title}”`, { op: "edit_item_task", target: { item_id: item.id, task_id: t.id }, before: { title: t.title, owner_id: t.owner?.id ?? null, due_date: t.due_date }, after } as never); // MOCK-HOOK
  const status = (t: Task, s: Status) =>
    act(
      s === "dropped" ? `“${t.title}” went to Trash` : `“${t.title}” is ${WORDS[s].toLowerCase()}`,
      { op: "set_item_task_status", target: { item_id: item.id, task_id: t.id }, before: { status: t.status, title: t.title }, after: { status: s } } as never,
      s === "dropped" && item.can_decide ? { words: () => `“${t.title}” went to Trash` } : undefined,
    ); // MOCK-HOOK
  return { verb, add, edit, status };
}

function Pill({ s }: { s: Status }) {
  return <span className={`rounded-full px-2 py-px text-[12px] font-semibold ${TONE[s]}`}>{WORDS[s]}</span>; // MOCK-HOOK
}

/** MOCK-HOOK: a proposed task change in words ('Add the task "…"', 'Change …', 'Set … to Done'), else null. */
export function mkTaskWords(c: { op: string; before?: unknown; after?: unknown }): string | null {
  const b = (c.before ?? {}) as Record<string, string | null>; // MOCK-HOOK
  const a = (c.after ?? {}) as Record<string, string | null>; // MOCK-HOOK
  if (c.op === "add_item_task") return `Add the task “${a.title}”`; // MOCK-HOOK
  if (c.op === "set_item_task_status") return a.status === "dropped" ? `Drop the task “${b.title}”` : `Set “${b.title}” to ${WORDS[a.status as Status] ?? a.status}`; // MOCK-HOOK
  if (c.op !== "edit_item_task") return null; // MOCK-HOOK
  if (a.title && a.title !== b.title) return `Change “${b.title}” to “${a.title}”`; // MOCK-HOOK
  if ("owner_id" in a && a.owner_id !== b.owner_id) return `Change the owner of “${b.title}” to ${a.owner_name ?? "no one"}`; // MOCK-HOOK
  if ("due_date" in a && a.due_date !== b.due_date) return `Change the due date of “${b.title}” to ${a.due_date ? formatDay(a.due_date) : "none"}`; // MOCK-HOOK
  return `Change the task “${b.title}”`; // MOCK-HOOK
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]; // MOCK-HOOK
/** MOCK-HOOK: "Nov 2" (as a person types a day) to the API's 2026-11-02; null when it reads as no day. */
const parseDay = (v: string): string | null => {
  const m = /^\s*([a-z]{3})[a-z]*\.?\s+(\d{1,2})\s*$/i.exec(v); // MOCK-HOOK
  const i = m ? MONTHS.findIndex((x) => x.toLowerCase() === m[1].toLowerCase()) : -1; // MOCK-HOOK
  return m && i >= 0 ? `2026-${String(i + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}` : null; // MOCK-HOOK
};
const shown = (iso: string | null | undefined) => (iso ? formatDay(iso) : ""); // MOCK-HOOK
const live = (item: Item) => item.tasks.filter((t) => t.status !== "dropped"); // MOCK-HOOK a dropped task leaves the list (Settings › Trash has it)

const meta = (t: Task) => `${t.owner ? t.owner.name : "No owner"}${t.due_date ? ` · due ${formatDay(t.due_date)}` : ""}`; // MOCK-HOOK
const FIELD = "h-8 rounded-md border border-line bg-surface px-2 text-[14px]"; // MOCK-HOOK
const GHOST = "rounded px-1 text-left hover:bg-surface2 focus-visible:bg-surface2"; // MOCK-HOOK

/** MOCK-HOOK: the Tasks part, drawn as the URL's variant. */
export function MkTasks({ v, item, act, canChange }: { v: string; item: Item; act: Act; canChange: boolean }) {
  const tasks = live(item); // MOCK-HOOK
  const title = (
    <h3 className="text-[12px] leading-4 font-semibold tracking-[.06em] text-text2 uppercase">
      Tasks{tasks.length ? ` · ${tasks.filter((t) => t.status === "done").length} of ${tasks.length} done` : ""}
    </h3>
  ); // MOCK-HOOK
  const body =
    v === "a" ? <InPlace item={item} act={act} canChange={canChange} /> : v === "b" ? <Checklist item={item} act={act} canChange={canChange} /> : v === "c" ? <RowMenu item={item} act={act} canChange={canChange} /> : <EditList item={item} act={act} canChange={canChange} />; // MOCK-HOOK
  return (
    <section className="mt-3" data-testid="card-tasks" data-mk-ec1={v}>
      {title}
      {body}
    </section>
  ); // MOCK-HOOK
}

type P = { item: Item; act: Act; canChange: boolean }; // MOCK-HOOK

/** MOCK-HOOK ec1 A: each part of a row is edited where it is, like the panel's other fields; a small add row at the end. */
function InPlace({ item, act, canChange }: P) {
  const send = useSend(item, act); // MOCK-HOOK
  const members = useMembers(); // MOCK-HOOK
  const [open, setOpen] = useState<string | null>(null); // MOCK-HOOK "<task id>:<field>"
  const [draft, setDraft] = useState(""); // MOCK-HOOK
  const [adding, setAdding] = useState(false); // MOCK-HOOK
  const close = () => {
    setOpen(null);
    setDraft("");
  }; // MOCK-HOOK
  return (
    <ul className="mt-1 divide-y divide-line">
      {live(item).map((t) => {
        const at = (f: string) => open === `${t.id}:${f}`; // MOCK-HOOK
        return (
          <li key={t.id} data-testid="card-task" className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-1.5">
            <span className="w-full min-w-0 [overflow-wrap:anywhere]">
              {at("title") ? (
                <form
                  className="flex gap-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (draft.trim()) void send.edit(t, { title: draft.trim() });
                    close();
                  }}
                >
                  <input autoFocus aria-label="Task title" className={`${FIELD} min-w-0 flex-1`} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Escape" && close()} />
                  <Button className="!h-8" type="submit" variant="primary">{send.verb}</Button>
                </form>
              ) : canChange ? (
                <button type="button" className={GHOST} aria-label={`Change the title of ${t.title}`} onClick={() => (setOpen(`${t.id}:title`), setDraft(t.title))}>
                  {t.title}
                </button>
              ) : (
                t.title
              )}
            </span>
            <span className="flex items-center gap-1 text-[14px] text-text2">
              {at("owner") ? (
                <span className="relative">
                  <span className="rounded px-1 ring-2 ring-accent">{t.owner ? t.owner.name : "No owner"}</span>
                  <span role="listbox" aria-label="Owner" className="absolute top-7 left-0 z-20 w-52 rounded-lg border border-line bg-surface p-1 text-text shadow-lg">
                    {[{ id: "", name: "No owner" }, ...(members.data ?? [])].map((m) => (
                      <button key={m.id} type="button" role="option" aria-selected={(t.owner?.id ?? "") === m.id} className="block w-full rounded px-2 py-1.5 text-left hover:bg-surface2 aria-selected:font-semibold" onClick={() => (void send.edit(t, { owner_id: m.id || null, owner_name: m.id ? m.name : null }), close())}>
                        {m.name}
                      </button>
                    ))}
                  </span>
                </span>
              ) : canChange ? (
                <button type="button" className={GHOST} aria-label={`Change the owner of ${t.title}`} onClick={() => setOpen(`${t.id}:owner`)}>{t.owner ? t.owner.name : "No owner"}</button>
              ) : (
                <span>{t.owner ? t.owner.name : "No owner"}</span>
              )}
              ·
              {at("due") ? (
                <input autoFocus type="date" aria-label="Due date" className={FIELD} defaultValue={t.due_date ?? ""} onChange={(e) => (void send.edit(t, { due_date: e.target.value || null }), close())} onBlur={close} />
              ) : canChange ? (
                <button type="button" className={GHOST} aria-label={`Change the due date of ${t.title}`} onClick={() => setOpen(`${t.id}:due`)}>{t.due_date ? `due ${formatDay(t.due_date)}` : "No due date"}</button>
              ) : (
                <span>{t.due_date ? `due ${formatDay(t.due_date)}` : "No due date"}</span>
              )}
            </span>
            {canChange ? (
              <span className="relative ml-auto">
                <button type="button" aria-label={`Status of ${t.title}`} aria-expanded={at("status")} className={`h-7 rounded-full px-2.5 text-[12px] font-semibold ${TONE[t.status]} ${at("status") ? "ring-2 ring-accent" : ""}`} onClick={() => (at("status") ? close() : setOpen(`${t.id}:status`))}>
                  {WORDS[t.status]} ▾
                </button>
                {at("status") && (
                  <span role="listbox" aria-label={`Status of ${t.title}`} className="absolute top-8 right-0 z-20 w-44 rounded-lg border border-line bg-surface p-1 text-[14px] text-text shadow-lg">
                    {(["todo", "doing", "done"] as Status[]).map((s) => (
                      <button key={s} type="button" role="option" aria-selected={t.status === s} className="block w-full rounded px-2 py-1.5 text-left hover:bg-surface2 aria-selected:font-semibold" onClick={() => (close(), s !== t.status && void send.status(t, s))}>
                        {WORDS[s]}
                      </button>
                    ))}
                    <span aria-hidden className="my-1 block border-t border-line" />
                    <button type="button" role="option" aria-selected={false} className="block w-full rounded px-2 py-1.5 text-left text-crit hover:bg-surface2" onClick={() => (close(), void send.status(t, "dropped"))}>
                      Drop this task
                    </button>
                  </span>
                )}
              </span>
            ) : (
              <span className="ml-auto"><Pill s={t.status} /></span>
            )}
          </li>
        );
      })}
      {canChange && (
        <li className="py-1.5">
          {adding ? (
            <form
              className="flex gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                if (draft.trim()) void send.add(draft.trim(), null, null);
                setDraft("");
              }}
            >
              <input autoFocus aria-label="New task" placeholder="What needs doing" className={`${FIELD} min-w-0 flex-1`} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Escape" && (setAdding(false), setDraft(""))} />
              <Button className="!h-8" type="submit" variant="primary">{item.can_decide ? "Add" : "Propose"}</Button>
            </form>
          ) : (
            <button type="button" className="text-[14px] font-semibold text-accent-ink hover:underline" onClick={() => setAdding(true)}>+ Add a task</button>
          )}
        </li>
      )}
    </ul>
  );
}

/** MOCK-HOOK ec1 B: a checklist: the tick sets done; a row's menu has Doing, Change and Drop; the add box is always there. */
function Checklist({ item, act, canChange }: P) {
  const send = useSend(item, act); // MOCK-HOOK
  const [menu, setMenu] = useState<string | null>(null); // MOCK-HOOK
  const [draft, setDraft] = useState(""); // MOCK-HOOK
  const [editing, setEditing] = useState<string | null>(null); // MOCK-HOOK
  return (
    <ul className="mt-1">
      {live(item).map((t) => (
        <li key={t.id} data-testid="card-task" className="group relative flex items-start gap-2 rounded-md px-1 py-1 hover:bg-surface2 max-[600px]:flex-wrap">
          <input
            type="checkbox"
            aria-label={`${t.title} is done`}
            className="mt-1 size-4 accent-[var(--color-accent)] disabled:opacity-50"
            checked={t.status === "done"}
            disabled={!canChange}
            onChange={() => void send.status(t, t.status === "done" ? "todo" : "done")}
          />
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            {editing === t.id ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const v = (e.currentTarget.elements.namedItem("t") as HTMLInputElement).value.trim();
                  if (v) void send.edit(t, { title: v });
                  setEditing(null);
                }}
                className="flex gap-1"
              >
                <input autoFocus name="t" aria-label="Task title" defaultValue={t.title} className={`${FIELD} min-w-0 flex-1`} />
                <Button className="!h-8" type="submit" variant="primary">{send.verb}</Button>
              </form>
            ) : (
              <span className={t.status === "done" ? "text-text2 line-through" : ""}>{t.title}</span>
            )}
            <span className="block text-[13px] text-text2">
              {meta(t)}
              {t.status === "doing" && <> · <Pill s="doing" /></>}
            </span>
          </span>
          {canChange && (
            <button type="button" aria-label={`More for ${t.title}`} aria-expanded={menu === t.id} className="h-7 w-7 rounded text-text2 hover:bg-surface" onClick={() => setMenu(menu === t.id ? null : t.id)}>
              ⋯
            </button>
          )}
          {menu === t.id && (
            <div role="menu" className="absolute top-8 right-0 z-10 w-48 rounded-lg border border-line bg-surface p-1 shadow-lg max-[600px]:static max-[600px]:ml-6 max-[600px]:basis-full max-[600px]:shadow-none">
              <MenuItem onClick={() => (setMenu(null), void send.status(t, t.status === "doing" ? "todo" : "doing"))}>{t.status === "doing" ? "Mark as to do" : "Mark as doing"}</MenuItem>
              <MenuItem onClick={() => (setMenu(null), setEditing(t.id))}>Change the title</MenuItem>
              <MenuItem onClick={() => setMenu(null)}>Change owner or due date</MenuItem>
              <MenuItem danger onClick={() => (setMenu(null), void send.status(t, "dropped"))}>Drop this task</MenuItem>
            </div>
          )}
        </li>
      ))}
      {canChange && (
        <li className="mt-1 flex items-center gap-2 px-1">
          <span aria-hidden className="size-4 rounded border border-dashed border-line-strong" />
          <form
            className="flex min-w-0 flex-1 gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (draft.trim()) void send.add(draft.trim(), null, null);
              setDraft("");
            }}
          >
            <input aria-label="New task" placeholder="Add a task" className="h-8 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 text-[14px] hover:border-line focus:border-line" value={draft} onChange={(e) => setDraft(e.target.value)} />
            {draft && <Button className="!h-8" type="submit" variant="primary">{item.can_decide ? "Add" : "Propose"}</Button>}
          </form>
        </li>
      )}
    </ul>
  );
}

function MenuItem({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className={`block w-full rounded px-2 py-1.5 text-left text-[14px] hover:bg-surface2 ${danger ? "text-crit" : ""}`}>
      {children}
    </button>
  ); // MOCK-HOOK
}

/** MOCK-HOOK ec1 C: rows read as now; each has a menu (Change, a status, Drop); Change and Add open one small form. */
function RowMenu({ item, act, canChange }: P) {
  const send = useSend(item, act); // MOCK-HOOK
  const [menu, setMenu] = useState<string | null>(null); // MOCK-HOOK
  const [form, setForm] = useState<string | null>(null); // MOCK-HOOK task id or "new"
  return (
    <>
      <ul className="mt-1 space-y-1">
        {live(item).map((t) => (
          <li key={t.id} data-testid="card-task" className="relative">
            <div className="flex items-start gap-2">
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                {t.title}
                <span className="text-text2"> · {meta(t)} · </span>
                <Pill s={t.status} />
              </span>
              {canChange && (
                <button type="button" aria-label={`More for ${t.title}`} aria-expanded={menu === t.id} className="h-7 w-7 flex-none rounded text-text2 hover:bg-surface2" onClick={() => setMenu(menu === t.id ? null : t.id)}>
                  ⋯
                </button>
              )}
            </div>
            {menu === t.id && (
              <div role="menu" className="absolute top-7 right-0 z-10 w-48 rounded-lg border border-line bg-surface p-1 shadow-lg max-[600px]:static max-[600px]:mt-1 max-[600px]:w-auto max-[600px]:shadow-none">
                <MenuItem onClick={() => (setMenu(null), setForm(t.id))}>Change…</MenuItem>
                {(["todo", "doing", "done"] as Status[]).filter((s) => s !== t.status).map((s) => (
                  <MenuItem key={s} onClick={() => (setMenu(null), void send.status(t, s))}>Mark as {WORDS[s].toLowerCase()}</MenuItem>
                ))}
                <MenuItem danger onClick={() => (setMenu(null), void send.status(t, "dropped"))}>Drop this task</MenuItem>
              </div>
            )}
            {form === t.id && <TaskForm item={item} task={t} verb={send.verb} onCancel={() => setForm(null)} onSave={(f) => (setForm(null), void send.edit(t, f))} />}
          </li>
        ))}
      </ul>
      {canChange &&
        (form === "new" ? (
          <TaskForm item={item} verb={item.can_decide ? "Add" : "Propose"} onCancel={() => setForm(null)} onSave={(f) => (setForm(null), void send.add(String(f.title), f.owner_id ? { id: String(f.owner_id), name: String(f.owner_name) } : null, (f.due_date as string) || null))} />
        ) : (
          <Button className="mt-2 !h-8" onClick={() => setForm("new")}>Add a task</Button>
        ))}
    </>
  );
}

function TaskForm({ task, verb, onCancel, onSave }: { item: Item; task?: Task; verb: string; onCancel: () => void; onSave: (f: Record<string, unknown>) => void }) {
  const members = useMembers(); // MOCK-HOOK
  const ref = useRef<HTMLFormElement>(null); // MOCK-HOOK
  return (
    <form
      ref={ref}
      data-testid="mk-task-form"
      className="mt-2 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-surface2 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        const d = new FormData(e.currentTarget);
        const owner = String(d.get("owner") ?? "");
        onSave({ title: String(d.get("title") ?? "").trim(), owner_id: owner || null, owner_name: members.data?.find((m) => m.id === owner)?.name ?? null, due_date: parseDay(String(d.get("due") ?? "")) });
      }}
    >
      <label className="text-text2" htmlFor="mk-t">Task</label>
      <input id="mk-t" name="title" required autoFocus defaultValue={task?.title} className={FIELD} />
      <label className="text-text2" htmlFor="mk-o">Owner</label>
      <select id="mk-o" name="owner" defaultValue={task?.owner?.id ?? ""} className={FIELD}>
        <option value="">No owner</option>
        {(members.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
      <label className="text-text2" htmlFor="mk-d">Due</label>
      <input id="mk-d" name="due" placeholder="No due date" defaultValue={shown(task?.due_date)} className={`${FIELD} w-32`} />
      <span />
      <span className="flex gap-2">
        <Button className="!h-8" type="submit" variant="primary">{verb}</Button>
        <Button className="!h-8" onClick={onCancel}>Cancel</Button>
      </span>
    </form>
  );
}

/** MOCK-HOOK ec1 D: one Edit button turns the whole list into a table; Save sends every changed row. */
type Row = { title: string; owner: string; due: string; status: Status }; // MOCK-HOOK due as shown ("Oct 15")
function EditList({ item, act, canChange }: P) {
  const send = useSend(item, act); // MOCK-HOOK
  const members = useMembers(); // MOCK-HOOK
  const [on, setOn] = useState(false); // MOCK-HOOK
  const [rows, setRows] = useState<Record<string, Row>>({}); // MOCK-HOOK
  const [fresh, setFresh] = useState<Row[]>([]); // MOCK-HOOK
  const start = () => {
    setRows(Object.fromEntries(live(item).map((t) => [t.id, { title: t.title, owner: t.owner?.id ?? "", due: shown(t.due_date), status: t.status }]))); // MOCK-HOOK
    setFresh([]); // MOCK-HOOK
    setOn(true); // MOCK-HOOK
  };
  const name = (id: string) => members.data?.find((m) => m.id === id)?.name ?? null; // MOCK-HOOK
  const save = async () => {
    for (const t of live(item)) {
      const r = rows[t.id]; // MOCK-HOOK
      if (!r) continue;
      if (r.title !== t.title || r.owner !== (t.owner?.id ?? "") || r.due !== shown(t.due_date)) await send.edit(t, { title: r.title, owner_id: r.owner || null, owner_name: name(r.owner), due_date: parseDay(r.due) }); // MOCK-HOOK
      if (r.status !== t.status) await send.status(t, r.status); // MOCK-HOOK
    }
    for (const f of fresh) if (f.title.trim()) await send.add(f.title.trim(), f.owner ? { id: f.owner, name: name(f.owner) ?? "" } : null, parseDay(f.due)); // MOCK-HOOK
    setOn(false); // MOCK-HOOK
  };
  if (!on)
    return (
      <>
        <ul className="mt-1 space-y-1">
          {live(item).map((t) => (
            <li key={t.id} data-testid="card-task" className="[overflow-wrap:anywhere]">
              {t.title}
              <span className="text-text2"> · {meta(t)} · {WORDS[t.status]}</span>
            </li>
          ))}
        </ul>
        {canChange && <Button className="mt-2 !h-8" onClick={start}>Edit tasks</Button>}
      </>
    ); // MOCK-HOOK
  const SMALL = "h-8 w-full rounded-md border border-line bg-surface px-1.5 text-[13px]"; // MOCK-HOOK
  const cells = (r: Row, set: (k: keyof Row, v: string) => void, label: string) => (
    <>
      <td className="py-0.5 pr-1"><input aria-label={label} autoFocus={label === "New task"} className={SMALL} value={r.title} onChange={(e) => set("title", e.target.value)} /></td>
      <td className="pr-1">
        <select aria-label="Owner" className={SMALL} value={r.owner} onChange={(e) => set("owner", e.target.value)}>
          <option value="">No owner</option>
          {(members.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </td>
      <td className="pr-1"><input aria-label="Due" placeholder="None" className={SMALL} value={r.due} onChange={(e) => set("due", e.target.value)} /></td>
      <td>
        <select aria-label="Status" className={SMALL} value={r.status} onChange={(e) => set("status", e.target.value)}>
          {(Object.keys(WORDS) as Status[]).map((s) => <option key={s} value={s}>{s === "dropped" ? "Drop" : WORDS[s]}</option>)}
        </select>
      </td>
    </>
  ); // MOCK-HOOK
  return (
    <div className="mt-1" data-testid="mk-task-table">
      <table className="w-full table-fixed text-[14px]">
        <colgroup>
          <col />
          <col className="w-[28%]" />
          <col className="w-[16%]" />
          <col className="w-[20%]" />
        </colgroup>
        <thead>
          <tr className="text-left text-[12px] text-text2">
            <th className="py-1 font-semibold">Task</th>
            <th className="font-semibold">Owner</th>
            <th className="font-semibold">Due</th>
            <th className="font-semibold">Status</th>
          </tr>
        </thead>
        <tbody>
          {live(item).filter((t) => rows[t.id]).map((t) => (
            <tr key={t.id}>{cells(rows[t.id], (k, v) => setRows((r) => ({ ...r, [t.id]: { ...r[t.id], [k]: v } })), "Task")}</tr>
          ))}
          {fresh.map((f, i) => (
            <tr key={`n${i}`}>{cells(f, (k, v) => setFresh((x) => x.map((y, j) => (j === i ? { ...y, [k]: v } : y))), "New task")}</tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button className="!h-8" onClick={() => setFresh((x) => [...x, { title: "", owner: "", due: "", status: "todo" }])}>Add a row</Button>
        <span className="flex-1" />
        <Button className="!h-8" onClick={() => setOn(false)}>Cancel</Button>
        <Button className="!h-8" variant="primary" onClick={() => void save()}>{item.can_decide ? "Save all" : "Propose all"}</Button>
      </div>
    </div>
  );
}
