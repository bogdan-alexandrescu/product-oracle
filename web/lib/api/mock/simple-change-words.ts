/**
 * The walk (H2): a Simple change in plain words, as api/oracle/simple/change_words.py says it
 * for Home's "Since your last visit": who, what, the item's code and name, "· undone" once
 * undone. Never the op's internal name; an op without a sentence reads "changed <the item>".
 */
type Values = Record<string, unknown>;

const HORIZON_WORDS: Record<string, string> = { now: "Now", next: "Next", later: "Later" };

function quoted(value: unknown, limit = 80): string | null {
  const text = String(value ?? "").split(/\s+/).filter(Boolean).join(" ");
  if (!text) return null;
  return `“${text.slice(0, limit)}${text.length > limit ? "…" : ""}”`;
}

function keyDate(before: Values, after: Values): string {
  const kd = (after.key_date ?? before.key_date ?? {}) as Values;
  const name = quoted(kd && typeof kd === "object" ? kd.name : null);
  return name ? `the key date ${name}` : "a key date";
}

/** What was done, without who: "changed the estimate of F-08 Billing page". */
export function changePhrase(op: string, target: Values, before: Values, after: Values, item: string | null): string {
  const x = item ?? quoted(after.title ?? target.title) ?? "an item";
  const on = item ? ` on ${item}` : "";
  const title = quoted(after.title);
  const status = after.status ? String(after.status).replace(/_/g, " ") : null;
  switch (op) {
    case "move_dates": return `moved the dates of ${x}`;
    case "accept_date_suggestion": return `accepted Oracle's dates for ${x}`;
    case "change_horizon": {
      const h = HORIZON_WORDS[String(after.horizon)];
      return h ? `moved ${x} to ${h}` : `moved ${x} to another horizon`;
    }
    case "reorder": return `reordered ${x}`;
    case "cut": return `cut ${x}`;
    case "restore": return `restored ${x}`;
    case "edit_title": return title ? `renamed ${x} to ${title}` : `renamed ${x}`;
    case "edit_outcome": return `changed the outcome of ${x}`;
    case "accept_risk": return `accepted a risk on ${x}`;
    case "shift_dependents": return `moved ${x} and its dependents after what it depends on`;
    case "move_dependency": return `moved what ${x} depends on`;
    case "override_priority": return `changed the priority of ${x}`;
    case "add_item_task": return title ? `added the task ${title} to ${x}` : `added a task to ${x}`;
    case "edit_item_task": return `changed a task on ${x}`;
    case "set_item_task_status": return status ? `marked a task on ${x} ${status}` : `changed a task on ${x}`;
    case "add_action_item": return title ? `added the action item ${title}${on}` : `added an action item${on}`;
    case "edit_action_item": return `changed an action item${on}`;
    case "set_action_item_status": return status ? `marked an action item${on} ${status}` : `changed an action item${on}`;
    case "add_launch_task": return title ? `added the launch task ${title} to ${x}` : `added a launch task to ${x}`;
    case "set_launch_task_status": return status ? `marked a launch task of ${x} ${status}` : `changed a launch task of ${x}`;
    case "estimate_feature": return `changed the estimate of ${x}`;
    case "confirm_item": return `confirmed ${x}`;
    case "edit_line": {
      const line = quoted(after.line);
      return line ? `edited a one-pager line to ${line}` : "edited a one-pager line";
    }
    case "add_key_date": return `added ${keyDate(before, after)}`;
    case "edit_key_date": return `changed ${keyDate(before, after)}`;
    case "remove_key_date": return `removed ${keyDate(before, after)}`;
    case "add_item": return `added ${x}`;
    case "merge_item": {
      const into = [target.code, target.title].map((v) => String(v ?? "")).join(" ").trim();
      return into ? `merged ${x} into ${into}` : `merged ${x}`;
    }
    case "keep_both": return `kept ${x} beside its look-alikes`;
    case "set_milestone": {
      const m = after.milestone as Values | null | undefined;
      if (m === null && "milestone" in after) return `cleared the milestone of ${x}`;
      const name = m && typeof m === "object" ? quoted(m.name) : null;
      return name ? `set the milestone of ${x} to ${name}` : `set the milestone of ${x}`;
    }
    case "add_feature_ask": return title ? `filed the feature ask ${title}` : "filed a feature ask";
    case "set_owner": return `changed the owner of ${x}`;
    case "set_decider": return `changed the decider of ${x}`;
    // prd-questions: a PRD question (a decision) answered, or its decider named.
    case "decide_question": return `decided ${x}`;
    case "name_decider": return `named who decides ${x}`;
  }
  return `changed ${x}`;
}

/** The whole sentence: "Ana changed the estimate of F-08 Billing page · undone" (change_words.sentence). */
export function changeSentence(
  c: { op: string; target: Values; before: Values; after: Values; status: string },
  who: string,
  item: string | null,
  undone: boolean,
): string {
  const target = c.target ?? {};
  const before = c.before ?? {};
  const after = c.after ?? {};
  if (c.status === "undone") return `${who} undid: ${changePhrase(c.op, target, after, before, item)}`;
  let words = `${who} ${changePhrase(c.op, target, before, after, item)}`;
  if (c.status === "proposed") words = `${who} proposed: ${changePhrase(c.op, target, before, after, item)}`;
  else if (c.status === "declined") words = `${who} proposed: ${changePhrase(c.op, target, before, after, item)} · declined`;
  if (undone) words += " · undone";
  return words;
}
