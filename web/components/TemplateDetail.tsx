"use client";

import Link from "next/link";
import { useState } from "react";

import { ProblemList, TemplateBodyEditor } from "@/components/TemplateBodyEditor";
import { Badge, Button, ErrorNote, INPUT, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { ProblemsError, unwrapProblems, type Problem } from "@/lib/api/problems";
import { formatDateTime } from "@/lib/format";
import { errorMessage, useQuery } from "@/lib/use-query";

type TemplateOut = Schemas["TemplateOut"];

function message(e: unknown) {
  return e instanceof Error && e.message ? e.message : errorMessage(e);
}

/** A template: its versions, an editor for the next version, details, archive / restore. */
export function TemplateDetail({ templateKey: key }: { templateKey: string }) {
  const q = useQuery(`template|${key}`, () => unwrap(api.GET("/v1/templates/{key}", { params: { path: { key } } })));
  const t = q.data;
  const [viewed, setViewed] = useState<number | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);

  if (q.error) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-8">
        <ErrorNote>{q.error}</ErrorNote>
      </div>
    );
  }
  if (!t) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-8">
        <Loading />
      </div>
    );
  }

  const latest = t.versions[t.versions.length - 1];
  const shown = t.versions.find((v) => v.version === (viewed ?? latest.version)) ?? latest;
  const body = draft ?? latest.body;
  const nameValue = name ?? t.name;
  const descriptionValue = description ?? t.description ?? "";
  const detailsChanged = nameValue.trim() !== t.name || (descriptionValue.trim() || null) !== (t.description ?? null);

  async function run(label: string, call: () => Promise<TemplateOut>, done: (t: TemplateOut) => string) {
    setBusy(label);
    setError(null);
    setProblems([]);
    setNotice(null);
    try {
      const next = await call();
      q.setData(() => next);
      setNotice(done(next));
      return next;
    } catch (e) {
      setError(message(e));
      if (e instanceof ProblemsError) setProblems(e.problems);
    } finally {
      setBusy(null);
    }
  }

  const saveVersion = () =>
    run(
      "version",
      () => unwrapProblems(api.PATCH("/v1/templates/{key}", { params: { path: { key } }, body: { body } })),
      (next) => {
        setDraft(null);
        setViewed(null);
        return `Saved as version ${next.latest_version}.`;
      },
    );
  const saveDetails = () =>
    run(
      "details",
      () =>
        unwrapProblems(
          api.PATCH("/v1/templates/{key}", {
            params: { path: { key } },
            body: { name: nameValue.trim(), description: descriptionValue.trim() || null },
          }),
        ),
      () => {
        setName(null);
        setDescription(null);
        return "Details saved.";
      },
    );
  const archive = () =>
    run(
      "archive",
      () => unwrap(api.DELETE("/v1/templates/{key}", { params: { path: { key } } })),
      () => "Archived: hidden from the new-draft picker. Documents using it keep working.",
    );
  const restore = () =>
    run(
      "restore",
      () => unwrap(api.POST("/v1/templates/{key}/restore", { params: { path: { key } } })),
      () => "Restored.",
    );

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <p className="mb-2 text-sm">
        <Link href="/settings/templates" className="text-neutral-500 hover:text-neutral-900 hover:underline">
          ← Templates
        </Link>
      </p>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">{t.name}</h1>
        <Badge tone="blue">{t.kind === "prd" ? "PRD" : "Roadmap"}</Badge>
        {t.builtin && <Badge>Built-in</Badge>}
        {t.archived_at && <Badge tone="amber">Archived</Badge>}
        <div className="ml-auto">
          {t.archived_at ? (
            <Button onClick={restore} disabled={busy !== null}>
              {busy === "restore" ? "Restoring…" : "Restore"}
            </Button>
          ) : (
            <Button onClick={archive} disabled={busy !== null}>
              {busy === "archive" ? "Archiving…" : "Archive"}
            </Button>
          )}
        </div>
      </div>
      <p className="mb-6 text-sm text-neutral-500">
        <span className="font-mono">{t.key}</span> · latest <span data-testid="latest-version">v{t.latest_version}</span>
        {t.suggested_theme && (
          <>
            {" "}
            · suggests theme <span className="font-mono">{t.suggested_theme}</span>
          </>
        )}
        {t.archived_at && ` · archived ${formatDateTime(t.archived_at)}`}
      </p>

      {notice && (
        <p role="status" className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {notice}
        </p>
      )}
      {error && (
        <div className="mb-4 space-y-2">
          <ErrorNote>{error}</ErrorNote>
          {problems.length > 0 && <ProblemList problems={problems} testId="save-problems" />}
        </div>
      )}

      <section aria-labelledby="details-heading" className="mb-8 rounded-lg border border-neutral-200 bg-white p-4">
        <h2 id="details-heading" className="mb-3 text-sm font-semibold text-neutral-700">
          Details
        </h2>
        <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
          <label className="block text-sm">
            <span className="mb-1 block text-neutral-600">Name</span>
            <input className={INPUT} value={nameValue} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-neutral-600">Description</span>
            <input className={INPUT} value={descriptionValue} onChange={(e) => setDescription(e.target.value)} />
          </label>
        </div>
        {latest.suggest_when && <p className="mt-2 text-xs text-neutral-500">Suggested when: {latest.suggest_when}</p>}
        <div className="mt-3">
          <Button size="sm" onClick={saveDetails} disabled={!detailsChanged || !nameValue.trim() || busy !== null}>
            {busy === "details" ? "Saving…" : "Save details"}
          </Button>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="versions-heading" className="min-w-0">
          <div className="mb-2 flex items-center gap-3">
            <h2 id="versions-heading" className="text-sm font-semibold text-neutral-700">
              Versions
            </h2>
            <select
              aria-label="Version"
              value={shown.version}
              onChange={(e) => setViewed(Number(e.target.value))}
              className="rounded-md border border-neutral-300 bg-white py-1 pr-7 pl-2 text-sm"
            >
              {[...t.versions].reverse().map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version} · {formatDateTime(v.created_at)}
                  {v.version === latest.version ? " · latest" : ""}
                </option>
              ))}
            </select>
            {shown.version !== latest.version && (
              <Button size="sm" variant="ghost" onClick={() => setDraft(shown.body)}>
                Copy into editor
              </Button>
            )}
          </div>
          <p className="mb-2 text-xs text-neutral-500">
            Required sections: <span className="font-mono">{shown.required_sections.join(", ") || "none"}</span>
          </p>
          <pre
            data-testid="version-body"
            className="max-h-[32rem] overflow-auto rounded-md border border-neutral-200 bg-neutral-50 p-3 font-mono text-[12px] leading-5 whitespace-pre-wrap text-neutral-800"
          >
            {shown.body}
          </pre>
        </section>

        <section aria-labelledby="editor-heading" className="min-w-0">
          <h2 id="editor-heading" className="mb-2 text-sm font-semibold text-neutral-700">
            Next version
          </h2>
          <TemplateBodyEditor value={body} onChange={setDraft} label="Template body">
            {({ check, pending }) => (
              <div className="flex items-center gap-3">
                <Button
                  variant="primary"
                  onClick={saveVersion}
                  disabled={busy !== null || pending || !check?.valid || body === latest.body}
                >
                  {busy === "version" ? "Saving…" : "Save as new version"}
                </Button>
                {draft !== null && draft !== latest.body && (
                  <Button variant="ghost" onClick={() => setDraft(null)}>
                    Discard changes
                  </Button>
                )}
              </div>
            )}
          </TemplateBodyEditor>
        </section>
      </div>
    </div>
  );
}
