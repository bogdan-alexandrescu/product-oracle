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
    case "cut_with_dependents": {
      const rest = ((target.titles as string[] | undefined) ?? []).slice(1);
      if (!rest.length) return `cut ${x} and its dependents`;
      return `cut ${x} and its dependents ${rest.length === 1 ? rest[0] : `${rest.slice(0, -1).join(", ")} and ${rest[rest.length - 1]}`}`;
    }
    case "edit_title": return title ? `renamed ${x} to ${title}` : `renamed ${x}`;
    case "edit_outcome": return `changed the outcome of ${x}`;
    case "edit_note": return `changed the notes of ${x}`;
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
    case "set_goals": return `moved ${x} to another goal`;
    case "add_feature_ask": return title ? `filed the feature ask ${title}` : "filed a feature ask";
    case "set_owner": return `changed the owner of ${x}`;
    case "set_confidence": return `changed the confidence of ${x}`;
    case "set_track": return `changed the track of ${x}`;
    case "set_prd": return `changed the PRD of ${x}`;
    case "set_goal": return `changed the goal of ${x}`;
    case "set_depends": return `changed what ${x} depends on`;
    case "set_goal_measure": return `changed how the goal of ${x} is measured`;
    case "set_status": return `marked ${x} ${after.status ?? "planned"}`;
    case "set_decider": return `changed the decider of ${x}`;
    // prd-questions: a PRD question (a decision) answered, or its decider named.
    case "decide_question": return `decided ${x}`;
    // Goal milestones (goal_milestones): a roadmap's own milestone changed, or removed.
    case "edit_goal_milestone": {
      const name = quoted(target.name) ?? item;
      if ("milestone" in before && after.milestone === null) return name ? `removed the milestone ${name}` : "removed a milestone";
      return name ? `changed the milestone ${name}` : "changed a milestone";
    }
    case "name_decider": return `named who decides ${x}`;
    // trash-features-goals: a feature moved to Trash (its name reads "(deleted)" once it is gone).
    case "delete_item": return `moved ${x} to Trash`;
    // edit-goals-prds: a goal archived or moved to Trash (goal_asks).
    case "archive_goal": return `archived the goal ${quoted(target.title) ?? "a goal"}`;
    case "delete_goal": return `moved the goal ${quoted(target.title) ?? "a goal"} to Trash`;
    case "unarchive_goal": return `restored the goal ${quoted(target.title) ?? "a goal"}`;
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
  const what = changePhrase(c.op, target, before, after, item);
  let words = `${who} ${what}`;
  // What was asked, not done: "proposed: move F-26 Alert rules engine to Trash" (change_words.describe).
  const asked = c.op === "delete_item" || c.op === "delete_goal" ? `move${what.slice("moved".length)}` : c.op === "archive_goal" ? `archive${what.slice("archived".length)}` : c.op === "unarchive_goal" ? `restore${what.slice("restored".length)}` : what;
  if (c.status === "proposed") words = `${who} proposed: ${asked}`;
  else if (c.status === "declined") words = `${who} proposed: ${asked} · declined`;
  if (undone) words += " · undone";
  return words;
}
