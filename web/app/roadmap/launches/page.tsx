"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState, useSyncExternalStore } from "react";

import {
  Button,
  Chip,
  confirmInPage,
  DataTable,
  FilterChips,
  InfoTip,
  Inspector,
  InspectorSection,
  LinkButton,
  Notice,
  Page,
  PageHeader,
  Panel,
  SegmentedControl,
  Sheet,
  Split,
  type ChipKind,
  type Column,
} from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatDate } from "@/lib/format";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";
import { invalidateWaiting, waitingChanged } from "@/lib/waiting";

import { NewLaunchDialog } from "./_new-launch";

type Summary = Schemas["LaunchSummary"];
type Task = Schemas["TaskOut"];
type Note = Schemas["RequesterNoteOut"];
type Filter = "ready" | "planned" | "launched" | "all";
type Channel = NonNullable<Note["channel"]>;
type Audience = Task["audience"];

const STATE_LABEL: Record<Summary["state"], string> = { planned: "Planned", ready: "Ready", launched: "Launched", cancelled: "Cancelled" };
const STATE_KIND: Record<Summary["state"], ChipKind> = { planned: "na", ready: "warn", launched: "pass", cancelled: "line" };
const TASK_LABEL: Record<Task["status"], string> = { todo: "To do", drafted: "Drafted", done: "Done", skipped: "Skipped" };
const TASK_KIND: Record<Task["status"], ChipKind> = { todo: "na", drafted: "acc", done: "pass", skipped: "line" };
const NOTE_LABEL: Record<Note["status"], string> = { drafted: "To send", sent: "Sent", skipped: "Skipped", notified: "Told in Oracle" };
const NOTE_KIND: Record<Note["status"], ChipKind> = { drafted: "warn", sent: "pass", skipped: "line", notified: "pass" };
const CHANNELS: { value: Channel; label: string }[] = [
  { value: "email", label: "Email" },
  { value: "slack", label: "Slack" },
  { value: "call", label: "Call" },
  { value: "other", label: "Other" },
];
const PHONE = "(max-width: 600px)";

function subscribePhone(onChange: () => void) {
  const mq = window.matchMedia(PHONE);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/** True at phone width; false on the server. */
function useIsPhone(): boolean {
  return useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE).matches, () => false);
}

function StateChip({ state, hero = false }: { state: Summary["state"]; hero?: boolean }) {
  return (
    <Chip kind={STATE_KIND[state]} dot={!hero} hero={hero} data-testid="launch-state" data-state={state}>
      {STATE_LABEL[state]}
    </Chip>
  );
}

/** "1", or "1 suggested" until a person sets the tier. */
function TierChip({ l, hero = false }: { l: Summary; hero?: boolean }) {
  const set = l.tier != null;
  return (
    <Chip kind={set ? "acc" : "line"} hero={hero} data-testid="launch-tier-chip" title={l.tier_suggestion.reason}>
      {set ? `Tier ${l.tier}` : `Tier ${l.tier_suggestion.tier} suggested`}
    </Chip>
  );
}

const sentOf = (l: Summary) => l.notes.sent + l.notes.notified;
const dateOf = (l: Summary) => l.launched_at ?? l.ready_at ?? l.created_at;

/**
 * Launches (H6): every shipped item gets a tier, a checklist, a changelog entry and a personal
 * note to the people who asked. Oracle drafts; people check, send and mark it launched.
 */
export default function LaunchesPage() {
  return (
    <Suspense fallback={null}>
      <Launches />
    </Suspense>
  );
}

