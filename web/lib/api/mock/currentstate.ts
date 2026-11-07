/**
 * Running today (api/oracle/currentstate): GET /v1/feature-states and the owner's moves,
 * over the mock's Simple features (the priorities' rows). Invented proof: a few features run
 * today (one with proof 41 days old), a few are being built (two with every proof in), the rest
 * are new. Check again re-reads the proof; the owner answers; Move / Not yet; Mark as shipped.
 */
import type { Schemas } from "@/lib/api/client";

type State = Schemas["FeatureStateOut"];
type Proof = Schemas["FeatureProofOut"];
type Row = { feature_id: string; item_id?: string | null; code: string; title: string; milestone?: string | null; goal?: { title: string } | null };

export interface CurrentStateDb {
  // Per feature: what the API stores (feature_states and feature_proofs).
  states: Record<string, { status: "desired" | "shipped" | "current"; shipped_at: string | null; checked_at: string | null; moved_at: string | null; move_how: State["move_how"]; not_yet_at: string | null; answer: State["answer"]; answered_at: string | null; proofs: Proof[] }>;
}

const DAY = 86_400_000;
const AREAS = ["Sign-up and onboarding", "Billing", "Search", "Phone app", "Reports", "Teams and sharing"];

// Invented proof for the features that run today: files, pull requests, tasks, the measured value, days since checked.
const RUNNING: [number, number, number, string, number, number][] = [
  [14, 6, 9, "92% sign in on first try", 1, 233],
  [9, 4, 6, "3,410 sent last month", 41, 168],
  [31, 11, 17, "1.8% of payments fail", 2, 216],
  [12, 5, 8, "71% found in one try", 3, 148],
  [7, 3, 5, "44% open it", 4, 127],
];
const BUILDING: [number, number, number, number, string | null][] = [
  [10, 4, 7, 7, "Used by 212 people in the test group"],
  [8, 3, 6, 6, "Failed payments down to 1.3% in the test group"],
  [6, 2, 3, 8, null],
  [4, 1, 2, 9, null],
];

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function proofs(files: number, prs: number, done: number, total: number, value: string | null, at: string | null, period: string | null): Proof[] {
  return [
    { kind: "code_map", count: files, total: null, value: null, period: null, ok: files > 0, still_true: null, checked_at: at, note: null },
    { kind: "pull_requests", count: prs, total: null, value: null, period: null, ok: prs > 0, still_true: null, checked_at: at, note: null },
    { kind: "tasks", count: done, total, value: null, period: null, ok: total > 0 && done === total, still_true: null, checked_at: at, note: null },
    { kind: "measured", count: null, total: null, value, period, ok: !!value, still_true: null, checked_at: at, note: null },
  ];
}

/**
 * The default company's story by item (the specs' own): Weekly alert digest, Alert routing by team
 * (its proof 41 days old) and Welcome video run today, whatever else the ranking holds (P-1 put
 * the Goal map's features in it, later items moved the ranks after them).
 */
const STORY_RUNNING = ["alert-digest", "alert-sso", "setup-video"];

/** The seed: which of the rows run today (the story's items, else by rank) and which are being built (by rank). */
export function seedCurrentState(rows: Row[], today: number): CurrentStateDb {
  const states: CurrentStateDb["states"] = {};
  const iso = (days: number) => new Date(today - days * DAY).toISOString();
  const story = STORY_RUNNING.map((k) => rows.findIndex((r) => r.code === k));
  const running = story.every((i) => i >= 0) ? story : [2, 6, 8, 19, 26].filter((i) => i < rows.length);
  const building = [0, 1, 3, 5].filter((i) => i < rows.length && !running.includes(i));
  running.forEach((i, k) => {
    const [files, prs, tasks, value, days, shipped] = RUNNING[k];
    const at = iso(days);
    const period = MONTH[new Date(today - (days + 30) * DAY).getUTCMonth()];
    states[rows[i].feature_id] = { status: "current", shipped_at: iso(shipped), checked_at: at, moved_at: null, move_how: null, not_yet_at: null, answer: null, answered_at: null, proofs: proofs(files, prs, tasks, tasks, value, at, period) };
  });
  building.forEach((i, k) => {
    const [files, prs, done, total, value] = BUILDING[k];
    const at = iso(0);
    states[rows[i].feature_id] = { status: "desired", shipped_at: null, checked_at: at, moved_at: null, move_how: null, not_yet_at: null, answer: null, answered_at: null, proofs: proofs(files, prs, done, total, value, at, value ? MONTH[new Date(today).getUTCMonth()] : null) };
  });
  return { states };
}

