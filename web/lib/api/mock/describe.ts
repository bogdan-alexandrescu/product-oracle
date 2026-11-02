/**
 * A proposal as one plain sentence, and who made it (B4 Proposal sentences): a port of
 * api/oracle/baseline/describe.py, so mock mode shows exactly what the API will. Change
 * both together; web/e2e/baseline.spec.ts checks this port against the API's strings.
 */
import type { Schemas } from "@/lib/api/client";
import { mockName as displayName } from "./people";

import { companyDayInWords } from "./connections";

type Entity = Pick<Schemas["EntityOut"], "id" | "type" | "title" | "body" | "status" | "attrs">;
type Edge = Pick<Schemas["EdgeOut"], "id" | "src_id" | "dst_id" | "type" | "status" | "attrs">;
type Proposal = Pick<Schemas["ProposalOut"], "id" | "entity_id" | "edge_id" | "payload" | "run_id" | "actor">;
type Fields = Record<string, unknown>;
export type ProposalProposer = Schemas["ProposalProposer"];

const REMOVED = "an item that was removed";
export const INTAKE_LABEL = "From an intake answer";
const MAX_VALUE = 60;
const MAX_FIELDS = 3;
/** Words of what the two texts share, shown before where a long text change starts. */
const CONTEXT_WORDS = 2;

const EDGE_VERBS: Record<string, string> = {
  supports: "supports",
  depends_on: "depends on",
  blocks: "blocks",
  part_of: "is part of",
  owned_by: "is owned by",
  derived_from: "comes from",
  verifies: "verifies",
  affects: "affects",
  mitigates: "reduces the risk of",
};
const STRENGTHS = ["none", "weak", "medium", "strong"];
const ATTR_LABELS: Record<string, string> = { effort: "effort", current: "current value", contribution: "strength" };
const FIELD_LABELS: Record<string, string> = { title: "title", body: "description", status: "status" };
/** Keys whose values are a fixed set of states: they read capitalized ("planned" -> "Planned"). */
const STATE_KEYS = new Set(["status"]);
const STATE = /^[a-z][a-z0-9_]*$/;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ONLY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SNAKE = /^[a-z0-9]+(?:_[a-z0-9]+)+$/;

const words = (key: string) => key.replaceAll("_", " ");
const possessive = (title: string) => (title.endsWith("s") ? `${title}’` : `${title}’s`);
const isRecord = (v: unknown): v is Fields => !!v && typeof v === "object" && !Array.isArray(v);

function label(key: string, entityType: string | null): string {
  if (key === "status" && entityType === "feature") return "delivery status";
  return ATTR_LABELS[key] ?? words(key);
}

function value(v: unknown, key: string | null, entities: Map<string, Entity>): string {
  if (key === "contribution" && Number.isInteger(v) && (v as number) >= 0 && (v as number) < STRENGTHS.length) {
    return STRENGTHS[v as number];
  }
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) {
    const shown = v.slice(0, MAX_FIELDS).map((x) => value(x, null, entities)).join(", ");
    const more = v.length - MAX_FIELDS;
    return more > 0 ? `${shown} and ${more} more` : shown;
  }
  if (isRecord(v)) return "a new value";
  let text = String(v);
  if (key != null && STATE_KEYS.has(key) && STATE.test(text)) {
    const w = words(text);
    return w.charAt(0).toUpperCase() + w.slice(1);
  }
  if (ONLY_UUID.test(text.trim())) return entities.get(text.trim().toLowerCase())?.title ?? REMOVED;
  if (SNAKE.test(text)) text = words(text);
  text = text.replace(UUID, "an item");
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE)}…` : text;
}

/** [[key, new value]]: top-level fields, then attrs ("attrs.<key>"), in payload order. */
function changes(fields: Fields): [string, unknown][] {
  return Object.entries(fields).flatMap(([k, v]): [string, unknown][] =>
    k === "attrs" && isRecord(v)
      ? Object.entries(v).map(([ak, av]): [string, unknown] => [`attrs.${ak}`, av])
      : k === "id"
        ? []
        : [[k, v]],
  );
}

function old(current: Entity | Edge | undefined, key: string): [boolean, unknown] {
  if (!current) return [false, null];
  if (key.startsWith("attrs.")) {
    const attrs = (current.attrs ?? {}) as Fields;
    const k = key.slice("attrs.".length);
    return [k in attrs && attrs[k] != null, attrs[k]];
  }
  const v = (current as unknown as Fields)[key];
  return [v != null, v];
}

/** Whether a proposed value is the one the item has, as describe.py's _same (deep, like Python's ==). */
function same(was: unknown, next: unknown): boolean {
  if (was == null || next == null) return was == null && next == null;
  if (typeof was === "string" && typeof next === "string" && ONLY_UUID.test(was)) return was.toLowerCase() === next.trim().toLowerCase();
  if (Array.isArray(was) || Array.isArray(next)) {
    return Array.isArray(was) && Array.isArray(next) && was.length === next.length && was.every((x, i) => same(x, next[i]));
  }
  if (isRecord(was) && isRecord(next)) {
    const keys = Object.keys(was);
    return keys.length === Object.keys(next).length && keys.every((k) => k in next && same(was[k], next[k]));
  }
  return was === next;
}

/** The changes whose new value differs from the item's (#262); all when it is gone. */
function real(changed: [string, unknown][], current: Entity | Edge | undefined): [string, unknown][] {
  return current ? changed.filter(([k, v]) => !same(old(current, k)[1], v)) : changed;
}

function excerpt(ws: string[], start: number): string {
  const text = ws.slice(start).join(" ");
  const cut = text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE)}…` : text;
  return start ? `…${cut}` : cut;
}

