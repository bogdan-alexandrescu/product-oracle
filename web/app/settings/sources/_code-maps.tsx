"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Button, Chip, confirmInPage, InfoTip, Notice, type ChipKind } from "@/components/ds";
import { DOCS_ONLY } from "@/components/tech-brief";
import { api, type Schemas, unwrap } from "@/lib/api/client";
import { failedAt, formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
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

/** Pass F F-5: a run that waits for an owner holds the map building; the line says so and leads to the run. */
const WAITING: Record<string, { label: string; tip: string }> = {
  awaiting_approval: { label: "Waiting for an owner to approve its cost", tip: "Its cost is over the limit. An owner approves it on the run's page." },
  paused_overrun: { label: "Paused: over budget", tip: "It spent past its limit. An owner resumes it on the run's page." },
};
const waitsForOwner = (m: CodeMap) => m.status === "building" && !!m.run_status && m.run_status in WAITING;

/**
 * Pass F F-37: why a map failed, in plain words: no "The code map run failed: index:" lead-in
 * (an internal step), and a spent Claude pool as one short line with no reset time (it may be past).
 */
export function codeMapFailure(error: string): string {
  if (/Claude account (could|can) take this call/.test(error)) {
    return /spent/.test(error) ? "Every Claude account is out of quota. Try again later." : "No Claude account could take it. Try again later.";
  }
  return error.replace(/^The code map run failed:\s*/, "").replace(/^[a-z_]+:\s+/, "");
}

/** Pass F F-38: what a map holds, read-only: its modules, APIs and data models. */
function MapContents({ id }: { id: string }) {
  const q = useQuery(`code-map|${id}`, () => unwrap(api.GET("/v1/code-maps/{code_map_id}", { params: { path: { code_map_id: id } } })));
  if (q.error) return <Notice tone="error">{q.error}</Notice>;
  if (!q.data) return <p className="text-sm text-text2">Loading…</p>;
  const content = q.data.content ?? {};
  const list = (key: string) => (Array.isArray(content[key]) ? (content[key] as Record<string, unknown>[]) : []);
  const groups = [
    { label: "Parts", items: list("modules").map((x) => ({ name: String(x.path ?? x.id ?? ""), about: String(x.summary ?? "") })) },
    { label: "APIs", items: list("apis").map((x) => ({ name: String(x.path ?? x.name ?? x.id ?? ""), about: String(x.summary ?? "") })) },
    { label: "Data models", items: list("data_models").map((x) => ({ name: String(x.name ?? x.id ?? ""), about: String(x.summary ?? "") })) },
  ].filter((g) => g.items.length > 0);
  if (groups.length === 0) return <p className="text-sm text-text2">Nothing mapped yet</p>;
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-surface2 p-2 text-sm" data-testid="code-map-contents">
      {groups.map((g) => (
        <div key={g.label} className="min-w-0">
          <p className="font-semibold text-text">{g.label}</p>
          <ul className="flex flex-col gap-0.5">
            {g.items.map((it) => (
              <li key={it.name} className="min-w-0 break-words text-text2">
                <span className="font-mono text-[13px] text-text">{it.name}</span>
                {it.about && ` · ${it.about}`}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function CodeMapLine({ repo, map, onChange, sourceId }: { repo: string; map?: CodeMap; sourceId: string; onChange: (m: CodeMap) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const { can } = useMe();

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

  const waiting = map && waitsForOwner(map) ? WAITING[map.run_status!] : null;
  const state = map ? (waiting ? { label: waiting.label, kind: "warn" as const } : STATE[map.status]) : null;
  const usable = map && (map.status === "ready" || map.status === "stale");
  return (
    <li className="flex min-w-0 flex-col gap-1" data-testid={`code-map-${repo}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        {/* Visual QA ST-7: what a code map is, beside the repository it maps (whatever buttons the role has). */}
        <span className="flex min-w-0 max-w-full items-center gap-1">
          <span className="min-w-0 truncate font-mono text-[13px] text-text" title={repo} data-testid="code-map-repo">
            {repo}
          </span>
          <InfoTip label="code maps" align="start">
            Oracle&apos;s short guide to a repository: its parts and where things live. Oracle reads it before changing the code.
          </InfoTip>
        </span>
        {!map && <span className="text-text2">No code map yet</span>}
        {map && state && (
          <Chip kind={state.kind} dot>
            {waiting ? state.label : `Code map: ${state.label}`}
            {usable && ` · ${map.sharing === "full" ? "Shared with the company" : "Private"}`}
          </Chip>
        )}
        {map?.partial && usable && (
          <Chip kind="warn" title="Built from what Oracle synced of the repository (README, docs, issues, pull requests): the code itself was not read.">
            {DOCS_ONLY}
          </Chip>
        )}
        {waiting && <InfoTip label={waiting.label}>{waiting.tip}</InfoTip>}
        {waiting && map?.run_id && (can("approve_run") || can("resume_run")) && (
          <Link href={`/runs/${map.run_id}`} className="text-sm font-semibold text-accent-ink hover:underline">
            {map.run_status === "awaiting_approval" ? "Open the run to approve" : "Open the run to resume"}
          </Link>
        )}
        {usable && map.as_of && <span className="text-text2">as of {formatDateTime(map.as_of)}</span>}
        <span className="ml-auto flex flex-none flex-wrap items-center gap-1">
          {/* A stale map refreshes at once on Map the code, whatever the refresh setting. */}
          {(!map || map.status === "failed" || map.status === "stale") && can("start_code_map") && (
            <Button disabled={busy} onClick={start}>
              Map the code
            </Button>
          )}
          {usable && (
            <Button aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              {open ? "Hide the map" : "See the map"}
            </Button>
          )}
          {usable && map.mine && map.sharing === "private" && can("share_code_map") && (
            <Button disabled={busy} onClick={() => void share("full")}>
              Share with the company
            </Button>
          )}
          {usable && map.mine && map.sharing === "full" && can("share_code_map") && (
            <Button disabled={busy} onClick={() => void share("private")}>
              Make private
            </Button>
          )}
        </span>
      </div>
      {map?.status === "failed" && map.error && (
        <p className="break-words text-sm text-crit">
          {map.failed_at && <span data-testid="failed-at">{failedAt(map.failed_at)}. </span>}
          {codeMapFailure(map.error)}
        </p>
      )}
      {usable && open && <MapContents id={map.id} />}
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
  // A map whose run waits for an owner changes only when they act: no polling meanwhile (F-5).
  const building = maps?.some((m) => m.status === "building" && !waitsForOwner(m)) ?? false;
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