function Launches() {
  // ?launch=<id>: the Inbox's Open lands on that launch.
  const wanted = useSearchParams().get("launch");
  const q = useQuery("launches", () => unwrap(api.GET("/v1/launches")));
  const phone = useIsPhone();
  const [filter, setFilter] = useState<Filter | null>(null);
  const [picked, setSelected] = useState<string | null>(null);
  const selected = picked ?? wanted;
  const [sheet, setSheet] = useState(false);
  const [creating, setCreating] = useState(false);
  const { can } = useMe();

  const rows = q.data ?? [];
  const count = (s: Summary["state"]) => rows.filter((l) => l.state === s).length;
  // Ready is the default while any launch is ready.
  const current: Filter = filter ?? (count("ready") > 0 ? "ready" : "all");
  const shown = current === "all" ? rows : rows.filter((l) => l.state === current);
  const active = shown.find((l) => l.id === selected) ?? rows.find((l) => l.id === selected) ?? shown[0];

  const columns: Column<Summary>[] = [
    {
      key: "launch",
      header: "Launch",
      phone: "title",
      cell: (l) => (
        <span className="truncate font-semibold" title={l.title}>
          {l.title}
        </span>
      ),
    },
    { key: "tier", header: "Tier", width: "150px", phone: "meta", cell: (l) => <TierChip l={l} /> },
    {
      key: "items",
      header: "Items",
      width: "70px",
      hideOnPhone: true,
      align: "right",
      cell: (l) => <span className="tnum text-text2">{l.item_keys.length}</span>,
    },
    { key: "state", header: "State", width: "120px", phone: "meta", cell: (l) => <StateChip state={l.state} /> },
    {
      key: "tasks",
      header: "Tasks",
      width: "90px",
      hideOnPhone: true,
      cell: (l) => (
        <span className="tnum" data-testid="launch-tasks-count">
          {l.task_counts.closed} of {l.task_counts.total}
        </span>
      ),
    },
    {
      key: "notes",
      header: "Notes",
      width: "110px",
      hideOnPhone: true,
      cell: (l) => (
        <span className="tnum text-text2">{l.notes.total ? `${sentOf(l)} of ${l.notes.total} sent` : "—"}</span>
      ),
    },
    {
      key: "date",
      header: "Date",
      width: "120px",
      hideOnPhone: true,
      cell: (l) => <span className="tnum text-text2">{formatDate(dateOf(l))}</span>,
    },
  ];

  const inspector = active ? (
    <LaunchInspector key={active.id} id={active.id} onChanged={q.reload} />
  ) : null;

  return (
    <Page>
      <PageHeader
        title="Launches"
        back={
          <Link href="/roadmap" className="hover:underline">
            Roadmap
          </Link>
        }
        status={
          q.data && (
            <>
              <Chip kind="acc">
                {rows.length} {rows.length === 1 ? "launch" : "launches"}
              </Chip>
              <InfoTip label="Launches" align="start" side="bottom">
                Approving a roadmap plans a launch for each item in Now. It is ready when its tracker issues or milestones
                are done. Oracle drafts the kit; a person checks it, sends it and marks the launch launched.
              </InfoTip>
            </>
          )
        }
        action={
          <div className="flex flex-wrap gap-2">
            <LinkButton href="/roadmap/changelog" icon="doc">
              Changelog
            </LinkButton>
            {can("create_launch") && (
              <Button variant="primary" icon="plus" onClick={() => setCreating(true)} data-testid="new-launch">
                New launch
              </Button>
            )}
          </div>
        }
      />
      <div className="flex flex-col gap-3">
        {q.error && <Notice tone="error">{q.error}</Notice>}
        <Split inspector={phone ? undefined : inspector}>
          <Panel
            title="Launches"
            tools={
              <FilterChips
                label="Launches by state"
                testId="launch-filters"
                value={current}
                onChange={(v) => setFilter(v)}
                items={[
                  { value: "ready", label: "Ready", count: count("ready") },
                  { value: "planned", label: "Planned", count: count("planned") },
                  { value: "launched", label: "Launched", count: count("launched") },
                  { value: "all", label: "All", count: rows.length },
                ]}
              />
            }
          >
            <DataTable<Summary>
              label="Launches"
              testId="launches-table"
              columns={columns}
              rows={q.loading && !q.data ? undefined : shown}
              rowKey={(l) => l.id}
              selected={active?.id ?? null}
              onSelect={(k) => {
                setSelected(k);
                if (phone) setSheet(true);
              }}
              loading={q.loading && !q.data}
              empty="No launches here"
              rowProps={(l) => ({ "data-testid": "launch-row", "data-state": l.state })}
            />
          </Panel>
        </Split>
      </div>
      {creating && (
        <NewLaunchDialog
          onClose={() => setCreating(false)}
          onCreated={async (l) => {
            setCreating(false);
            setFilter(l.state === "ready" ? "ready" : "planned");
            setSelected(l.id);
            // A new launch may add a Set tier row to the Inbox.
            invalidateWaiting();
            await q.reload();
            waitingChanged();
            if (phone) setSheet(true);
          }}
        />
      )}
      {phone && active && (
        <Sheet open={sheet} title={active.title} onClose={() => setSheet(false)} testId="launch-sheet">
          {inspector}
        </Sheet>
      )}
    </Page>
  );
}

