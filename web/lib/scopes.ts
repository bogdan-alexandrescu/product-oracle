/**
 * API scopes in plain words (qa-settings-16): one map for Settings > API tokens, My account
 * and the OAuth consent screen. The code (oracle:read) is the API's; people read the label,
 * with the code in its title.
 */

/** Each scope the API grants, by its code. */
export const SCOPE_LABEL: Record<string, string> = {
  "oracle:read": "Read",
  "oracle:write": "Write",
  // A run's own token (api/oracle/runtokens.py SCOPES).
  "read:sources": "Read sources",
  "read:baseline": "Read the baseline",
  "read:documents": "Read documents",
  "read:web": "Search the web",
  "read:intake-input": "Read the intake",
  "write:proposals": "Write proposals",
  "write:drafts": "Write drafts",
};

/** A scope in words: "Read"; an unknown one from its code ("read:foo-bar" reads "Read foo bar"). */
export function scopeLabel(code: string): string {
  const known = SCOPE_LABEL[code];
  if (known) return known;
  const words = code.replace(/[:_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A credential's scopes in words: "Read and write" for both of a member's scopes, else each label, comma-joined. */
export function scopesText(codes: readonly string[]): string {
  if (codes.length === 2 && codes.includes("oracle:read") && codes.includes("oracle:write")) return "Read and write";
  return codes.map(scopeLabel).join(", ");
}

/** The codes behind the words, for a title: "oracle:read, oracle:write". */
export const scopesCodes = (codes: readonly string[]) => codes.join(", ");
