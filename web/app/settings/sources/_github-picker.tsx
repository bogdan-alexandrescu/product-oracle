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

/** GitHub source picker (S5): repos your GitHub sign-in can read; writes `{repos}`. */
export function GithubPicker({ connectionId, config, onChange }: PickerProps) {
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
  );
}
