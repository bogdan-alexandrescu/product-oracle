/**
 * Unfilled template placeholders as an import writes them (lowercase "[n]", "[x]", "[#]", "[?]", "[tbd]"; "[n] of
 * [n]" and "[n] out of [n]" as one), as the API's oracle.baseline.goals.PLACEHOLDER reads them: a goal's name or
 * description is never written with one, and a value holding one reads as missing. A capitalised or other bracketed
 * word ("Project [X]", "Price [Value]") is a real name and stays.
 */
const ONE = String.raw`\[(?:n|x|#|\?|tbd)\]%?`;
/** A "%", "/" or "of" (any case) whose only operand was a placeholder ("[n]%", "[n]/[n]", "[n] OF [n]", "3/[n]") goes with it. */
const SLASH = String.raw`\s*/\s*`;
const JOIN = String.raw`${SLASH}|\s+(?:[Oo][Ff]|[Oo][Uu][Tt] [Oo][Ff])\s+`;
const PLACEHOLDER = new RegExp(String.raw`(?:${SLASH})?${ONE}(?:(?:${JOIN})${ONE})?(?:${SLASH})?`, "g");

/** Whether `text` holds an unfilled placeholder. */
export function hasPlaceholder(text: unknown): boolean {
  return typeof text === "string" && new RegExp(PLACEHOLDER.source).test(text);
}

/** `text` with no unfilled placeholder, as goals.without_placeholders: "[n] of [n] live helpers" -> "live helpers". */
export function withoutPlaceholders<T extends string | null | undefined>(text: T): T {
  if (!text || !hasPlaceholder(text)) return text;
  const out = text
    .replace(PLACEHOLDER, "")
    // Spaces include a non-breaking one; an emptied "( )" goes before the spaces are tidied.
    .replace(/\([ \t\u00a0]*\)/g, "")
    .replace(/[ \t\u00a0]{2,}/g, " ")
    .replace(/[ \t\u00a0]+([,.;:!?)])/g, "$1");
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
