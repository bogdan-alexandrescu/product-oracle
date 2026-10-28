import type { Schemas } from "@/lib/api/client";

import { stableUuid } from "./ids";

/**
 * Simple S10 (#723, D26): proposals' visuals (oracle.simple.visuals), with INVENTED
 * drawings. Each visual is held against its subject (kind, id) with its versions (newest
 * last) and comments. Pressing Revise answers with the next version at once (the API queues
 * the simple_visual job); asking for a drawing stays pending (the job running) until the
 * panel's next read, which draws it, or, for a subject in `failOnce`, ends without one
 * (`failed`, Retry asks again). A test may keep the job running for a while
 * (MOCK_VISUAL_JOB_MS_KEY, ms in localStorage): until then every read still answers
 * "drawing", as the API does while the simple_visual job runs.
 *
 * Who: everyone reads; commenters and up comment on a drawn visual; owners (who change
 * the subject directly) ask for a drawing and revise.
 */

type Flow = Schemas["SimpleFlow"];
type Step = Schemas["SimpleFlowStep"];

interface MockVisual {
  kind: string;
  id: string;
  brief: string;
  versions: Flow[];
  comments: Schemas["SimpleVisualCommentOut"][];
  made_by: (string | null)[];
  /** Oracle is drawing it (the simple_visual job is queued or running). */
  pending?: boolean;
  /** Oracle's newest drawing job ended without a drawing: why (the API's `failure`). */
  failure?: string | null;
  /** When the drawing job was queued (the browser's clock, ms). */
  queued_at?: number;
}

export interface VisualsDb {
  visuals: Record<string, MockVisual>;
  /** Subjects whose next drawing fails (the job ends without one), then draw on Retry. */
  failOnce?: string[];
  /** Subjects named with their code, as the API's `subject_name` ("F-06 Weekly alert digest"). */
  names?: Record<string, string>;
}

/** Tests set this localStorage key to how long (ms) a requested drawing's job runs. */
export const MOCK_VISUAL_JOB_MS_KEY = "po-mock-visual-job-ms";

/** Tests set this localStorage key to a one-pager bet's words: its first drawing fails, Retry draws it. */
export const MOCK_VISUAL_FAIL_KEY = "po-mock-visual-fail";

const jobMs = (): number => (typeof localStorage === "undefined" ? 0 : Number(localStorage.getItem(MOCK_VISUAL_JOB_MS_KEY) ?? 0) || 0);

interface Ctx {
  id: string;
  role: string;
  names: Record<string, string>;
  /** A roadmap item's name as the API's subject_name ("F-06 Weekly alert digest", or its title). */
  itemName?: (id: string) => string | null;
}

/** Subjects drawn with their proposal, never asked for by id (the API's UNASKABLE_KINDS);
 * a one-pager line is asked for with its PRD (document_id). */
const UNASKABLE = ["suggestion", "chat_card"];
const RANK: Record<string, number> = { viewer: 0, commenter: 1, approver: 2, owner: 3 };
const at = "2026-10-26T15:00:00Z";
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A one-pager bet's subject id (the API's is a uuid5 of the PRD and the bet's words). */
export const betSubject = (text: string): string => stableUuid(`simple-visual/bet/${text.trim().toLowerCase()}`);

function drawSvg(title: string, steps: Step[]): string {
  const w = 150;
  const boxes = steps
    .map((s, i) => {
      const x = 20 + i * (w + 30);
      const stroke = s.change === "new" ? 'stroke="#111" stroke-width="3"' : s.change === "changed" ? 'stroke="#333" stroke-dasharray="6 4"' : 'stroke="#777"';
      const shape =
        s.kind === "decision"
          ? `<polygon id="${s.id}" points="${x + w / 2},64 ${x + w},100 ${x + w / 2},136 ${x},100" fill="#f4f4f4" ${stroke}/>`
          : `<rect id="${s.id}" x="${x}" y="70" width="${w}" height="60" rx="8" fill="#fafafa" ${stroke}/>`;
      const tag = s.change !== "same" ? `<text x="${x + 4}" y="62" font-size="10" font-weight="bold">${s.change === "new" ? "NEW" : "CHANGED"}</text>` : "";
      return `${shape}${tag}<text x="${x + w / 2}" y="104" font-size="12" text-anchor="middle">${i + 1}. ${esc(s.label.slice(0, 24))}</text>`;
    })
    .join("");
  const width = 40 + steps.length * (w + 30);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 170" width="${width}" height="170" font-family="sans-serif"><text x="20" y="28" font-size="15" font-weight="bold">${esc(title)}</text>${boxes}</svg>`;
}

