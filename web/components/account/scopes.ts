/**
 * Credential scopes in plain words, shared by My account, Settings > API tokens and the
 * OAuth consent screen (qa-settings-28). The API's scope codes stay the keys; people read
 * the labels. Each label matches what the consent screen explains for that scope.
 */
export const SCOPE_LABEL: Record<string, string> = {
  // Personal tokens and MCP clients (oracle.auth).
  "oracle:read": "Read",
  "oracle:write": "Write",
  // A run's token for its agents (oracle.runtokens.SCOPES).
  "read:sources": "Read sources",
  "read:baseline": "Read the baseline",
  "read:documents": "Read documents",
  "read:web": "Search the web",
  "read:intake-input": "Read the intake",
  "write:proposals": "Propose changes",
  "write:drafts": "Hand back drafts",
};

/** One scope's plain name; an unknown code reads as words, never as the code. */
export function scopeLabel(scope: string): string {
  const known = SCOPE_LABEL[scope];
  if (known) return known;
  const words = scope.replace(/[:_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A credential's scopes as short chips, each with its scopes spelled out for a title:
 * "Read" or "Read & write" for a personal token or MCP client; a run's token reads as one
 * chip, "Read" or "Read & draft" (it writes drafts and proposals only).
 */
export function scopeChips(scopes: readonly string[]): { label: string; title: string }[] {
  const set = new Set(scopes);
  const out: { label: string; title: string }[] = [];
  if (set.has("oracle:read") || set.has("oracle:write")) {
    const both = set.has("oracle:read") && set.has("oracle:write");
    out.push({ label: both ? "Read & write" : scopeLabel(set.has("oracle:read") ? "oracle:read" : "oracle:write"), title: both ? "Read and write" : "" });
    set.delete("oracle:read");
    set.delete("oracle:write");
  }
  const run = [...set].filter((s) => s.startsWith("read:") || s.startsWith("write:")).sort();
  if (run.length) {
    out.push({ label: run.some((s) => s.startsWith("write:")) ? "Read & draft" : "Read", title: run.map(scopeLabel).join(", ") });
    run.forEach((s) => set.delete(s));
  }
  for (const s of set) out.push({ label: scopeLabel(s), title: "" });
  return out.map((c) => ({ ...c, title: c.title || c.label }));
}
