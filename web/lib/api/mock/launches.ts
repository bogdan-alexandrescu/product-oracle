/**
 * Launches and changelog (H6) for the mock API: synthetic launches with their checklist,
 * requester notes and changelog entries, and the routes the screens call, mirroring the
 * API's rules (approvers set tiers, mark launched and publish; Oracle never sends).
 */
import type { Schemas } from "@/lib/api/client";

import { mockUuid, seeded } from "./ids";

type Role = Schemas["Me"]["role"];
type Launch = Omit<Schemas["LaunchOut"], "tasks" | "task_counts" | "notes">;
type Task = Schemas["TaskOut"];
type Note = Schemas["RequesterNoteOut"];
type Entry = Schemas["ChangelogEntryOut"];

export interface LaunchesDb {
  launches: Launch[];
  tasks: Task[];
  notes: Note[];
  changelog: Entry[];
}

export interface LaunchesContext {
  userId: string;
  role: Role;
  /** The member who asked through a PRD comment (a commenter of the mock company). */
  askerId: string | null;
  trackId: string | null;
  /** The track's latest approved roadmap items; null for an unknown track. */
  roadmapItems?: (trackId: string) => Schemas["LaunchItem"][] | null;
}

const AT = "2026-10-19T09:00:00Z";
const ROLES: Role[] = ["viewer", "commenter", "approver", "owner"];
const NOTICE = "Draft by Oracle. A person checks and sends it.";

/** The built-in checklist, in the table's order: key, title, audience, Oracle drafts, tiers, optional in. */
const CHECKLIST: [string, string, Task["audience"], Task["drafts"], number[], number[]][] = [
  ["changelog_entry", "Changelog entry", "external", "yes", [1, 2, 3], []],
  ["release_notes", "Release notes", "external", "yes", [1, 2], []],
  ["internal_announcement", "Internal announcement", "internal", "yes", [1, 2], []],
  ["support_notes", "Support notes (what changed, known limits, FAQ)", "internal", "yes", [1, 2, 3], []],
  ["sales_briefing", "Sales and success briefing", "internal", "yes", [1], []],
  ["help_docs", "Help docs update", "external", "outline", [1, 2], []],
  ["in_app_message", "In-app message", "external", "yes", [1, 2], [2]],
  ["customer_email", "Customer email", "external", "yes", [1, 2], [2]],
  ["positioning_check", "Positioning check", "internal", "no", [1], []],
  ["demo", "Demo", "internal", "no", [1], []],
  ["pre_mortem", "Pre-mortem (tigers, paper tigers, elephants)", "internal", "yes", [1], []],
  ["requester_notes", "Notes to the people who asked", "external", "yes", [1, 2, 3], []],
];
const ORDER = new Map(CHECKLIST.map(([key], i) => [key, i]));

