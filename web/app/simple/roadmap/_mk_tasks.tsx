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
  // MOCK-HOOK: the people a task can be given to.
  return useQuery("mk-members", () => unwrap(api.GET("/v1/members", {})).then((m) => (m as { id: string; name?: string | null; email: string }[]).map((x) => ({ id: x.id, name: x.name ?? x.email }))));
}

/** MOCK-HOOK: the change each control sends, worded as Save or Propose by the item's own can_decide. */
function useSend(item: Item, act: Act) {
  const verb = item.can_decide ? "Save" : "Propose"; // MOCK-HOOK
  const add = (title: string, owner: { id: string; name: string } | null, due: string | null) =>
    act(`Task added: “${title}”`, { op: "add_item_task", target: { item_id: item.id }, before: {}, after: { title, owner_id: owner?.id ?? null, owner_name: owner?.name ?? null, due_date: due } } as never); // MOCK-HOOK
  const edit = (t: Task, after: Record<string, unknown>) =>
    act(`Task changed: “${t.title}”`, { op: "edit_item_task", target: { item_id: item.id, task_id: t.id }, before: { title: t.title, owner_id: t.owner?.id ?? null, due_date: t.due_date }, after } as never); // MOCK-HOOK
  const status = (t: Task, s: Status) =>
    act(s === "dropped" ? `Task dropped: “${t.title}”` : `“${t.title}” is ${WORDS[s].toLowerCase()}`, { op: "set_item_task_status", target: { item_id: item.id, task_id: t.id }, before: { status: t.status }, after: { status: s } } as never); // MOCK-HOOK
  return { verb, add, edit, status };
}

function Pill({ s }: { s: Status }) {
  return <span className={`rounded-full px-2 py-px text-[12px] font-semibold ${TONE[s]}`}>{WORDS[s]}</span>; // MOCK-HOOK
}

const meta = (t: Task) => `${t.owner ? t.owner.name : "No owner"}${t.due_date ? ` · due ${formatDay(t.due_date)}` : ""}`; // MOCK-HOOK
const FIELD = "h-8 rounded-md border border-line bg-surface px-2 text-[14px]"; // MOCK-HOOK
const GHOST = "rounded px-1 text-left hover:bg-surface2 focus-visible:bg-surface2"; // MOCK-HOOK