function drawWireframe(title: string, regions: string[]): string {
  const blocks = regions.map((r, i) => `<div data-annotation="r${i + 1}" style="border:1px solid #999;padding:12px;margin:8px 0;background:#eee">${esc(r)}</div>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>html{filter:grayscale(100%)}body{font-family:sans-serif;margin:0;padding:16px}</style></head><body><main><h1>${esc(title)}</h1>${blocks}</main></body></html>`;
}

function flowOf(kind: string, id: string, n: number, versions: number, d: { title: string; goal: string; steps: Step[]; screen: { title: string; regions: string[] }; notes: Schemas["SimpleFlowNote"][] }): Flow {
  return {
    title: d.title,
    steps: d.steps.map((s) => s.label),
    screen: d.screen,
    subject_kind: kind,
    subject_id: id,
    version: n,
    versions,
    goal: d.goal,
    nodes: d.steps,
    svg: drawSvg(d.title, d.steps),
    wireframe: drawWireframe(d.screen.title, d.screen.regions),
    touches_screen: true,
    annotations: d.notes,
    made_at: at,
  };
}

const step = (id: string, label: string, feature: string | null, change: Step["change"], kind: Step["kind"] = "step", actor: string | null = null, yes: string | null = null, no: string | null = null): Step => ({
  id,
  label,
  feature,
  change,
  kind,
  section_key: null,
  actor: actor ?? (kind === "decision" ? "App" : "User"),
  yes,
  no,
});

/** Oracle's invented first drawing of a proposal from its words. */
function draft(kind: string, id: string, brief: string): Flow {
  const what = brief.replace(/^[^:]*:\s*/, "").trim() || "The new flow";
  return flowOf(kind, id, 1, 1, {
    title: what.length > 60 ? `${what.slice(0, 57)}…` : what,
    goal: "Teammate invited in week one",
    steps: [
      step("s1", "Open the home page", "Progress meter", "same"),
      step("s2", "See the next step", what.slice(0, 40), "new", "step", "App"),
      step("s3", "Is the user signed in?", null, "new", "decision", "App", "The next step opens.", "The sign-in page opens."),
      step("s4", "Finish the step", "Setup checklist", "changed"),
      step("s5", "Approve the finished setup", null, "new", "step", "Admin"),
    ],
    screen: { title: "Home", regions: ["Header", "Next step card", "Progress meter"] },
    notes: [
      { n: 1, target: "s2", note: "The new step the proposal adds", section_key: "build", requirement: "R1" },
      { n: 2, target: "r2", note: "Where the next step shows on the home page", section_key: "build", requirement: null },
    ],
  });
}

export function seedVisuals(): VisualsDb {
  // The walk: Oracle's first drawing of Alert history export fails; Retry draws it.
  const db: VisualsDb = {
    visuals: {},
    failOnce: [`feature:${stableUuid("simple-item/alert-export")}`],
    names: { [`feature:${stableUuid("simple-item/alert-digest")}`]: "F-06 Weekly alert digest", [`feature:${stableUuid("simple-item/alert-export")}`]: "Alert history export" },
  };
  const failBet = typeof localStorage === "undefined" ? null : localStorage.getItem(MOCK_VISUAL_FAIL_KEY);
  if (failBet) db.failOnce!.push(`one_pager_line:${betSubject(failBet)}`);
  const bet = betSubject("A setup checklist that shows the next step");
  add(db, "one_pager_line", bet, "A setup checklist that shows the next step", flowOf("one_pager_line", bet, 1, 1, {
    title: "Finish setup from the checklist",
    goal: "Setup finished in a day",
    steps: [step("s1", "Sign in as a new admin", null, "same"), step("s2", "See the setup checklist", "Setup checklist", "new"), step("s3", "Invite now or later?", null, "new", "decision", "User", "The invite form opens.", "The checklist moves on and asks again tomorrow."), step("s4", "Invite a teammate", "Invite suggestions", "changed"), step("s5", "See the progress meter fill", "Progress meter", "new")],
    screen: { title: "Home with the checklist", regions: ["Header", "Setup checklist: 4 steps", "Invite suggestions", "Progress meter"] },
    notes: [
      { n: 1, target: "s2", note: "The checklist shows the next step", section_key: "build", requirement: "R1" },
      { n: 2, target: "s3", note: "Admins may skip inviting for now", section_key: "build", requirement: "R2" },
      { n: 3, target: "r2", note: "The checklist region", section_key: "build", requirement: "R1" },
    ],
  }));
  // A bet Oracle queued with the page whose job drew nothing: a visual with no version yet.
  add(db, "one_pager_line", betSubject("A sample project created on day one"), "A sample project created on day one");
  const mobile = stableUuid("simple-item/alert-mobile");
  add(db, "feature", mobile, "Mobile alert push", flowOf("feature", mobile, 1, 1, {
    title: "Act on a pushed alert",
    goal: "Fewer missed alerts",
    // The flows review: a long flow (8 steps) with a word longer than its box.
    steps: [
      step("s1", "Get the push", "Mobile alert push", "new"),
      step("s2", "Open the alert", null, "same"),
      step("s3", "See what crossed the line", "Alert rules", "changed"),
      step("s4", "Check the alert-history-timeline", "Alert rules", "same"),
      step("s5", "Is it still firing?", null, "new", "decision", "App", "The snooze and assign buttons show.", "The alert is marked resolved."),
      step("s6", "Snooze or assign it", null, "new"),
      step("s7", "Tell the assignee", null, "new", "step", "App"),
      step("s8", "Close the alert", null, "same"),
    ],
    screen: { title: "Alert on a phone", regions: ["Header: rule and time", "What crossed the line", "Chart of the last day", "Snooze and Assign buttons"] },
    notes: [{ n: 1, target: "s1", note: "The push names the rule", section_key: "alerts", requirement: "R4" }],
  })).failure = "Oracle could not draw it"; // The walk-fixes review: its redraw failed, no comment open.
  return db;
}

function add(db: VisualsDb, kind: string, id: string, brief: string, first?: Flow): MockVisual {
  const v: MockVisual = { kind, id, brief, versions: first ? [first] : [], comments: [], made_by: first ? [null] : [] };
  db.visuals[`${kind}:${id}`] = v;
  return v;
}

/** A plain bundle (title, steps, screen) as the API serves it: version 1 of 1, no drawing yet. */
export const plainFlow = (f: Pick<Flow, "title" | "steps" | "screen"> & Partial<Flow>): Flow => ({
  version: 1,
  versions: 1,
  nodes: [],
  touches_screen: true,
  annotations: [],
  ...f,
});

/** The newest drawing of a subject's visual (train T's `flow` fields); null: "No flow yet". */
export function flowFor(db: VisualsDb | undefined, kind: string, id: string): Flow | null {
  const v = db?.visuals[`${kind}:${id}`];
  return v?.versions.at(-1) ?? null;
}

/** The one-pager's shape of a flow. */
export function onePagerFlow(f: Flow | null): Schemas["OnePagerFlow"] | null {
  return f ? { title: f.title, steps: f.steps, screen: f.touches_screen ? f.screen.title : null, subject_kind: f.subject_kind, subject_id: f.subject_id, version: f.version } : null;
}

/** Oracle drafts the visual WITH the proposal (the API's request_visual hook). */
export function requestVisual(db: VisualsDb | undefined, kind: string, id: string, brief: string): void {
  if (!db || db.visuals[`${kind}:${id}`]) return;
  add(db, kind, id, brief, draft(kind, id, brief));
}

function out(v: MockVisual | undefined, kind: string, id: string, ctx: Ctx, documentId?: string | null, name?: string | null): Schemas["SimpleVisualOut"] {
  const owner = (RANK[ctx.role] ?? 0) >= RANK.owner;
  const askable = !UNASKABLE.includes(kind) && (kind !== "one_pager_line" || !!documentId);
  if (!v) return { subject_kind: kind, subject_id: id, flow: null, versions: [], comments: [], pending: false, failed: false, failure: null, started_at: null, stage: 0, subject_name: null, can_comment: false, can_revise: owner && askable };
  const n = v.versions.length;
  return {
    subject_kind: kind,
    subject_id: id,
    brief: v.brief,
    flow: n ? { ...v.versions[n - 1], versions: n } : null,
    versions: v.versions
      .map((f, i) => ({ number: f.version, title: f.title, made_at: f.made_at ?? at, made_by_name: v.made_by[i] ? (ctx.names[v.made_by[i]!] ?? "someone") : null, addressed: v.comments.filter((c) => c.addressed_in === f.version).length }))
      .reverse(),
    comments: v.comments,
    pending: !!v.pending,
    failed: !v.pending && !!v.failure,
    failure: v.pending ? null : (v.failure ?? null),
    // As the API: while the job runs, when it was asked for, how far it got (queued 0,
    // running 1: here past half its time) and the subject with its code.
    started_at: v.pending && v.queued_at ? new Date(v.queued_at).toISOString() : null,
    stage: v.pending && Date.now() - (v.queued_at ?? 0) >= jobMs() / 2 && jobMs() > 0 ? 1 : 0,
    subject_name: v.pending ? (name ?? (v.brief || null)) : null,
    can_comment: n > 0 && (RANK[ctx.role] ?? 0) >= RANK.commenter,
    can_revise: owner,
  };
}

/** The subject's name as the API's subject_name: an item by its code and title, else the seeded name. */
const nameOf = (db: VisualsDb, ctx: Ctx, kind: string, id: string): string | null =>
  db.names?.[`${kind}:${id}`] ?? (kind === "feature" || kind === "draft_item" ? (ctx.itemName?.(id) ?? null) : null);

async function json(status: number, body: unknown): Promise<Response> {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** `/v1/simple/visuals/{kind}/{subject_id}[/versions/{n}|/comments|/revise|/request]`. */
export async function routeSimpleVisuals(db: VisualsDb, ctx: Ctx, req: Request, p: string[]): Promise<Response | null> {
  if (p[1] !== "simple" || p[2] !== "visuals" || p.length < 5) return null;
  const [kind, id] = [p[3], p[4]];
  const key = `${kind}:${id}`;
  const v = db.visuals[key];
  const m = req.method;
  if (m === "GET" && p.length === 5) {
    if (v?.pending && Date.now() - (v.queued_at ?? 0) >= jobMs()) {
      v.pending = false;
      if (db.failOnce?.includes(key)) {
        // The job has ended without a drawing: the panel says so and offers Retry.
        db.failOnce = db.failOnce.filter((k) => k !== key);
        v.failure = "Oracle's drawing did not check out";
      } else {
        // The job has run: version 1 lands.
        v.versions.push({ ...draft(kind, id, v.brief), made_at: new Date().toISOString() });
        v.made_by.push(null);
        v.failure = null;
      }
    }
    return json(200, out(v, kind, id, ctx, new URL(req.url).searchParams.get("document_id"), nameOf(db, ctx, kind, id)));
  }
  if (m === "GET" && p[5] === "versions") {
    const f = v?.versions.find((x) => x.version === Number(p[6]));
    return f ? json(200, { ...f, versions: v!.versions.length }) : json(404, { detail: "No such version" });
  }
  if (m !== "POST") return null;
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (p[5] === "comments") {
    if ((RANK[ctx.role] ?? 0) < RANK.commenter) return json(403, { detail: "Commenters and up comment on a visual" });
    if (!v?.versions.length) return json(409, { detail: "Oracle has not drawn this visual yet" });
    const body = String(b.body ?? "").trim();
    if (!body) return json(422, { detail: "Say what should change" });
    v.comments.push({ id: stableUuid(`simple-visual-comment/${key}/${v.comments.length}`), version: v.versions.at(-1)!.version, annotation: (b.annotation as number | null) ?? null, body, by_name: ctx.names[ctx.id] ?? "someone", at, addressed_in: null });
    return json(201, out(v, kind, id, ctx));
  }
  if (p[5] === "revise") {
    if ((RANK[ctx.role] ?? 0) < RANK.owner) return json(403, { detail: "Only who changes this directly revises its visual" });
    if (!v?.versions.length) return json(409, { detail: "Oracle has not drawn this visual yet" });
    const open = v.comments.filter((c) => c.addressed_in === null);
    const note = String(b.note ?? "").trim();
    // As the API: a note (Retry after a failed redraw) revises with no open comment.
    if (!open.length && !note) return json(409, { detail: "Nothing to revise from: comment first" });
    v.failure = null;
    const cur = v.versions.at(-1)!;
    const n = cur.version + 1;
    const nodes = [...cur.nodes, ...open.map((c, i) => step(`c${n}-${i + 1}`, c.body.slice(0, 40), null, "new"))];
    v.versions.push({ ...cur, version: n, title: `${cur.title} (revised)`, nodes, steps: nodes.map((s) => s.label), svg: drawSvg(`${cur.title} (revised)`, nodes) });
    v.made_by.push(ctx.id);
    for (const c of open) c.addressed_in = n;
    return json(202, out(v, kind, id, ctx));
  }
  if (p[5] === "request") {
    if (UNASKABLE.includes(kind)) return json(422, { detail: "Oracle draws this visual with its proposal; it is not asked for" });
    if ((RANK[ctx.role] ?? 0) < RANK.owner) return json(403, { detail: "Only who changes this directly asks Oracle for its visual" });
    if (kind === "one_pager_line") {
      const doc = b.document_id ? String(b.document_id) : null;
      if (!doc) return json(422, { detail: "A one-pager line's visual is asked for with its PRD" });
      // Queued once: a visual with no drawing (its job drew nothing) is drawn again.
      const cur = v ?? add(db, kind, id, String(b.brief ?? "") || "A bet of the one-pager");
      if (!cur.versions.length) [cur.pending, cur.queued_at] = [true, Date.now()];
      return json(202, out(db.visuals[key], kind, id, ctx, doc, nameOf(db, ctx, kind, id)));
    }
    // The job is queued: the panel reads "drawing" until its next read lands the drawing.
    const cur = v ?? add(db, kind, id, String(b.brief ?? "") || "The new flow");
    if (!cur.versions.length) [cur.pending, cur.queued_at] = [true, Date.now()];
    return json(202, out(db.visuals[key], kind, id, ctx, null, nameOf(db, ctx, kind, id)));
  }
  return null;
}
