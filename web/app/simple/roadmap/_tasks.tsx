"use client";
// ec1 'Edit each row in place' (owner's pick, Nov 5): the feature panel's Tasks. Each part of a
// row is a control where it sits, as the panel's other fields are: the title retitles it, the
// owner picks a person, the date picks a day; the status pill opens To do, Doing, Done and, last,
// Drop this task. '+ Add a task' ends the list. Each save is one Simple change (Undo; a
// commenter's or a non-deciding approver's waits under Proposals on it). A viewer reads.

import { useEffect, useRef, useState } from "react";

import { api, unwrap } from "@/lib/api/client";
import { formatDay } from "@/lib/format";
import { useQuery } from "@/lib/use-query";

import type { Act } from "./_card";
import type { Item } from "./_lib";

type Task = Item["tasks"][number];
type Status = Task["status"];

const STATUS_WORDS: Record<Status, string> = {
  todo: "To do",
  doing: "Doing",
  done: "Done",
  dropped: "Dropped",
};
const PILL: Record<Status, string> = {
  todo: "bg-surface2 text-text2",
  doing: "bg-accent-soft text-accent-ink",
  done: "bg-pass-bg text-pass",
  dropped: "bg-surface2 text-text2",
};
const BIT = "rounded px-0.5 text-left hover:bg-surface2 hover:underline";
const INPUT = "rounded-md border border-line bg-surface px-2 py-1 text-[15px]";

/** A small menu under its control; a click away or Escape closes it. */
function Pop({
  label,
  onClose,
  children,
  className = "",
}: {
  label: string;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    const away = (e: MouseEvent) =>
      !ref.current?.contains(e.target as Node) && close.current();
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close.current();
    };
    document.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc, true);
    };
  }, []);
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className={`absolute z-50 mt-1 max-h-64 w-48 overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-tip ${className}`}
    >
      {children}
    </div>
  );
}

function Choice({
  label,
  onPick,
  warn,
  current,
}: {
  label: string;
  onPick: () => void;
  warn?: boolean;
  current?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`block w-full rounded-md px-2 py-1.5 text-left text-[15px] hover:bg-surface2 ${warn ? "text-warn" : ""} ${current ? "font-semibold" : ""}`}
      onClick={onPick}
    >
      {label}
    </button>
  );
}

function TaskRow({
  task,
  canChange,
  people,
  save,
}: {
  task: Task;
  canChange: boolean;
  people: { user_id: string; name: string }[];
  save: Save;
}) {
  const [open, setOpen] = useState<"title" | "owner" | "due" | "status" | null>(
    null,
  );
  const [title, setTitle] = useState(task.title);
  const owner = task.owner ? task.owner.name : "No owner";
  const due = task.due_date ? `due ${formatDay(task.due_date)}` : "No due date";
  const done = () => setOpen(null);
  if (!canChange)
    return (
      <li
        data-testid="card-task"
        className="border-b border-line py-1.5 last:border-b-0"
      >
        <div className="[overflow-wrap:anywhere]">{task.title}</div>
        <div className="flex items-center gap-2 text-[14px] text-text2">
          <span className="min-w-0 flex-1">
            {owner} · {due}
          </span>
          <span data-testid="task-status">{STATUS_WORDS[task.status]}</span>
        </div>
      </li>
    );
  return (
    <li
      data-testid="card-task"
      className="border-b border-line py-1.5 last:border-b-0"
    >
      {open === "title" ? (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            done();
            const t = title.trim();
            if (t && t !== task.title)
              void save.edit(task, { title: t }, `Retitled “${task.title}”`);
          }}
        >
          <input
            aria-label="Task title"
            className={`${INPUT} min-w-0 flex-1`}
            value={title}
            maxLength={200}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
          />
          <button
            type="submit"
            className="rounded-md bg-accent px-3 py-1 text-sm font-semibold text-white"
          >
            Save
          </button>
          <button
            type="button"
            className="text-sm font-semibold text-accent-ink hover:underline"
            onClick={done}
          >
            Cancel
          </button>
        </form>
      ) : (
        <button
          type="button"
          aria-label={`Retitle ${task.title}`}
          className={`${BIT} [overflow-wrap:anywhere]`}
          onClick={() => (setTitle(task.title), setOpen("title"))}
        >
          {task.title}
        </button>
      )}
      <div className="relative flex items-center gap-1 text-[14px] text-text2">
        <span className="relative min-w-0 flex-1">
          <button
            type="button"
            aria-label={`Owner of ${task.title}`}
            className={BIT}
            onClick={() => setOpen(open === "owner" ? null : "owner")}
          >
            {owner}
          </button>
          {" · "}
          {open === "due" ? (
            <input
              type="date"
              aria-label={`Due date of ${task.title}`}
              className={INPUT}
              defaultValue={task.due_date ?? ""}
              autoFocus
              onBlur={done}
              onChange={(e) => {
                const v = e.target.value || null;
                done();
                if (v !== (task.due_date ?? null))
                  void save.edit(
                    task,
                    { due_date: v },
                    `Due date of “${task.title}” changed`,
                  );
              }}
            />
          ) : (
            <button
              type="button"
              aria-label={`Due date of ${task.title}`}
              className={BIT}
              onClick={() => setOpen("due")}
            >
              {due}
            </button>
          )}
          {open === "owner" && (
            <Pop
              label={`Owner of ${task.title}`}
              onClose={done}
              className="left-0"
            >
              <Choice
                label="No owner"
                current={!task.owner}
                onPick={() => (
                  done(),
                  task.owner &&
                    void save.edit(
                      task,
                      { owner_id: null },
                      `Owner of “${task.title}” changed`,
                    )
                )}
              />
              {people.map((p) => (
                <Choice
                  key={p.user_id}
                  label={p.name}
                  current={task.owner?.id === p.user_id}
                  onPick={() => (
                    done(),
                    task.owner?.id !== p.user_id &&
                      void save.edit(
                        task,
                        { owner_id: p.user_id },
                        `Owner of “${task.title}” changed`,
                      )
                  )}
                />
              ))}
            </Pop>
          )}
        </span>
        <span className="relative flex-none">
          <button
            type="button"
            aria-label={`Status of ${task.title}`}
            aria-haspopup="menu"
            aria-expanded={open === "status"}
            data-testid="task-status"
            className={`rounded-full px-2 py-0.5 text-[12px] font-semibold ${PILL[task.status]}`}
            onClick={() => setOpen(open === "status" ? null : "status")}
          >
            {STATUS_WORDS[task.status]} ▾
          </button>
          {open === "status" && (
            <Pop
              label={`Status of ${task.title}`}
              onClose={done}
              className="right-0"
            >
              {(["todo", "doing", "done"] as const).map((s) => (
                <Choice
                  key={s}
                  label={STATUS_WORDS[s]}
                  current={task.status === s}
                  onPick={() => (
                    done(),
                    s !== task.status &&
                      void save.status(
                        task,
                        s,
                        `“${task.title}” marked ${STATUS_WORDS[s]}`,
                      )
                  )}
                />
              ))}
              <div className="my-1 border-t border-line" />
              <Choice
                label="Drop this task"
                warn
                onPick={() => (
                  done(),
                  void save.status(task, "dropped", `Dropped “${task.title}”`)
                )}
              />
            </Pop>
          )}
        </span>
      </div>
    </li>
  );
}