function stateOut(db: CurrentStateDb, r: Row, i: number, today: number): State {
  const s = db.states[r.feature_id];
  const ps = s?.proofs ?? [];
  const exists = !!s && (s.status === "current" || s.status === "shipped") && s.answer !== "no_longer_runs";
  const days = s?.checked_at ? Math.floor((today - Date.parse(s.checked_at)) / DAY) : null;
  const anyProof = ps.some((p) => (p.count ?? 0) > 0 || !!p.value);
  const allIn = ps.length === 4 && ps.every((p) => p.ok);
  const lastProof = Math.max(0, ...ps.map((p) => (p.checked_at ? Date.parse(p.checked_at) : 0)));
  const ready = !exists && allIn && !(s?.not_yet_at && Date.parse(s.not_yet_at) >= lastProof);
  const mark: State["mark"] = exists ? (days !== null && days > 30 ? "exists_old" : "exists") : anyProof ? "in_progress" : "new";
  const thisMonth = MONTH[new Date(today).getUTCMonth()];
  return {
    feature_id: r.feature_id,
    code: r.code,
    title: r.title,
    area: AREAS[i % AREAS.length],
    goal: r.goal?.title ?? null,
    milestone: r.milestone ?? null,
    mark,
    shipped_at: exists ? (s?.shipped_at ?? null) : null,
    checked_at: s?.checked_at ?? null,
    proof_days: days,
    no_proof_yet: exists && !anyProof,
    ready,
    checking: false,
    answer: s?.answer ?? null,
    answered_at: s?.answered_at ?? null,
    moved_at: s?.moved_at ?? null,
    move_how: s?.move_how ?? null,
    // The mock's features stand for its roadmap items (simple-priorities.ts: feature-<item id>).
    item_ids: [r.item_id ?? r.feature_id.replace(/^feature-/, "")],
    proofs: ps.map((p) => ({ ...p, note: p.kind === "measured" && p.value && p.period && p.period !== thisMonth ? "not read yet" : null })),
  };
}

export function featureStatesOut(db: CurrentStateDb, rows: Row[], mayMove: boolean, today: number): Schemas["FeatureStatesOut"] {
  const features = rows.map((r, i) => stateOut(db, r, i, today));
  const count = (k: State["mark"]) => features.filter((f) => f.mark === k).length;
  return {
    features,
    running: count("exists") + count("exists_old"),
    old_proof: count("exists_old"),
    in_progress: count("in_progress"),
    new: count("new"),
    desired: count("in_progress") + count("new"),
    ready: features.filter((f) => f.ready).length,
    can_move: mayMove,
    can_answer: mayMove,
  };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** /v1/feature-states (api/oracle/currentstate/router.py). Writes need the approver role (confirm_entity). */
export async function routeCurrentState(db: CurrentStateDb, rows: Row[], mayMove: boolean, req: Request, p: string[], today: number): Promise<Response | null> {
  if (p[1] !== "feature-states") return null;
  const m = req.method;
  if (p.length === 2 && m === "GET") return json(200, featureStatesOut(db, rows, mayMove, today));
  if (p.length !== 4 || m !== "POST") return null;
  if (!mayMove) return json(403, { detail: "Requires the approver role" });
  const i = rows.findIndex((r) => r.feature_id === p[2]);
  if (i < 0) return json(404, { detail: "Feature not found" });
  const r = rows[i];
  const now = new Date(today).toISOString();
  const s = (db.states[r.feature_id] ??= { status: "desired", shipped_at: null, checked_at: null, moved_at: null, move_how: null, not_yet_at: null, answer: null, answered_at: null, proofs: [] });
  const body = JSON.parse((await req.text()) || "null") as { answer?: State["answer"]; decision?: "move" | "not_yet" } | null;
  if (p[3] === "check") {
    // Oracle re-reads each proof: the measured value of a past month is not read for this one yet.
    const thisMonth = MONTH[new Date(today).getUTCMonth()];
    s.proofs = s.proofs.map((x) => ({ ...x, checked_at: now, still_true: x.kind === "measured" && x.period && x.period !== thisMonth ? false : true }));
    return json(200, { ...stateOut(db, r, i, today), checking: false });
  }
  if (p[3] === "answer") {
    s.answer = body?.answer ?? null;
    s.answered_at = now;
    if (s.answer === "still_runs") s.checked_at = now;
    if (s.answer === "no_longer_runs") s.status = "desired";
    return json(200, stateOut(db, r, i, today));
  }
  if (p[3] === "move") {
    if (body?.decision === "not_yet") {
      s.not_yet_at = now;
      return json(200, stateOut(db, r, i, today));
    }
    if (!stateOut(db, r, i, today).ready) return json(409, { detail: "Its proof is not all in yet" });
    Object.assign(s, { status: "current", moved_at: now, move_how: "owner_confirmed", shipped_at: s.shipped_at ?? now, checked_at: now, answer: null, answered_at: null });
    return json(200, stateOut(db, r, i, today));
  }
  if (p[3] === "shipped") {
    if (s.status !== "current") Object.assign(s, { status: "shipped", shipped_at: now, move_how: "marked_shipped" });
    return json(200, stateOut(db, r, i, today));
  }
  return null;
}
