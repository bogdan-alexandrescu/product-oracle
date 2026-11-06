"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Button, Chip, confirmInPage, Dialog, InfoTip, Notice, type ChipKind } from "@/components/ds";
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

type Entry = Record<string, unknown>;
const text = (v: unknown) => (typeof v === "string" ? v : "");

/** Pass F F-38: the map's lists as people read them, each entry by its name. */
const GROUPS: { key: string; label: string; name: (x: Entry) => string; about: (x: Entry) => string }[] = [
  { key: "modules", label: "Parts", name: (x) => text(x.path) || text(x.id), about: (x) => text(x.summary) },
  { key: "apis", label: "API routes", name: (x) => [text(x.method), text(x.path)].filter(Boolean).join(" ") || text(x.id), about: () => "" },
  {
    key: "data_models",
    label: "Data models",
    name: (x) => text(x.name) || text(x.id),
    about: (x) => (Array.isArray(x.fields) ? x.fields.map(String).join(", ") : ""),
  },
];

/**
 * Pass F F-38 (owner's decision, Nov 5): what a map holds, read-only, in a small dialog (a
 * sheet on a phone): its parts, API routes and data models with their counts. Whoever
 * reads the map opens it; nothing in it changes the map.
 */
function CodeMapView({ id, repo, onClose }: { id: string; repo: string; onClose: () => void }) {
  const q = useQuery(`code-map|${id}`, () => unwrap(api.GET("/v1/code-maps/{code_map_id}", { params: { path: { code_map_id: id } } })));
  const content = q.data?.content ?? null;
  const list = (key: string): Entry[] => {
    const v = content?.[key];
    return Array.isArray(v) ? v.filter((x): x is Entry => !!x && typeof x === "object") : [];
  };
  const groups = GROUPS.map((g) => ({ ...g, items: list(g.key) }));
  const empty = groups.every((g) => g.items.length === 0);
  return (
    <Dialog title={`Code map of ${repo}`} onClose={onClose} phoneSheet scrollBody testId="code-map-view">
      {q.error ? (
        <div className="flex flex-col items-start gap-2">
          <Notice tone="error">{q.error}</Notice>
          <Button onClick={() => void q.reload()}>Try again</Button>
        </div>
      ) : !q.data ? (
        <p className="text-sm text-text2">Loading the map…</p>
      ) : empty ? (
        <p className="text-sm text-text2">Nothing mapped yet</p>
      ) : (
        groups.map((g) => (
          <section key={g.key} className="min-w-0">
            <h3 className="font-semibold text-text">
              {g.label} ({g.items.length})
            </h3>
            {g.items.length === 0 ? (
              <p className="text-sm text-text2">None found</p>
            ) : (
              <ul aria-label={g.label} className="mt-1 flex flex-col gap-0.5 text-sm">
                {g.items.map((it, i) => {
                  const about = g.about(it);
                  return (
                    <li key={text(it.id) || i} className="min-w-0 break-words text-text2">
                      <span className="font-mono text-[13px] text-text">{g.name(it)}</span>
                      {about && ` · ${about}`}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ))
      )}
    </Dialog>
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
        {waiting && map?.run_id && can(map.run_status === "awaiting_approval" ? "approve_run" : "resume_run") && (
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
            <Button aria-haspopup="dialog" onClick={() => setOpen(true)}>
              See the map
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
      {usable && open && <CodeMapView id={map.id} repo={repo} onClose={() => setOpen(false)} />}
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
