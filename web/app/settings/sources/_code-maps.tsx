"use client";

import { useEffect, useState } from "react";

import { Button, Chip, confirmInPage, Notice, type ChipKind } from "@/components/ds";
import { DOCS_ONLY } from "@/components/tech-brief";
import { api, type Schemas, unwrap } from "@/lib/api/client";
import { failedAt, formatDateTime } from "@/lib/format";
import { errorMessage, useQuery } from "@/lib/use-query";

type Source = Schemas["SourceOut"];
type CodeMap = Schemas["CodeMapOut"];

/** How often the row checks a map that is being built. */
const BUILDING_POLL_MS = 1500;

const STATE: Record<CodeMap["status"], { label: string; kind: ChipKind }> = {
  building: { label: "building", kind: "warn" },
  ready: { label: "ready", kind: "pass" },
  stale: { label: "stale, a refresh is due", kind: "warn" },
  failed: { label: "failed", kind: "crit" },
};

function reposOf(source: Source): string[] {
  const repos = (source.config as Record<string, unknown>).repos;
  return Array.isArray(repos) ? repos.map(String) : [];
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function CodeMapLine({ repo, map, onChange, sourceId }: { repo: string; map?: CodeMap; sourceId: string; onChange: (m: CodeMap) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(fn: () => Promise<CodeMap>) {
    setBusy(true);
    setError(null);
    try {
      onChange(await fn());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const start = () => act(() => unwrap(api.POST("/v1/code-maps", { body: { source_id: sourceId, repo } })));

  async function share(sharing: CodeMap["sharing"]) {
    if (!map) return;
    if (
      sharing === "full" &&
      !(await confirmInPage({
        action: "Share",
        message: `Share the code map of ${repo} with the company: everyone in the company can read it and runs use it. You can make it private again later.`,
      }))
    )
      return;
    await act(() => unwrap(api.POST("/v1/code-maps/{code_map_id}/sharing", { params: { path: { code_map_id: map.id } }, body: { sharing } })));
  }

  const state = map ? STATE[map.status] : null;
  const usable = map && (map.status === "ready" || map.status === "stale");
  return (
    <li className="flex min-w-0 flex-col gap-1" data-testid={`code-map-${repo}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="min-w-0 max-w-full truncate font-mono text-[13px] text-text" title={repo}>
          {repo}
        </span>
        {!map && <span className="text-text2">No code map yet</span>}
        {map && state && (
          <Chip kind={state.kind} dot>
            {`Code map: ${state.label}`}
            {usable && ` · ${map.sharing === "full" ? "Shared with the company" : "Private"}`}
          </Chip>
        )}
        {map?.partial && usable && (
          <Chip kind="warn" title="Built from what Oracle synced of the repository (README, docs, issues, pull requests): the code itself was not read.">
            {DOCS_ONLY}
          </Chip>
        )}
        {map?.status === "building" && map.run_status === "awaiting_approval" && <span className="text-text2">waits for an owner to approve its cost</span>}
        {usable && map.as_of && <span className="text-text2">as of {formatDateTime(map.as_of)}</span>}
        <span className="ml-auto flex flex-none flex-wrap items-center gap-1">
          {/* A stale map refreshes at once on Map the code, whatever the refresh setting. */}
          {(!map || map.status === "failed" || map.status === "stale") && (
            <Button disabled={busy} onClick={start}>
              Map the code
            </Button>
          )}
          {usable && map.mine && map.sharing === "private" && (
            <Button disabled={busy} onClick={() => void share("full")}>
              Share with the company
            </Button>
          )}
          {usable && map.mine && map.sharing === "full" && (
            <Button disabled={busy} onClick={() => void share("private")}>
              Make private
            </Button>
          )}
        </span>
      </div>
      {map?.status === "failed" && map.error && (
        <p className="break-words text-sm text-crit">
          {map.failed_at && <span data-testid="failed-at">{failedAt(map.failed_at)}. </span>}
          {map.error}
        </p>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </li>
  );
}

/**
 * A GitHub source's code maps (F5-2), one line per repository: Map the code (a code_map
 * run), the map's state, and who sees it. A map is private to the source's owner until
 * they share it with the company (S6); then everyone reads it and runs use it.
 */
export function CodeMaps({ source }: { source: Source }) {
  const repos = reposOf(source);
  const q = useQuery(`code-maps|${source.id}`, () =>
    unwrap(api.GET("/v1/code-maps")).then((all) => all.filter((m) => m.source_id === source.id)),
  );
  const maps = q.data;
  const building = maps?.some((m) => m.status === "building") ?? false;
  const { reload } = q;
  useEffect(() => {
    if (!building) return;
    const t = setTimeout(() => void reload(), BUILDING_POLL_MS);
    return () => clearTimeout(t);
  }, [building, maps, reload]);
  if (repos.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {q.error && <Notice tone="error">{q.error}</Notice>}
      <ul aria-label={`Code maps of ${source.name}`} className="flex flex-col gap-1.5">
        {repos.map((repo) => (
          <CodeMapLine
            key={repo}
            repo={repo}
            sourceId={source.id}
            // Newest first: the repo's latest map.
            map={maps?.find((m) => same(m.repo, repo))}
            onChange={(m) => q.setData((prev) => [m, ...(prev ?? []).filter((x) => x.id !== m.id)])}
          />
        ))}
      </ul>
    </div>
  );
}
