/**
 * A line as people know it: its first words, quoted (qa-simple-prd-19: never "line 7"); ""
 * for a line with no words, so a caller falls back to another name.
 */
export function quoteLine(text: string | undefined): string {
  const words = (text ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return "";
  return `“${words.slice(0, 5).join(" ")}${words.length > 5 ? "…" : ""}”`;
}