/** What Oracle's kit run drafted for a launch, by task key. */
const DRAFTS: Record<string, string> = {
  release_notes: "## Hard budget caps\n\nSet a monthly cap per project. Spending stops at the cap until an owner raises it.",
  internal_announcement: "Hard budget caps are live for every company on the usage plan.",
  support_notes:
    "What changed: projects can have a hard monthly cap.\nKnown limits: one cap per project.\nFAQ: Can a cap be raised mid-month? Yes, by an owner.",
  sales_briefing: "Caps answer the most common worry in renewals: surprise bills.",
  in_app_message: "New: set a hard budget cap for this project.",
  customer_email: "You can now set a hard budget cap on each project.",
  help_docs: "Outline: what a cap is; setting one; raising one; what happens at the cap.",
  pre_mortem:
    "**Tigers** (real threats to the launch)\n- A cap stops a production job at month end\n\n**Paper tigers** (worries that look real and are not)\n- Owners will not find the setting\n\n**Elephants** (what nobody is saying)\n- Invoices still arrive after the cap",
  changelog_entry: "- Added (public): Hard budget caps",
  requester_notes: "2 personal notes drafted: see Notes.",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const now = () => new Date().toISOString();
const atLeast = (role: Role, need: Role) => ROLES.indexOf(role) >= ROLES.indexOf(need);
const forbidden = (need: Role) => json(403, { detail: `Requires the ${need} role` });
const notFound = (what: string) => json(404, { detail: `${what} not found` });
const invalid = (detail: string) => json(422, { detail });
const conflict = (detail: string) => json(409, { detail });

function task(launch: Launch, key: string, position: number, drafted: boolean): Task {
  const def = CHECKLIST.find(([k]) => k === key)!;
  const body = drafted && def[3] !== "no" ? (DRAFTS[key] ?? null) : null;
  return {
    id: mockUuid(),
    launch_id: launch.id,
    key,
    title: def[1],
    position,
    audience: def[2],
    status: body ? "drafted" : "todo",
    // Nobody owns a checklist task until an approver gives it to someone.
    owner_id: null,
    body,
    skip_reason: null,
    done_by: null,
    done_at: null,
    drafts: def[3],
    optional: false,
    notice: null,
    lock_version: 1,
    updated_at: AT,
  };
}

function launchRow(ctx: LaunchesContext, title: string, key: string, extra: Partial<Launch>): Launch {
  return {
    id: mockUuid(),
    title,
    track_id: ctx.trackId,
    roadmap_version_id: null,
    item_keys: [key],
    state: "planned",
    tier: null,
    tier_suggestion: { tier: 3, reason: "Fix or internal change", innovation: "fix", goal: "none" },
    owner_id: ctx.userId,
    ready_at: null,
    launched_at: null,
    cancel_reason: null,
    kit_run_id: null,
    kit_error: null,
    lock_version: 1,
    created_at: AT,
    updated_at: AT,
    items: [{ item_key: key, title, horizon: "now", roadmap_slug: "usage-alerts-roadmap", roadmap_version: 1 }],
    ...extra,
  };
}

/** Three synthetic launches: one Ready (kit drafted, two people asked), one Planned, one Launched. */
export function seedLaunches(ctx: LaunchesContext): LaunchesDb {
  return seeded("launches", () => {
    const db: LaunchesDb = { launches: [], tasks: [], notes: [], changelog: [] };
    const caps = launchRow(ctx, "Hard budget caps", "item-hard-caps", {
      state: "ready",
      ready_at: "2026-10-20T08:00:00Z",
      kit_run_id: mockUuid(),
      tier_suggestion: {
        tier: 1,
        reason: "New feature serving a top goal (Cut surprise bills)",
        innovation: "new",
        goal: "top",
        goal_title: "Cut surprise bills",
      },
    });
    const digest = launchRow(ctx, "Weekly usage digest", "item-digest", {
      tier: 2,
      tier_suggestion: {
        tier: 2,
        reason: "Improvement serving a top goal (Cut surprise bills)",
        innovation: "improvement",
        goal: "top",
        goal_title: "Cut surprise bills",
      },
    });
    const exportLaunch = launchRow(ctx, "Usage export", "item-export", {
      state: "launched",
      tier: 3,
      launched_at: "2026-10-10T10:00:00Z",
      created_at: "2026-10-01T09:00:00Z",
    });
    db.launches.push(caps, digest, exportLaunch);
    // The kit drafted every task it drafts but the pre-mortem: it waits for a person.
    CHECKLIST.filter(([, , , , tiers]) => tiers.includes(1)).forEach(([key], i) => db.tasks.push(task(caps, key, i + 1, key !== "pre_mortem")));
    CHECKLIST.filter(([, , , , tiers]) => tiers.includes(2)).forEach(([key], i) => db.tasks.push(task(digest, key, i + 1, false)));
    CHECKLIST.filter(([, , , , tiers]) => tiers.includes(3)).forEach(([key], i) => {
      const t = task(exportLaunch, key, i + 1, false);
      db.tasks.push({ ...t, status: "done", done_by: ctx.userId, done_at: "2026-10-10T10:00:00Z" });
    });
    const note = (launch: Launch, extra: Partial<Note>): Note => ({
      id: mockUuid(),
      launch_id: launch.id,
      requester_kind: "manual",
      request_id: null,
      member_id: null,
      display_name: "",
      contact_hint: null,
      asked: null,
      body: null,
      status: "drafted",
      channel: null,
      sent_on: null,
      sent_by: null,
      skip_reason: null,
      notified_at: null,
      internal: false,
      notice: null,
      created_at: AT,
      updated_at: AT,
      ...extra,
    });
    db.notes.push(
      note(caps, {
        requester_kind: "member",
        member_id: ctx.askerId,
        display_name: "commenter@example.com",
        asked: "Can we stop spending at a fixed amount instead of only getting alerts?",
        body: "You asked whether spending could stop at a fixed amount. It can now: set a hard cap in the project's budget settings.",
        internal: true,
      }),
      note(caps, {
        display_name: "Pilot customer contact",
        contact_hint: "asked through the support desk",
        asked: "Please give us a hard limit so a runaway job cannot run up the bill.",
        body: "Thanks for asking for a hard limit. Each project can now have a hard budget cap: spending stops at the cap until an owner raises it.",
      }),
      note(exportLaunch, {
        display_name: "Finance lead at a pilot customer",
        asked: "We need the usage as a spreadsheet.",
        body: "Usage now exports as CSV from the usage page.",
        status: "sent",
        channel: "email",
        sent_on: "2026-10-11",
      }),
    );
    const entry = (extra: Partial<Entry>): Entry => ({
      id: mockUuid(),
      launch_id: null,
      category: "added",
      audience: "public",
      title: "",
      body: "",
      released_on: "2026-10-20",
      status: "draft",
      published_by: null,
      published_actor: null,
      published_at: null,
      created_actor: "oracle",
      lock_version: 1,
      created_at: AT,
      updated_at: AT,
      ...extra,
    });
    db.changelog.push(
      entry({ launch_id: caps.id, title: "Hard budget caps", body: "Set a monthly cap per project; spending stops at the cap." }),
      entry({
        launch_id: exportLaunch.id,
        title: "Usage export",
        body: "Export usage as CSV from the usage page.",
        released_on: "2026-10-10",
        status: "published",
        published_by: ctx.userId,
        published_actor: `user:${ctx.userId}`,
        published_at: "2026-10-10T11:00:00Z",
      }),
      entry({
        launch_id: exportLaunch.id,
        category: "fixed",
        title: "Totals round to the cent",
        released_on: "2026-10-10",
        status: "published",
        published_by: ctx.userId,
        published_actor: `user:${ctx.userId}`,
        published_at: "2026-10-10T11:00:00Z",
      }),
      entry({ launch_id: exportLaunch.id, audience: "internal", category: "changed", title: "Usage page loads from the new store", released_on: "2026-10-10" }),
    );
    return db;
  });
}

const tierOf = (l: Launch) => l.tier ?? l.tier_suggestion.tier;

function tasksOf(db: LaunchesDb, launch: Launch): Task[] {
  const tier = tierOf(launch);
  return db.tasks
    .filter((t) => t.launch_id === launch.id)
    .sort((a, b) => a.position - b.position)
    .map((t) => {
      const def = CHECKLIST.find(([k]) => k === t.key);
      return { ...t, optional: !!def && def[5].includes(tier), notice: t.audience === "external" && t.body ? NOTICE : null };
    });
}

function counts(db: LaunchesDb, launch: Launch) {
  const tasks = db.tasks.filter((t) => t.launch_id === launch.id);
  const closed = tasks.filter((t) => t.status === "done" || t.status === "skipped").length;
  const notes = db.notes.filter((n) => n.launch_id === launch.id);
  const by = (s: Note["status"]) => notes.filter((n) => n.status === s).length;
  return {
    task_counts: { total: tasks.length, closed, open: tasks.length - closed },
    notes: { total: notes.length, sent: by("sent"), skipped: by("skipped"), notified: by("notified"), open: by("drafted") },
  };
}

function summary(db: LaunchesDb, launch: Launch): Schemas["LaunchSummary"] {
  const rest = { ...launch } as Partial<Launch>;
  delete rest.items;
  return { ...(rest as Schemas["LaunchSummary"]), ...counts(db, launch) };
}

function out(db: LaunchesDb, launch: Launch): Schemas["LaunchOut"] {
  return { ...launch, ...counts(db, launch), tasks: tasksOf(db, launch) };
}

/** The tier's checklist: missing tasks added, untouched todo tasks the tier does not list removed. */
function applyTier(db: LaunchesDb, launch: Launch) {
  const tier = tierOf(launch);
  const wanted = CHECKLIST.filter(([, , , , tiers]) => tiers.includes(tier)).map(([k]) => k);
  db.tasks = db.tasks.filter(
    (t) => t.launch_id !== launch.id || wanted.includes(t.key ?? "") || !ORDER.has(t.key ?? "") || t.status !== "todo" || t.body !== null || t.lock_version !== 1,
  );
  const have = new Set(db.tasks.filter((t) => t.launch_id === launch.id).map((t) => t.key));
  for (const key of wanted) if (!have.has(key)) db.tasks.push(task(launch, key, 1000, false));
  const mine = db.tasks.filter((t) => t.launch_id === launch.id);
  mine
    .sort((a, b) => (ORDER.get(a.key ?? "") ?? 100 + a.position) - (ORDER.get(b.key ?? "") ?? 100 + b.position))
    .forEach((t, i) => (t.position = i + 1));
}

/** The launch rows of the caller's Inbox (as GET /v1/inbox returns them). */
export function launchInboxRows(ctx: LaunchesContext, db: LaunchesDb): Schemas["InboxLaunch"][] {
  const rows: Schemas["InboxLaunch"][] = [];
  for (const l of db.launches) {
    if (l.state === "ready" && l.owner_id === ctx.userId) {
      rows.push({ launch_id: l.id, title: `Ready to launch · ${l.title}`, item: l.title, reason: "ready", state: l.state, counted: true, count: 1, at: l.ready_at });
    }
    if ((l.state === "planned" || l.state === "ready") && l.tier == null && atLeast(ctx.role, "approver")) {
      rows.push({ launch_id: l.id, title: `Set tier · ${l.title}`, item: l.title, reason: "set_tier", state: l.state, counted: true, count: 1, at: l.created_at });
    }
    if (l.state === "launched" && l.owner_id === ctx.userId) {
      const open = db.notes.filter((n) => n.launch_id === l.id && n.status === "drafted").length;
      if (open) {
        rows.push({ launch_id: l.id, title: `Notes to send · ${l.title} · ${open}`, item: l.title, reason: "notes_to_send", state: l.state, counted: true, count: open, at: l.launched_at });
      }
    }
  }
  for (const n of db.notes) {
    if (n.member_id !== ctx.userId || n.status !== "notified") continue;
    const l = db.launches.find((x) => x.id === n.launch_id)!;
    rows.push({ launch_id: l.id, title: `Shipped: ${l.title}`, item: l.title, reason: "shipped_note", state: l.state, counted: false, count: 0, note: n.body, at: n.notified_at });
  }
  return rows;
}

function exportText(entries: Entry[], format: string): string {
  const days = [...new Set(entries.map((e) => e.released_on))].sort().reverse();
  const cats: Entry["category"][] = ["added", "changed", "deprecated", "removed", "fixed", "security"];
  const head = (c: string) => c[0].toUpperCase() + c.slice(1);
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (format === "html") {
    const out = ['<section class="changelog">', "<h1>Changelog</h1>"];
    for (const day of days) {
      out.push(`<h2>${day}</h2>`);
      for (const c of cats) {
        const rows = entries.filter((e) => e.released_on === day && e.category === c);
        if (!rows.length) continue;
        out.push(`<h3>${head(c)}</h3>`, "<ul>", ...rows.map((e) => `<li><strong>${esc(e.title)}</strong>${e.body ? `: ${esc(e.body)}` : ""}</li>`), "</ul>");
      }
    }
    return [...out, "</section>"].join("\n") + "\n";
  }
  const lines = ["# Changelog"];
  for (const day of days) {
    lines.push("", `## ${day}`);
    for (const c of cats) {
      const rows = entries.filter((e) => e.released_on === day && e.category === c);
      if (!rows.length) continue;
      lines.push("", `### ${head(c)}`, "", ...rows.map((e) => `- **${e.title}**${e.body ? `: ${e.body}` : ""}`));
    }
  }
  return lines.join("\n") + "\n";
}

/** Handles /v1/launches*, /v1/launch-tasks/*, /v1/requester-notes/* and /v1/changelog*; null for anything else. */
export async function routeLaunches(ctx: LaunchesContext, db: LaunchesDb, req: Request, p: string[], q: URLSearchParams): Promise<Response | null> {
  const area = p[1];
  if (!["launches", "launch-tasks", "requester-notes", "changelog"].includes(area)) return null;
  const m = req.method;
  const body = async <T>() => (await req.json()) as T;
  const approver = atLeast(ctx.role, "approver");

  if (area === "changelog") {
    if (p.length === 2 && m === "GET") {
      let rows = [...db.changelog];
      for (const key of ["audience", "status"] as const) if (q.get(key)) rows = rows.filter((e) => e[key] === q.get(key));
      rows.sort((a, b) => b.released_on.localeCompare(a.released_on) || b.created_at.localeCompare(a.created_at));
      return json(200, rows);
    }
    if (p[2] === "export" && m === "GET") {
      const audience = q.get("audience") ?? "public";
      const since = q.get("since");
      const rows = db.changelog.filter((e) => e.status === "published" && e.audience === audience && (!since || e.released_on >= since));
      const format = q.get("format") ?? "md";
      return new Response(exportText(rows, format), { status: 200, headers: { "Content-Type": format === "html" ? "text/html; charset=utf-8" : "text/markdown; charset=utf-8" } });
    }
    if (!approver) return forbidden("approver");
    if (p.length === 2 && m === "POST") {
      const b = await body<Schemas["ChangelogCreate"]>();
      if (b.audience === "public" && !b.released_on) return invalid("A public entry needs its release date");
      const e: Entry = {
        id: mockUuid(), launch_id: b.launch_id ?? null, category: b.category, audience: b.audience, title: b.title.trim(), body: (b.body ?? "").trim(),
        released_on: b.released_on ?? now().slice(0, 10), status: "draft", published_by: null, published_actor: null, published_at: null,
        created_actor: `user:${ctx.userId}`, lock_version: 1, created_at: now(), updated_at: now(),
      };
      db.changelog.push(e);
      return json(201, e);
    }
    const e = db.changelog.find((x) => x.id === p[2]);
    if (!e) return notFound("Changelog entry");
    if (p.length === 3 && m === "PATCH") {
      const b = await body<Schemas["ChangelogPatch"]>();
      if (b.lock_version !== e.lock_version) return conflict("The entry changed since it was loaded");
      for (const k of ["category", "audience", "title", "body", "released_on"] as const) if (b[k] != null) (e as Record<string, unknown>)[k] = b[k];
      e.lock_version += 1;
      e.updated_at = now();
      return json(200, e);
    }
    if (p[3] === "publish" && m === "POST") {
      if (e.status === "withdrawn") return conflict("A withdrawn entry cannot be published");
      Object.assign(e, { status: "published", published_by: ctx.userId, published_actor: `user:${ctx.userId}`, published_at: now(), lock_version: e.lock_version + 1 });
      return json(200, e);
    }
    if (p[3] === "withdraw" && m === "POST") {
      Object.assign(e, { status: "withdrawn", lock_version: e.lock_version + 1 });
      return json(200, e);
    }
    return notFound("Route");
  }

  if (area === "launch-tasks" && m === "PATCH") {
    const t = db.tasks.find((x) => x.id === p[2]);
    if (!t) return notFound("Task");
    if (!approver && t.owner_id !== ctx.userId) return json(403, { detail: "Only the task's owner or an approver can change it" });
    const b = await body<Schemas["TaskPatch"]>();
    if (b.lock_version !== t.lock_version) return conflict("The task changed since it was loaded");
    if (b.status === "skipped" && !b.skip_reason?.trim()) return invalid("Skipping a task needs a reason");
    if (b.body != null) {
      t.body = b.body;
      if (t.status === "todo" && !b.status) t.status = "drafted";
    }
    if (b.status) {
      t.status = b.status;
      t.skip_reason = b.status === "skipped" ? b.skip_reason!.trim() : null;
      if (b.status === "done") Object.assign(t, { done_by: ctx.userId, done_at: now() });
    }
    if (b.owner_id !== undefined) t.owner_id = b.owner_id;
    t.lock_version += 1;
    t.updated_at = now();
    const launch = db.launches.find((l) => l.id === t.launch_id)!;
    return json(200, tasksOf(db, launch).find((x) => x.id === t.id));
  }

  if (area === "requester-notes" && m === "PATCH") {
    const n = db.notes.find((x) => x.id === p[2]);
    if (!n) return notFound("Note");
    const launch = db.launches.find((l) => l.id === n.launch_id)!;
    if (!approver && launch.owner_id !== ctx.userId) return json(403, { detail: "Only the launch's owner or an approver can change notes" });
    const b = await body<Schemas["RequesterNotePatch"]>();
    if (b.status === "sent" && !(b.channel ?? n.channel)) return invalid("Say how the note was sent (channel)");
    if (b.status === "skipped" && !b.skip_reason?.trim()) return invalid("Skipping a note needs a reason");
    if (b.body != null) n.body = b.body;
    if (b.status === "sent") Object.assign(n, { status: "sent", channel: b.channel ?? n.channel, sent_on: b.sent_on ?? now().slice(0, 10), sent_by: ctx.userId });
    if (b.status === "skipped") Object.assign(n, { status: "skipped", skip_reason: b.skip_reason!.trim() });
    n.updated_at = now();
    return json(200, n);
  }

  if (area !== "launches") return notFound("Route");
  if (p.length === 2 && m === "GET") {
    let rows = [...db.launches];
    if (q.get("state")) rows = rows.filter((l) => l.state === q.get("state"));
    if (q.get("tier")) rows = rows.filter((l) => String(l.tier) === q.get("tier"));
    rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return json(200, rows.map((l) => summary(db, l)));
  }
  if (p.length === 2 && m === "POST") {
    if (!approver) return forbidden("approver");
    const b = await body<Schemas["LaunchCreate"]>();
    if (!b.title?.trim()) return invalid("Name the launch");
    const keys = [...new Set(b.item_keys.map((k) => k.trim()).filter(Boolean))];
    if (!keys.length) return invalid("name at least one roadmap item");
    const known = ctx.roadmapItems?.(b.track_id);
    if (known === null) return notFound("Track");
    const items = known ? keys.map((k) => known.find((i) => i.item_key === k)) : [];
    if (known && items.some((i) => !i)) {
      return invalid("not items of the track's latest approved roadmap: " + keys.filter((k, i) => !items[i]).join(", "));
    }
    b.item_keys = keys;
    if (db.launches.some((l) => l.state !== "cancelled" && l.track_id === b.track_id && l.item_keys.join() === b.item_keys.join())) {
      return conflict("These items already have a launch");
    }
    const l = launchRow(ctx, b.title.trim(), keys[0], { track_id: b.track_id, item_keys: keys, owner_id: b.owner_id ?? ctx.userId, created_at: now() });
    if (known) l.items = items as Schemas["LaunchItem"][];
    db.launches.push(l);
    applyTier(db, l);
    return json(201, out(db, l));
  }
  const launch = db.launches.find((l) => l.id === p[2]);
  if (!launch) return notFound("Launch");
  if (p.length === 3 && m === "GET") return json(200, out(db, launch));
  if (p[3] === "notes" && m === "GET") return json(200, db.notes.filter((n) => n.launch_id === launch.id));
  if (!approver) return forbidden("approver");
  if (p.length === 3 && m === "PATCH") {
    const b = await body<Schemas["LaunchPatch"]>();
    if (b.lock_version !== launch.lock_version) return conflict("The launch changed since it was loaded");
    if (b.tier != null && (b.tier < 1 || b.tier > 3)) return invalid("tier must be 1, 2 or 3");
    if (b.title) launch.title = b.title;
    if (b.owner_id !== undefined) launch.owner_id = b.owner_id ?? null;
    if (b.tier != null && b.tier !== launch.tier) {
      launch.tier = b.tier;
      applyTier(db, launch);
    }
    launch.lock_version += 1;
    launch.updated_at = now();
    return json(200, out(db, launch));
  }
  if (p[3] === "launched" && m === "POST") {
    if (launch.state === "launched") return conflict("Already launched");
    if (launch.state === "cancelled") return conflict("The launch is cancelled");
    const b = await body<Schemas["LaunchedIn"] | null>().catch(() => null);
    Object.assign(launch, { state: "launched", launched_at: b?.at ?? now(), lock_version: launch.lock_version + 1 });
    for (const e of db.changelog) if (e.launch_id === launch.id && e.status === "draft") e.released_on = launch.launched_at!.slice(0, 10);
    return json(200, out(db, launch));
  }
  if (p[3] === "cancel" && m === "POST") {
    const b = await body<Schemas["CancelIn"]>();
    if (!b.reason?.trim()) return invalid("Say why the launch is cancelled");
    if (launch.state !== "planned" && launch.state !== "ready") return conflict(`A ${launch.state} launch cannot be cancelled`);
    Object.assign(launch, { state: "cancelled", cancel_reason: b.reason.trim(), lock_version: launch.lock_version + 1 });
    return json(200, out(db, launch));
  }
  if (p[3] === "draft" && m === "POST") {
    // The mock's kit run finishes at once: Oracle's drafts land on the tasks still to do.
    for (const t of db.tasks) {
      if (t.launch_id === launch.id && t.status === "todo" && t.key && DRAFTS[t.key] && t.drafts !== "no") Object.assign(t, { body: DRAFTS[t.key], status: "drafted" });
    }
    Object.assign(launch, { kit_run_id: mockUuid(), kit_error: null });
    return json(201, { id: launch.kit_run_id, flow: "launch_kit", status: "succeeded" });
  }
  if (p[3] === "tasks" && m === "POST") {
    const b = await body<Schemas["TaskCreate"]>();
    if (b.key && db.tasks.some((x) => x.launch_id === launch.id && x.key === b.key)) return conflict(`The launch already has a task '${b.key}'`);
    const t: Task = {
      id: mockUuid(), launch_id: launch.id, key: b.key ?? null, title: b.title.trim(), position: 1 + Math.max(0, ...db.tasks.filter((x) => x.launch_id === launch.id).map((x) => x.position)),
      audience: b.audience, status: "todo", owner_id: b.owner_id ?? null, body: null, skip_reason: null, done_by: null, done_at: null,
      drafts: "no", optional: false, notice: null, lock_version: 1, updated_at: now(),
    };
    db.tasks.push(t);
    return json(201, t);
  }
  if (p[3] === "notes" && m === "POST") {
    const b = await body<Schemas["RequesterCreate"]>();
    const n: Note = {
      id: mockUuid(), launch_id: launch.id, requester_kind: "manual", request_id: null, member_id: null, display_name: b.display_name.trim(),
      contact_hint: b.contact_hint?.trim() || null, asked: b.asked?.trim() || null, body: null, status: "drafted", channel: null, sent_on: null, sent_by: null,
      skip_reason: null, notified_at: null, internal: false, notice: null, created_at: now(), updated_at: now(),
    };
    db.notes.push(n);
    return json(201, n);
  }
  if (p[3] === "notify-members" && m === "POST") {
    if (launch.state !== "launched") return conflict("Mark the launch launched first");
    let notified = 0;
    for (const n of db.notes) {
      if (n.launch_id === launch.id && n.requester_kind === "member" && n.status === "drafted") {
        Object.assign(n, { status: "notified", notified_at: now() });
        notified += 1;
      }
    }
    return json(200, { notified });
  }
  return notFound("Route");
}
