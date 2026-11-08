/**
 * Unfilled template placeholders ("[n]", "[N]", "[X]", "[TBD]", "[?]", "[#]", "[number]"; "[n] of [n]" as one), as
 * the API's oracle.baseline.goals.PLACEHOLDER reads them: a goal's name or description is never written with one,
 * and a value holding one reads as missing.
 */
const ONE = String.raw`\[(?:n|x|#|\?|tbd|number|num|value)\]`;
const PLACEHOLDER = new RegExp(String.raw`${ONE}(?:\s+(?:of|out of)\s+${ONE})?`, "gi");

/** Whether `text` holds an unfilled placeholder. */
export function hasPlaceholder(text: unknown): boolean {
  return typeof text === "string" && new RegExp(PLACEHOLDER.source, "i").test(text);
}

/** `text` with no unfilled placeholder, as goals.without_placeholders: "[n] of [n] live helpers" -> "live helpers". */
export function withoutPlaceholders<T extends string | null | undefined>(text: T): T {
  if (!text || !hasPlaceholder(text)) return text;
  const out = text
    .replace(PLACEHOLDER, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([,.;:!?)])/g, "$1")
    .replace(/\([ \t]*\)/g, "");
  return out
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim() as T;
}

/**
 * A goal's name as shown, as goals.goal_name reads it: no unfilled placeholder, its key in words when nothing else
 * is left. A name stored before the guard reads the same as one written after it.
 */
export function goalName(title: string, key?: string | null): string {
  return (withoutPlaceholders(title) ?? "").trim() || (key ?? "").replace(/[-_]/g, " ");
}

/** An entry's name as shown: a goal's through goalName, any other's as stored. */
export function shownTitle(e: { type: string; title: string; key: string }): string {
  return e.type === "goal" ? goalName(e.title, e.key) : e.title;
}

/** An entry's description as shown: a goal's without placeholders, any other's as stored. */
export function shownBody<T extends string | null | undefined>(e: { type: string; body?: T }): T | undefined {
  return e.type === "goal" ? withoutPlaceholders(e.body) : e.body;
}