function LaunchInspector({ id, onChanged }: { id: string; onChanged: () => Promise<void> }) {
  const path = { params: { path: { launch_id: id } } };
  const q = useQuery(`launch|${id}`, () => unwrap(api.GET("/v1/launches/{launch_id}", path)));
  const notesQ = useQuery(`launch-notes|${id}`, () => unwrap(api.GET("/v1/launches/{launch_id}/notes", path)));
  const { me, can } = useMe();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tier, setTier] = useState<"1" | "2" | "3" | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const l = q.data;

  async function act(key: string, call: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await call();
      // Ready, Set tier and Notes to send rows may have changed: the Inbox and the badge re-read.
      invalidateWaiting();
      await Promise.all([q.reload(), notesQ.reload(), onChanged()]);
      waitingChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  if (!l) {
    return (
      <Inspector eyebrow="Launch · selected" title="Loading…" testId="launch-inspector">
        {q.error && <Notice tone="error">{q.error}</Notice>}
      </Inspector>
    );
  }

  const live = l.state === "planned" || l.state === "ready";
  const open = l.tasks.filter((t) => t.status === "todo" || t.status === "drafted");
  const chosen = tier ?? String(l.tier ?? l.tier_suggestion.tier);
  const myId = me?.user_id ?? me?.token_id ?? null;

  async function markLaunched() {
    if (open.length > 0) {
      const preMortem = (l!.tier ?? l!.tier_suggestion.tier) === 1 && l!.tasks.some((t) => t.key === "pre_mortem" && t.status === "todo");
      const yes = await confirmInPage({
        action: "Mark launched",
        message:
          `${open.length} ${open.length === 1 ? "task is" : "tasks are"} still open: ${open.map((t) => t.title).join(", ")}.` +
          (preMortem ? " The pre-mortem has not been done for this Tier 1 launch." : "") +
          " Marking it launched blocks none of them.",
      });
      if (!yes) return;
    }
    await act("launched", () => unwrap(api.POST("/v1/launches/{launch_id}/launched", { ...path, body: {} })));
  }

  return (
    <Inspector
      eyebrow="Launch · selected"
      title={l.title}
      label={`Launch ${l.title}`}
      testId="launch-inspector"
      chips={
        <>
          <StateChip state={l.state} hero />
          <TierChip l={l} hero />
        </>
      }
      action={
        can("mark_launched") && live ? (
          <Button variant="hero" disabled={busy !== null} onClick={markLaunched} data-testid="mark-launched">
            Mark launched
          </Button>
        ) : undefined
      }
      stats={[
        { label: "Tasks", value: l.task_counts.closed, of: l.task_counts.total, testId: "launch-task-stat" },
        { label: "Notes sent", value: sentOf(l), of: l.notes.total },
      ]}
    >
      {error && (
        <InspectorSection>
          <Notice tone="error">{error}</Notice>
        </InspectorSection>
      )}
      {l.kit_error && (
        <InspectorSection>
          <Notice tone="warn" testId="kit-error">
            {l.kit_error}
          </Notice>
        </InspectorSection>
      )}
      <InspectorSection label="Tier">
        <p className="text-[15px] leading-6" data-testid="launch-tier">
          {l.tier == null ? `Tier ${l.tier_suggestion.tier} suggested · ${l.tier_suggestion.reason}` : `Tier ${l.tier}`}
        </p>
        {l.tier != null && (
          <p className="text-sm text-text2">
            Oracle suggested Tier {l.tier_suggestion.tier}: {l.tier_suggestion.reason}.
          </p>
        )}
        {can("update_launch") && live && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <SegmentedControl
              label="Tier"
              size="sm"
              value={chosen as "1" | "2" | "3"}
              onChange={(v) => setTier(v)}
              items={(["1", "2", "3"] as const).map((v) => ({ value: v, label: `Tier ${v}`, testId: `tier-${v}` }))}
            />
            <Button
              disabled={busy !== null}
              data-testid="set-tier"
              onClick={() =>
                act("tier", () =>
                  unwrap(api.PATCH("/v1/launches/{launch_id}", { ...path, body: { tier: Number(chosen), lock_version: l.lock_version } })),
                )
              }
            >
              Set tier
            </Button>
          </div>
        )}
      </InspectorSection>
      <InspectorSection label="Owner">
        <span>{l.owner_id && l.owner_id === myId ? "You" : l.owner_id ? "Another member" : "Nobody yet"}</span>
      </InspectorSection>
      <InspectorSection label="Items">
        <ul className="flex flex-col gap-1" data-testid="launch-items">
          {l.items.map((it) => (
            <li key={it.item_key}>
              {it.roadmap_slug ? (
                <Link
                  href={`/documents/${it.roadmap_slug}${it.roadmap_version ? `/v/${it.roadmap_version}` : ""}#${it.item_key}`}
                  className="font-medium underline-offset-2 hover:underline"
                >
                  {it.title ?? it.item_key}
                </Link>
              ) : (
                <span className="font-medium">{it.title ?? it.item_key}</span>
              )}
            </li>
          ))}
        </ul>
      </InspectorSection>
      <InspectorSection label="Checklist">
        {can("draft_launch_kit") && l.state !== "cancelled" && (!l.kit_run_id || l.kit_error) && (
          <Button
            disabled={busy !== null}
            onClick={() => act("draft", () => unwrap(api.POST("/v1/launches/{launch_id}/draft", path)))}
            data-testid="draft-kit"
          >
            Draft with Oracle
          </Button>
        )}
        <ul className="flex flex-col divide-y divide-line" data-testid="launch-tasks">
          {l.tasks.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              canEdit={can("update_launch_task", t.owner_id != null && t.owner_id === myId)}
              mine={t.owner_id != null && t.owner_id === myId}
              busy={busy}
              act={act}
            />
          ))}
        </ul>
        {can("add_launch_task") && <AddTask launchId={l.id} busy={busy} act={act} />}
      </InspectorSection>
      <InspectorSection label="Notes to the people who asked">
        {notesQ.data && notesQ.data.length === 0 && <span className="text-text2">Nobody yet</span>}
        <ul className="flex flex-col divide-y divide-line" data-testid="launch-notes">
          {(notesQ.data ?? []).map((n) => (
            <NoteRow key={n.id} note={n} canEdit={can("update_requester_note", l.owner_id === myId)} busy={busy} act={act} />
          ))}
        </ul>
        {can("add_requester") && <AddNote launchId={l.id} busy={busy} act={act} />}
        {can("notify_requesters") && l.state === "launched" && (notesQ.data ?? []).some((n) => n.internal && n.status === "drafted") && (
          <Button
            className="mt-2"
            disabled={busy !== null}
            onClick={() => act("notify", () => unwrap(api.POST("/v1/launches/{launch_id}/notify-members", path)))}
          >
            Notify members
          </Button>
        )}
      </InspectorSection>
      {can("cancel_launch") && live && (
        <InspectorSection>
          {cancelling ? (
            <div className="flex flex-col gap-2">
              <label className="flex flex-col gap-1 text-sm font-medium">
                Why is it cancelled?
                <input
                  className="h-9 rounded-lg border border-line-strong bg-surface px-2.5 text-[15px]"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <div className="flex gap-2">
                <Button
                  variant="danger"
                  disabled={busy !== null || !reason.trim()}
                  onClick={() =>
                    act("cancel", () => unwrap(api.POST("/v1/launches/{launch_id}/cancel", { ...path, body: { reason: reason.trim() } })))
                  }
                >
                  Cancel launch
                </Button>
                <Button variant="ghost" onClick={() => setCancelling(false)}>
                  Back
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="ghost" onClick={() => setCancelling(true)}>
              Cancel…
            </Button>
          )}
        </InspectorSection>
      )}
    </Inspector>
  );
}

