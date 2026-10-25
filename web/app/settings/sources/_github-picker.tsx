"use client";

import { Icon } from "@/components/ds";
import { api, unwrap } from "@/lib/api/client";
import { formatDate } from "@/lib/format";

import { BrowseList, listOf, type BrowsePage, type PickerProps } from "./_browse-list";

const DAY = 24 * 3600 * 1000;

/** "today", "3d", "5w", "4mo", "2y": how long ago a repo was last pushed to. */
function ago(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / DAY);
  if (days < 1) return "today";
  if (days < 14) return `${days}d`;
  if (days < 60) return `${Math.floor(days / 7)}w`;
  if (days < 730) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

/** What a GitHub source can read (oracle.sources.connectors.github INCLUDE), in its order. */
export const GITHUB_INCLUDE = [
  { value: "readme", label: "README" },
  { value: "docs", label: "Docs" },
  { value: "issues", label: "Issues" },
  { value: "pull_requests", label: "Pull requests" },
  { value: "releases", label: "Releases" },
  { value: "milestones", label: "Milestones" },
] as const;

/** What the config reads: its `include`, or everything when it has none. */
export function githubIncluded(config: Record<string, unknown>): Set<string> {
  const include = config.include;
  return new Set(Array.isArray(include) ? include.map(String) : GITHUB_INCLUDE.map((k) => k.value));
}

/** The kinds a source reads, by name, when it reads only some ("README, Issues"); null when it reads all. */
export function githubReads(config: Record<string, unknown>): string | null {
  const on = githubIncluded(config);
  if (GITHUB_INCLUDE.every((k) => on.has(k.value))) return null;
  return GITHUB_INCLUDE.filter((k) => on.has(k.value))
    .map((k) => k.label)
    .join(", ");
}

/**
 * GitHub source picker (S5): repos your GitHub sign-in can read, and what to read in them
 * (the connector's `include`). Writes `{repos, include?}`: with every kind ticked there is
 * no `include`, which reads them all. The last ticked kind cannot be unticked.
 */
export function GithubPicker({ connectionId, config, onChange }: PickerProps) {
  const on = githubIncluded(config);
  function toggle(value: string, checked: boolean) {
    const next = GITHUB_INCLUDE.map((k) => k.value).filter((k) => (k === value ? checked : on.has(k)));
    const { include: _include, ...rest } = config;
    void _include;
    onChange(next.length === GITHUB_INCLUDE.length ? rest : { ...rest, include: next });
  }

  async function load(search: string, cursor: string | null): Promise<BrowsePage> {
    const page = await unwrap(
      api.GET("/v1/connections/{connection_id}/github/repos", {
        params: { path: { connection_id: connectionId! }, query: { search, ...(cursor ? { cursor } : {}) } },
      }),
    );
    return {
      next: page.next_cursor,
      notice: page.sso_hint,
      items: page.repos.map((r) => ({
        id: r.full_name,
        label: r.full_name,
        isPrivate: r.is_private,
        hint: r.description,
        meta: r.pushed_at ? (
          <span data-testid="last-push" title={`Last push ${formatDate(r.pushed_at)}`} className="flex items-center gap-1">
            <Icon name="clock" size={16} />
            {ago(r.pushed_at)}
          </span>
        ) : null,
      })),
    };
  }

  return (
    <>
      <BrowseList
      label="GitHub repositories"
      searchLabel="Search repositories"
      pasteLabel="Repositories"
      pasteExample="example-org/example-app"
      connectionId={connectionId}
      picked={listOf(config, "repos")}
      onPicked={(repos) => onChange({ ...config, repos })}
      load={load}
      />
      <fieldset aria-label="What to read" className="flex min-w-0 flex-col gap-1.5">
        <legend className="mb-1.5 text-sm font-semibold text-text2">What to read</legend>
        <div className="flex min-w-0 flex-wrap gap-x-4 gap-y-1.5">
          {GITHUB_INCLUDE.map((k) => {
            const checked = on.has(k.value);
            return (
              <label key={k.value} className="inline-flex min-h-8 cursor-pointer items-center gap-2 text-[15px]">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--accent)]"
                  checked={checked}
                  disabled={checked && on.size === 1}
                  onChange={(e) => toggle(k.value, e.target.checked)}
                />
                {k.label}
              </label>
            );
          })}
        </div>
      </fieldset>
    </>
  );
}