type Save = {
  edit: (
    t: Task,
    after: {
      title?: string;
      owner_id?: string | null;
      due_date?: string | null;
    },
    what: string,
  ) => Promise<void>;
  status: (t: Task, status: Status, what: string) => Promise<void>;
};

/** The Tasks part: its heading counts what is done. Hidden for a viewer when there are none. */
export function TasksPart({
  item,
  act,
  canChange,
  title,
}: {
  item: Item;
  act: Act;
  canChange: boolean;
  title: (words: string) => React.ReactNode;
}) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const people = useQuery(`people:tasks:${canChange}`, () =>
    canChange
      ? unwrap(api.GET("/v1/people", { params: { query: { limit: 200 } } }))
      : Promise.resolve([]),
  );
  const tasks = item.tasks;
  if (!canChange && tasks.length === 0) return null;
  const target = { item_id: item.id };
  const seen = (t: Task) => ({
    title: t.title,
    owner_id: t.owner?.id ?? null,
    due_date: t.due_date ?? null,
  });
  const save: Save = {
    edit: (t, after, what) => {
      const was = seen(t);
      const before = Object.fromEntries(
        Object.keys(after).map((k) => [k, was[k as keyof typeof was]]),
      );
      return act(what, {
        op: "edit_item_task",
        target: { ...target, task_id: t.id },
        before,
        after,
      });
    },
    status: (t, status, what) =>
      act(what, {
        op: "set_item_task_status",
        target: { ...target, task_id: t.id },
        before: { status: t.status },
        after: { status },
      }),
  };
  const done = tasks.filter((t) => t.status === "done").length;
  const add = () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    void act(`Added the task “${t}”`, {
      op: "add_item_task",
      target,
      before: {},
      after: { title: t },
    });
  };
  return (
    <>
      {title(
        tasks.length ? `Tasks · ${done} of ${tasks.length} done` : "Tasks",
      )}
      <ul className="mt-1">
        {tasks.map((t) => (
          <TaskRow
            key={`${t.id}:${t.title}`}
            task={t}
            canChange={canChange}
            people={people.data ?? []}
            save={save}
          />
        ))}
      </ul>
      {canChange &&
        (adding ? (
          <form
            className="mt-1.5 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <input
              aria-label="New task"
              placeholder="What needs doing"
              className={`${INPUT} min-w-0 flex-1`}
              value={text}
              maxLength={200}
              autoFocus
              onChange={(e) => setText(e.target.value)}
            />
            <button
              type="submit"
              disabled={!text.trim()}
              className="rounded-md bg-accent px-3 py-1 text-sm font-semibold text-white disabled:opacity-50"
            >
              Add
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="mt-1 text-sm font-semibold text-accent-ink hover:underline"
            onClick={() => setAdding(true)}
          >
            + Add a task
          </button>
        ))}
    </>
  );
}