/** [old, new] as short words; two long texts from just before where they differ, so the
 * cut never leaves two identical prefixes. */
function values(was: unknown, next: unknown, key: string, entities: Map<string, Entity>): [string, string] {
  if (typeof was === "string" && typeof next === "string" && Math.max(was.length, next.length) > MAX_VALUE && !ONLY_UUID.test(next.trim())) {
    const [a, b] = [was, next].map((t) => t.replace(UUID, "an item").split(/\s+/).filter(Boolean));
    const differ = a.findIndex((x, i) => i < b.length && x !== b[i]);
    const start = Math.max(0, (differ < 0 ? Math.min(a.length, b.length) : differ) - CONTEXT_WORDS);
    return [excerpt(a, start), excerpt(b, start)];
  }
  return [value(was, key, entities), value(next, key, entities)];
}

function change(key: string, next: unknown, current: Entity | Edge | undefined, entityType: string | null, entities: Map<string, Entity>) {
  const bare = key.startsWith("attrs.") ? key.slice("attrs.".length) : key;
  const name = (!key.startsWith("attrs.") && FIELD_LABELS[key]) || label(bare, entityType);
  const [known, was] = old(current, key);
  if (next == null) return `${name} cleared${known ? ` (was ${value(was, bare, entities)})` : ""}`;
  if (!known) return `${name} to ${value(next, bare, entities)}`;
  const [before, after] = values(was, next, bare, entities);
  return `${name} to ${after} (was ${before})`;
}