type Act = (key: string, call: () => Promise<unknown>) => Promise<void>;

const FIELD = "h-9 rounded-lg border border-line-strong bg-surface px-2.5 text-[15px]";

/** Add task: a task of the company's own at the end of the checklist (approvers). */
function AddTask({ launchId, busy, act }: { launchId: string; busy: string | null; act: Act }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [audience, setAudience] = useState<Audience>("internal");
  if (!open) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button icon="plus" onClick={() => setOpen(true)} data-testid="add-task">
          Add task
        </Button>
      </div>
    );
  }
  return (
    <form
      className="mt-2 flex flex-wrap items-end gap-2"
      data-testid="add-task-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim()) return;
        void act("add-task", async () => {
          await unwrap(api.POST("/v1/launches/{launch_id}/tasks", { params: { path: { launch_id: launchId } }, body: { title: title.trim(), audience } }));
          setTitle("");
          setOpen(false);
        });
      }}
    >
      <label className="flex min-w-48 flex-1 flex-col gap-1 text-sm font-medium">
        Task
        <input className={FIELD} value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        Audience
        <select className={FIELD} value={audience} onChange={(e) => setAudience(e.target.value as Audience)}>
          <option value="internal">Internal</option>
          <option value="external">External</option>
        </select>
      </label>
      <Button type="submit" variant="solid" disabled={busy !== null || !title.trim()}>
        Add task
      </Button>
      <Button variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </form>
  );
}