/** MOCK-HOOK: the Tasks part, drawn as the URL's variant. */
export function MkTasks({ v, item, act, canChange }: { v: string; item: Item; act: Act; canChange: boolean }) {
  const tasks = item.tasks; // MOCK-HOOK
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
      {item.tasks.map((t) => {
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
              <select aria-label={`Status of ${t.title}`} className={`ml-auto h-7 w-auto rounded-full border-0 px-2 text-[12px] font-semibold ${TONE[t.status]}`} value={t.status} onChange={(e) => void send.status(t, e.target.value as Status)}>
                {(Object.keys(WORDS) as Status[]).map((s) => <option key={s} value={s}>{s === "dropped" ? "Drop this task" : WORDS[s]}</option>)}
              </select>
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
      {item.tasks.map((t) => (
        <li key={t.id} data-testid="card-task" className="group relative flex items-start gap-2 rounded-md px-1 py-1 hover:bg-surface2">
          <input
            type="checkbox"
            aria-label={`${t.title} is done`}
            className="mt-1 size-4 accent-[var(--color-accent)]"
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
            <div role="menu" className="absolute top-8 right-0 z-10 w-48 rounded-lg border border-line bg-surface p-1 shadow-lg">
              {t.status !== "doing" && <MenuItem onClick={() => (setMenu(null), void send.status(t, "doing"))}>Mark as doing</MenuItem>}
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
        {item.tasks.map((t) => (
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
              <div role="menu" className="absolute top-7 right-0 z-10 w-48 rounded-lg border border-line bg-surface p-1 shadow-lg">
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
        onSave({ title: String(d.get("title") ?? "").trim(), owner_id: owner || null, owner_name: members.data?.find((m) => m.id === owner)?.name ?? null, due_date: String(d.get("due") ?? "") || null });
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
      <input id="mk-d" name="due" type="date" defaultValue={task?.due_date ?? ""} className={FIELD} />
      <span />
      <span className="flex gap-2">
        <Button className="!h-8" type="submit" variant="primary">{verb}</Button>
        <Button className="!h-8" onClick={onCancel}>Cancel</Button>
      </span>
    </form>
  );
}

/** MOCK-HOOK ec1 D: one Edit button turns the whole list into a table; Save sends every changed row. */
function EditList({ item, act, canChange }: P) {
  const send = useSend(item, act); // MOCK-HOOK
  const members = useMembers(); // MOCK-HOOK
  const [on, setOn] = useState(false); // MOCK-HOOK
  const [rows, setRows] = useState<Record<string, { title: string; owner: string; due: string; status: Status }>>({}); // MOCK-HOOK
  const [fresh, setFresh] = useState<string[]>([]); // MOCK-HOOK
  const start = () => {
    setRows(Object.fromEntries(item.tasks.map((t) => [t.id, { title: t.title, owner: t.owner?.id ?? "", due: t.due_date ?? "", status: t.status }])));
    setFresh([]);
    setOn(true);
  }; // MOCK-HOOK
  const save = async () => {
    for (const t of item.tasks) {
      const r = rows[t.id];
      if (!r) continue;
      if (r.title !== t.title || r.owner !== (t.owner?.id ?? "") || r.due !== (t.due_date ?? "")) await send.edit(t, { title: r.title, owner_id: r.owner || null, owner_name: members.data?.find((m) => m.id === r.owner)?.name ?? null, due_date: r.due || null });
      if (r.status !== t.status) await send.status(t, r.status);
    }
    for (const f of fresh) if (f.trim()) await send.add(f.trim(), null, null);
    setOn(false);
  }; // MOCK-HOOK
  if (!on)
    return (
      <>
        <ul className="mt-1 space-y-1">
          {item.tasks.map((t) => (
            <li key={t.id} data-testid="card-task" className="[overflow-wrap:anywhere]">
              {t.title}
              <span className="text-text2"> · {meta(t)} · {WORDS[t.status]}</span>
            </li>
          ))}
        </ul>
        {canChange && <Button className="mt-2 !h-8" onClick={start}>Edit tasks</Button>}
      </>
    ); // MOCK-HOOK
  const set = (id: string, k: string, v: string) => setRows((r) => ({ ...r, [id]: { ...r[id], [k]: v } })); // MOCK-HOOK
  return (
    <div className="mt-1 overflow-x-auto" data-testid="mk-task-table">
      <table className="w-full min-w-[560px] text-[14px]">
        <thead>
          <tr className="text-left text-[12px] text-text2">
            <th className="py-1 font-semibold">Task</th>
            <th className="font-semibold">Owner</th>
            <th className="font-semibold">Due</th>
            <th className="font-semibold">Status</th>
          </tr>
        </thead>
        <tbody>
          {item.tasks.filter((t) => rows[t.id]).map((t) => (
            <tr key={t.id}>
              <td className="py-0.5 pr-1"><input aria-label="Task" className={`${FIELD} w-full`} value={rows[t.id].title} onChange={(e) => set(t.id, "title", e.target.value)} /></td>
              <td className="pr-1">
                <select aria-label="Owner" className={FIELD} value={rows[t.id].owner} onChange={(e) => set(t.id, "owner", e.target.value)}>
                  <option value="">No owner</option>
                  {(members.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </td>
              <td className="pr-1"><input aria-label="Due" type="date" className={FIELD} value={rows[t.id].due} onChange={(e) => set(t.id, "due", e.target.value)} /></td>
              <td>
                <select aria-label="Status" className={FIELD} value={rows[t.id].status} onChange={(e) => set(t.id, "status", e.target.value)}>
                  {(Object.keys(WORDS) as Status[]).map((s) => <option key={s} value={s}>{WORDS[s]}</option>)}
                </select>
              </td>
            </tr>
          ))}
          {fresh.map((f, i) => (
            <tr key={`n${i}`}>
              <td className="py-0.5 pr-1" colSpan={4}><input autoFocus aria-label="New task" className={`${FIELD} w-full`} value={f} onChange={(e) => setFresh((x) => x.map((y, j) => (j === i ? e.target.value : y)))} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button className="!h-8" onClick={() => setFresh((x) => [...x, ""])}>Add a row</Button>
        <span className="flex-1" />
        <Button className="!h-8" onClick={() => setOn(false)}>Cancel</Button>
        <Button className="!h-8" variant="primary" onClick={() => void save()}>{item.can_decide ? "Save all" : "Propose all"}</Button>
      </div>
    </div>
  );
}