function changedList(clauses: string[]): string {
  const shown = clauses.slice(0, MAX_FIELDS).join(", ");
  const more = clauses.length - MAX_FIELDS;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

function entitySentence(op: string, fields: Fields, target: Entity | undefined, entities: Map<string, Entity>): string {
  if (op === "create") {
    const type = words(String(fields.type || "item"));
    const title = String(fields.title || "a new item");
    const attrs = isRecord(fields.attrs) ? fields.attrs : {};
    return `Add ${type} “${title}”${attrs.proposed_blocker != null ? " (suggested blocker)" : ""}`;
  }
  if (!target && op === "delete") return `Remove ${REMOVED}`;
  const type = target ? words(target.type) : "item";
  const entityType = target ? target.type : null;
  const title = target ? target.title : REMOVED;
  if (op === "delete") return `Remove ${type} “${title}”`;
  const changed = real(changes(fields), target);
  if (changed.length === 0) return `No change to ${title}`;
  const keys = changed.map(([k]) => k).join(",");
  if (keys === "title") return `Rename “${title}” to “${String(changed[0][1])}”`;
  if (keys === "body") return `Rewrite the description of ${title}`;
  if (keys === "status") {
    const status = changed[0][1];
    if (status === "confirmed") return `Confirm ${type} ${title}`;
    if (status === "rejected") return `Reject ${type} ${title}`;
    return `Mark ${title} as proposed again`;
  }
  if (changed.length === 1) {
    const [key, next] = changed[0];
    const bare = key.startsWith("attrs.") ? key.slice("attrs.".length) : key;
    const [known, was] = old(target, key);
    if (next == null) return `Clear ${possessive(title)} ${label(bare, entityType)}${known ? ` (was ${value(was, bare, entities)})` : ""}`;
    if (!known) return `Set ${possessive(title)} ${label(bare, entityType)} to ${value(next, bare, entities)}`;
    const [before, after] = values(was, next, bare, entities);
    return `Set ${possessive(title)} ${label(bare, entityType)} to ${after} (was ${before})`;
  }
  return `Change ${title}: ${changedList(changed.map(([k, v]) => change(k, v, target, entityType, entities)))}`;
}

function edgeSentence(op: string, fields: Fields, target: Edge | undefined, entities: Map<string, Entity>): string {
  const title = (id: unknown) => entities.get(String(id).toLowerCase())?.title ?? REMOVED;
  if (op === "create") {
    const [src, dst, type] = [title(fields.src_id), title(fields.dst_id), String(fields.type)];
    if (type === "supports") {
      const c = (isRecord(fields.attrs) ? fields.attrs : {}).contribution;
      const strength = Number.isInteger(c) && (c as number) >= 0 && (c as number) < STRENGTHS.length ? STRENGTHS[c as number] : "some";
      return `Link ${src} to goal ${dst} (${strength} support)`;
    }
    return `Add link: ${src} ${EDGE_VERBS[type] ?? words(type)} ${dst}`;
  }
  if (!target) return op === "delete" ? "Remove a link that was removed" : "Change a link that was removed";
  const link = `${title(target.src_id)} ${EDGE_VERBS[target.type] ?? words(target.type)} ${title(target.dst_id)}`;
  if (op === "delete") return `Remove link: ${link}`;
  const changed = real(changes(fields), target);
  if (changed.length === 0) return `No change to link ${link}`;
  return `Change link ${link}: ${changedList(changed.map(([k, v]) => change(k, v, target, null, entities)))}`;
}

/** The proposal as one sentence; `awaiting` for a question-only intake proposal. */
export function describe(p: Proposal, entities: Entity[], edges: Edge[], awaiting = false): string {
  const payload = (p.payload ?? {}) as Fields;
  const fields = isRecord(payload.fields) ? payload.fields : {};
  const byId = new Map(entities.map((e) => [e.id.toLowerCase(), e]));
  if (awaiting) {
    const category = (isRecord(fields.attrs) ? fields.attrs : {}).category || "a question";
    return `Waiting for the author to share an answer (${words(String(category))})`;
  }
  const op = String(payload.op || "update");
  const targetId = typeof fields.id === "string" ? fields.id : undefined;
  if (payload.kind === "edge") {
    const id = p.edge_id ?? targetId;
    return edgeSentence(op, fields, id ? edges.find((e) => e.id === id) : undefined, byId);
  }
  const id = p.entity_id ?? targetId;
  return entitySentence(op, fields, id ? byId.get(id.toLowerCase()) : undefined, byId);
}

/** "Baseline to PRD · Oct 16", the day the run started in the Company time zone, as the API writes it. */
export function runLabel(run: Schemas["ProposalRun"]): string {
  return `${run.flow_title} · ${companyDayInWords(run.created_at)}`;
}

function fromIntake(payload: Fields): boolean {
  const fields = isRecord(payload.fields) ? payload.fields : {};
  const attrs = isRecord(fields.attrs) ? fields.attrs : {};
  return "gap_id" in attrs || "proposed_blocker" in attrs;
}

/** The id in an audit actor string ("<kind>:<id>") when it is of that kind, as describe.py's actor_id. */
function actorId(p: Proposal, kind: "user" | "token"): string | null {
  const at = (p.actor ?? "").indexOf(":");
  return at > 0 && p.actor!.slice(0, at) === kind ? p.actor!.slice(at + 1) || null : null;
}

/** Who made a proposal, as ProposalOut.proposer names it. */
export function proposer(
  p: Proposal,
  lookup: {
    run: Schemas["ProposalRun"] | null;
    memberEmail?: (userId: string) => string | null;
    tokenName?: (tokenId: string) => string | null;
  },
): ProposalProposer {
  const none = { run_id: null, user_id: null, email: null };
  if (lookup.run) return { ...none, kind: "run", label: runLabel(lookup.run), run_id: lookup.run.id };
  if (p.run_id || p.actor?.startsWith("run:")) return { ...none, kind: "run", label: "A run that was removed" };
  // Never the person: which answer made it is the finding author's (S6).
  if (fromIntake((p.payload ?? {}) as Fields)) return { ...none, kind: "intake", label: INTAKE_LABEL };
  const userId = actorId(p, "user");
  if (userId) {
    const email = lookup.memberEmail?.(userId) ?? null;
    return { ...none, kind: "person", label: email ? displayName(email) : "A former member", user_id: userId, email };
  }
  const apiTokenId = actorId(p, "token");
  if (apiTokenId) {
    const name = lookup.tokenName?.(apiTokenId) ?? null;
    return { ...none, kind: "token", label: name ? `API token “${name}”` : "An API token" };
  }
  return { ...none, kind: "oracle", label: "Oracle" };
}