/** Add note: someone who asked, added by hand with how to reach them and what they asked (approvers). */
function AddNote({ launchId, busy, act }: { launchId: string; busy: string | null; act: Act }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [hint, setHint] = useState("");
  const [asked, setAsked] = useState("");
  if (!open) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button icon="plus" onClick={() => setOpen(true)} data-testid="add-note">
          Add note
        </Button>
      </div>
    );
  }
  return (
    <form
      className="mt-2 flex flex-col gap-2"
      data-testid="add-note-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        void act("add-note", async () => {
          await unwrap(
            api.POST("/v1/launches/{launch_id}/notes", {
              params: { path: { launch_id: launchId } },
              body: { display_name: name.trim(), contact_hint: hint.trim() || null, asked: asked.trim() || null },
            }),
          );
          setName("");
          setHint("");
          setAsked("");
          setOpen(false);
        });
      }}
    >
      <label className="flex flex-col gap-1 text-sm font-medium">
        Name
        <input className={FIELD} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        How to reach them
        <input className={FIELD} value={hint} maxLength={300} onChange={(e) => setHint(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        What they asked
        <textarea
          className="min-h-20 rounded-lg border border-line-strong bg-surface p-2.5 text-[15px]"
          value={asked}
          maxLength={5000}
          onChange={(e) => setAsked(e.target.value)}
        />
      </label>
      <div className="flex gap-2">
        <Button type="submit" variant="solid" disabled={busy !== null || !name.trim()}>
          Add note
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function TaskRow({ task, canEdit, mine, busy, act }: { task: Task; canEdit: boolean; mine: boolean; busy: string | null; act: Act }) {
  const [draftOpen, setDraftOpen] = useState(false);
  const [text, setText] = useState(task.body ?? "");
  const [skipping, setSkipping] = useState(false);
  const [why, setWhy] = useState("");
  const path = { params: { path: { task_id: task.id } } };
  const closed = task.status === "done" || task.status === "skipped";
  const patch = (body: Omit<Schemas["TaskPatch"], "lock_version">) =>
    unwrap(api.PATCH("/v1/launch-tasks/{task_id}", { ...path, body: { ...body, lock_version: task.lock_version } }));
  return (
    <li className="flex flex-col gap-2 py-2" data-testid="launch-task" data-key={task.key ?? ""} data-status={task.status}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 font-medium">
          {task.title}
          {task.optional && <span className="ml-1.5 text-sm font-normal text-text2">optional</span>}
          {mine && <span className="ml-1.5 text-sm font-normal text-text2">yours</span>}
        </span>
        <Chip kind={TASK_KIND[task.status]} dot>
          {TASK_LABEL[task.status]}
        </Chip>
      </div>
      {task.skip_reason && <p className="text-sm text-text2">Skipped: {task.skip_reason}</p>}
      <div className="flex flex-wrap gap-1.5">
        {(task.body || canEdit) && task.drafts !== "no" && (
          <Button variant="ghost" onClick={() => setDraftOpen((o) => !o)} aria-expanded={draftOpen}>
            {draftOpen ? "Close draft" : "Open draft"}
          </Button>
        )}
        {canEdit && !closed && (
          <>
            <Button disabled={busy !== null} onClick={() => act(`done-${task.id}`, () => patch({ status: "done" }))}>
              Done
            </Button>
            <Button variant="ghost" onClick={() => setSkipping((s) => !s)}>
              Skip
            </Button>
          </>
        )}
      </div>
      {draftOpen && (
        <div className="flex flex-col gap-2" data-testid="task-draft">
          {task.notice && <p className="text-sm font-medium text-warn">{task.notice}</p>}
          <textarea
            aria-label={`Draft of ${task.title}`}
            className="min-h-32 rounded-lg border border-line-strong bg-surface p-2.5 text-[15px] leading-6"
            value={text}
            readOnly={!canEdit}
            onChange={(e) => setText(e.target.value)}
          />
          {canEdit && (
            <Button
              variant="solid"
              disabled={busy !== null || text === (task.body ?? "")}
              onClick={() => act(`save-${task.id}`, () => patch({ body: text }))}
            >
              Save draft
            </Button>
          )}
        </div>
      )}
      {skipping && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm font-medium">
            Why skip it?
            <input
              className="h-9 rounded-lg border border-line-strong bg-surface px-2.5 text-[15px]"
              value={why}
              onChange={(e) => setWhy(e.target.value)}
            />
          </label>
          <Button
            disabled={busy !== null || !why.trim()}
            onClick={() => act(`skip-${task.id}`, () => patch({ status: "skipped", skip_reason: why.trim() }))}
          >
            Skip task
          </Button>
        </div>
      )}
    </li>
  );
}

function NoteRow({ note, canEdit, busy, act }: { note: Note; canEdit: boolean; busy: string | null; act: Act }) {
  const [sending, setSending] = useState(false);
  const [channel, setChannel] = useState<Channel>("email");
  const [on, setOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [skipping, setSkipping] = useState(false);
  const [why, setWhy] = useState("");
  const [copied, setCopied] = useState(false);
  const path = { params: { path: { note_id: note.id } } };
  const open = note.status === "drafted";
  const patch = (body: Schemas["RequesterNotePatch"]) => unwrap(api.PATCH("/v1/requester-notes/{note_id}", { ...path, body }));
  return (
    <li className="flex flex-col gap-2 py-2" data-testid="launch-note" data-status={note.status}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1">
          <span className="font-medium">{note.display_name}</span>
          <span className="ml-1.5 text-sm text-text2">
            {note.internal ? "member" : (note.contact_hint ?? "added by hand")}
            {note.channel ? ` · ${CHANNELS.find((c) => c.value === note.channel)?.label ?? note.channel}` : ""}
          </span>
        </span>
        <Chip kind={NOTE_KIND[note.status]} dot>
          {NOTE_LABEL[note.status]}
        </Chip>
      </div>
      {note.asked && <blockquote className="border-l-2 border-line-strong pl-2.5 text-sm text-text2">{note.asked}</blockquote>}
      {note.body ? (
        <p className="text-[15px] leading-6 whitespace-pre-line" data-testid="note-draft">
          {note.body}
        </p>
      ) : (
        <p className="text-sm text-text2">No draft yet</p>
      )}
      {note.notice && <p className="text-sm font-medium text-warn">{note.notice}</p>}
      <div className="flex flex-wrap gap-1.5">
        {note.body && (
          <Button
            variant="ghost"
            onClick={async () => {
              await navigator.clipboard.writeText(note.body ?? "");
              setCopied(true);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        )}
        {canEdit && open && !note.internal && (
          <Button onClick={() => setSending((s) => !s)} disabled={busy !== null}>
            Mark sent
          </Button>
        )}
        {canEdit && open && (
          <Button variant="ghost" onClick={() => setSkipping((s) => !s)}>
            Skip
          </Button>
        )}
      </div>
      {sending && (
        <div className="flex flex-wrap items-end gap-2" data-testid="mark-sent-form">
          <label className="flex flex-col gap-1 text-sm font-medium">
            Sent by
            <select
              className="h-9 rounded-lg border border-line-strong bg-surface px-2 text-[15px]"
              value={channel}
              onChange={(e) => setChannel(e.target.value as Channel)}
            >
              {CHANNELS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium">
            On
            <input
              type="date"
              className="h-9 rounded-lg border border-line-strong bg-surface px-2 text-[15px]"
              value={on}
              onChange={(e) => setOn(e.target.value)}
            />
          </label>
          <Button
            disabled={busy !== null}
            onClick={() => act(`sent-${note.id}`, () => patch({ status: "sent", channel, sent_on: on }))}
          >
            Save as sent
          </Button>
        </div>
      )}
      {skipping && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm font-medium">
            Why skip it?
            <input
              className="h-9 rounded-lg border border-line-strong bg-surface px-2.5 text-[15px]"
              value={why}
              onChange={(e) => setWhy(e.target.value)}
            />
          </label>
          <Button
            disabled={busy !== null || !why.trim()}
            onClick={() => act(`skip-${note.id}`, () => patch({ status: "skipped", skip_reason: why.trim() }))}
          >
            Skip note
          </Button>
        </div>
      )}
    </li>
  );
}
