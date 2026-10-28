"use client";

import Link from "next/link";
import { useState } from "react";

import {
  Button,
  Chip,
  InfoTip,
  Inspector,
  InspectorRow,
  InspectorSection,
  Label,
  Notice,
  PageHeader,
  ViewOnly,
  Panel,
  Split,
} from "@/components/ds";
import { Field, INPUT, SELECT, TEXTAREA } from "@/app/settings/_components/fields";
import {
  ProblemList,
  TemplateBodyEditor,
  ThemeName,
  WarningList,
  useTemplateCheck,
  useThemeNames,
} from "@/components/TemplateBodyEditor";
import { Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { ProblemsError, unwrapProblems, type Problem } from "@/lib/api/problems";
import { formatDate, formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

type TemplateOut = Schemas["TemplateOut"];

function message(e: unknown) {
  return e instanceof Error && e.message ? e.message : errorMessage(e);
}

const BACK = (
  <Link href="/settings/templates" className="hover:text-text hover:underline">
    ← Templates
  </Link>
);

function VersionBody({ body }: { body: string }) {
  return (
    <pre
      data-testid="version-body"
      className="max-h-[32rem] overflow-auto rounded-button border border-line bg-surface2 p-3 font-mono text-[13px] leading-5 whitespace-pre-wrap text-text"
    >
      {body}
    </pre>
  );
}

/** A template: its versions, an editor for the next version, details, archive / restore. */
export function TemplateDetail({ templateKey: key }: { templateKey: string }) {
  const q = useQuery(`template|${key}`, () => unwrap(api.GET("/v1/templates/{key}", { params: { path: { key } } })));
  const t = q.data;
  // #370: approvers and owners change templates; other roles read them, with no editors.
  const { can, capsReady } = useMe();
  const canEdit = can("update_template");
  const [viewed, setViewed] = useState<number | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);

  const latest = t?.versions[t.versions.length - 1];
  const body = draft ?? latest?.body ?? "";
  const live = useTemplateCheck(body, !!t);
  const themes = useThemeNames();

  if (q.error) {
    return (
      <>
        <PageHeader back={BACK} title="Template" />
        <Notice tone="error">{q.error}</Notice>
      </>
    );
  }
  if (!t || !latest) {
    return (
      <>
        <PageHeader back={BACK} title="Template" />
        <Loading />
      </>
    );
  }

  const shown = t.versions.find((v) => v.version === (viewed ?? latest.version)) ?? latest;
  const nameValue = name ?? t.name;
  const descriptionValue = description ?? t.description ?? "";
  const detailsChanged = nameValue.trim() !== t.name || (descriptionValue.trim() || null) !== (t.description ?? null);
  const check = live.data;

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

  const kindLabel = t.kind === "prd" ? "PRD" : "Roadmap";
  const dirty = draft !== null && draft !== latest.body;
  // qa-settings-19: the version shown is what the editor holds: say so, not print it twice.
  const sameAsEditor = canEdit && shown.body === body;

  const inspector = (
    <Inspector
      eyebrow="Template"
      title={t.name}
      label="Template details"
      chips={
        <>
          <Chip hero kind="acc">
            {kindLabel}
          </Chip>
          {t.builtin && (
            <Chip hero kind="na">
              Built-in
            </Chip>
          )}
          {t.archived_at && (
            <Chip hero kind="warn">
              Archived
            </Chip>
          )}
        </>
      }
      stats={[
        { label: "Latest", value: `v${t.latest_version}` },
        { label: "Versions", value: t.versions.length },
        { label: "Sections", value: latest.required_sections.length },
      ]}
    >
      {canEdit && (
        <InspectorSection label="Details">
          <div className="flex flex-col gap-3">
            <Field label="Name">
              <input className={INPUT} value={nameValue} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Description">
              <textarea
                rows={3}
                className={TEXTAREA}
                value={descriptionValue}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
            <div>
              <Button onClick={saveDetails} disabled={!detailsChanged || !nameValue.trim() || busy !== null}>
                {busy === "details" ? "Saving…" : "Save details"}
              </Button>
            </div>
          </div>
        </InspectorSection>
      )}
      {!canEdit && t.description && (
        <InspectorSection label="Description">
          <p className="text-[15px] text-text">{t.description}</p>
        </InspectorSection>
      )}
      {latest.suggest_when && (
        <InspectorSection label="Suggested when" testId="suggest-when">
          <p className="text-[15px] text-text">{latest.suggest_when}</p>
        </InspectorSection>
      )}
      <InspectorSection label="Facts">
        <InspectorRow value={<ThemeName themeKey={t.suggested_theme} names={themes} />}>Suggested theme</InspectorRow>
        <InspectorRow value={formatDate(t.created_at)}>Added</InspectorRow>
        {t.archived_at && <InspectorRow value={formatDate(t.archived_at)}>Archived</InspectorRow>}
      </InspectorSection>
      <InspectorSection label="For developers">
        <InspectorRow value={<span className="font-mono text-sm font-medium">{t.key}</span>}>Key</InspectorRow>
      </InspectorSection>
      {canEdit && (
        <InspectorSection>
          {t.archived_at ? (
            <Button onClick={restore} disabled={busy !== null}>
              {busy === "restore" ? "Restoring…" : "Restore"}
            </Button>
          ) : (
            <Button onClick={archive} disabled={busy !== null}>
              {busy === "archive" ? "Archiving…" : "Archive"}
            </Button>
          )}
        </InspectorSection>
      )}
    </Inspector>
  );

  return (
    <>
      <PageHeader
        back={BACK}
        title={t.name}
        status={
          <>
            <Chip kind="acc">{kindLabel}</Chip>
            <Chip kind="acc" data-testid="latest-version">{`v${t.latest_version}`}</Chip>
            {t.builtin && <Chip kind="na">Built-in</Chip>}
            {t.archived_at && <Chip kind="warn">Archived</Chip>}
            {capsReady && !canEdit && <ViewOnly />}
          </>
        }
        action={
          canEdit && (
            <>
              {dirty && (
                <Button variant="ghost" onClick={() => setDraft(null)}>
                  Discard changes
                </Button>
              )}
              <Button
                variant="primary"
                icon="check"
                onClick={saveVersion}
                disabled={busy !== null || live.pending || !check?.valid || body === latest.body}
              >
                {busy === "version" ? "Saving…" : "Save as new version"}
              </Button>
            </>
          )
        }
      />
      <Split inspector={inspector}>
        {(notice || error) && (
          <div className="flex flex-col gap-2">
            {notice && <Notice tone="pass">{notice}</Notice>}
            {error && <Notice tone="error">{error}</Notice>}
            {problems.length > 0 && <ProblemList problems={problems} testId="save-problems" />}
          </div>
        )}
        {canEdit && (
          <Panel title="Next version" bodyClassName="p-4 max-[600px]:p-3">
            <TemplateBodyEditor value={body} onChange={setDraft} label="Template body" live={live} />
          </Panel>
        )}
        <Panel
          title="Versions"
          count={t.versions.length}
          tools={
            <>
              {canEdit && shown.version !== latest.version && (
                <Button variant="ghost" onClick={() => setDraft(shown.body)}>
                  Copy into editor
                </Button>
              )}
              <select
                aria-label="Version"
                value={shown.version}
                onChange={(e) => setViewed(Number(e.target.value))}
                className={`${SELECT} tnum`}
              >
                {[...t.versions].reverse().map((v) => (
                  <option key={v.version} value={v.version}>
                    v{v.version} · {formatDateTime(v.created_at)}
                    {v.version === latest.version ? " · latest" : ""}
                  </option>
                ))}
              </select>
            </>
          }
          bodyClassName="flex flex-col gap-3 p-4 max-[600px]:p-3"
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <Label>Required</Label>
            <span className="min-w-0 font-mono text-[13px] break-words">{shown.required_sections.join(", ") || "none"}</span>
            <Label className="ml-2">Brief</Label>
            <span data-testid="version-brief" className="font-mono text-[13px]">
              {shown.brief_sections.join(", ") || "none"}
            </span>
          </div>
          {shown.warnings.some((w) => w.code === "no_brief_sections") && (
            <div className="flex flex-col gap-1 text-sm">
              <p data-testid="version-no-brief" className="flex items-center gap-2">
                <Chip kind="warn">No brief markers</Chip>
                <InfoTip label="no brief markers" align="start">
                  Saved before templates had to mark a brief. Documents drafted from it keep working; the next version must
                  add brief markers.
                </InfoTip>
              </p>
              <WarningList warnings={shown.warnings} />
            </div>
          )}
          {sameAsEditor ? (
            <details data-testid="version-same" className="text-sm">
              <summary className="cursor-pointer text-text2 hover:text-text">
                {`Same as the editor above. Show v${shown.version}`}
              </summary>
              <div className="mt-2">
                <VersionBody body={shown.body} />
              </div>
            </details>
          ) : (
            <VersionBody body={shown.body} />
          )}
        </Panel>
      </Split>
    </>
  );
}
