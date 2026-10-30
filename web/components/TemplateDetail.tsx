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
import { GrowingTextarea } from "@/app/settings/_components/GrowingTextarea";
import { Field, INPUT, SELECT } from "@/app/settings/_components/fields";
import { FormActions } from "@/app/settings/_components/FormActions";
import {
  ProblemList,
  TemplateBodyEditor,
  WarningList,
  sectionNames,
  sectionTitles,
  useTemplateCheck,
  useThemeNames,
} from "@/components/TemplateBodyEditor";
import { Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { ProblemsError, unwrapProblems, type Problem } from "@/lib/api/problems";
import { formatDate } from "@/lib/format";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

type TemplateOut = Schemas["TemplateOut"];

function message(e: unknown) {
  return e instanceof Error && e.message ? e.message : errorMessage(e);
}

const BACK = (
  <Link href="/settings/templates" className="inline-flex items-center hover:text-text hover:underline max-[600px]:min-h-11">
    ← Templates
  </Link>
);

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
  const themeName = useThemeNames();

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
  const shownTitles = sectionTitles(shown.body);
  // qa-settings-28: why the main action is disabled, said next to it.
  const saveReason =
    busy !== null
      ? null
      : body === latest.body
        ? "Change the template to save a new version."
        : live.pending || !check
          ? "Checking the template…"
          : !check.valid
            ? "Fix the problems above to save."
            : null;
  const detailsReason =
    busy !== null
      ? null
      : !detailsChanged
        ? "Change the name or description to save them."
        : !nameValue.trim()
          ? "A template needs a name."
          : null;

  const inspector = (
    // qa-settings-27: each fact once. The name, kind and version are the page's header; the
    // versions and their sections are the Versions panel.
    <Inspector eyebrow="Template details" label="Template details">
      {canEdit && (
        <InspectorSection label="Details">
          <div className="flex flex-col gap-3">
            <Field label="Name">
              <input className={INPUT} value={nameValue} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Description">
              <GrowingTextarea value={descriptionValue} onChange={(e) => setDescription(e.target.value)} />
            </Field>
            <FormActions id="details-save-reason" reason={detailsReason}>
              <Button
                onClick={saveDetails}
                disabled={!detailsChanged || !nameValue.trim() || busy !== null}
                aria-describedby={detailsReason ? "details-save-reason" : undefined}
              >
                {busy === "details" ? "Saving…" : "Save details"}
              </Button>
            </FormActions>
          </div>
        </InspectorSection>
      )}
      {!canEdit && t.description && (
        <InspectorSection label="Description">
          <p className="text-[15px] text-text">{t.description}</p>
        </InspectorSection>
      )}
      <InspectorSection label="Facts">
        {latest.suggest_when && (
          <div data-testid="suggest-when" className="flex flex-col gap-0.5 py-1.5">
            <span>Suggested when</span>
            <span className="font-semibold break-words">{latest.suggest_when}</span>
          </div>
        )}
        <InspectorRow value={<span data-testid="suggested-theme">{themeName(t.suggested_theme)}</span>}>
          Suggested theme
        </InspectorRow>
        <InspectorRow value={formatDate(t.created_at)}>Added</InspectorRow>
        {t.archived_at && <InspectorRow value={formatDate(t.archived_at)}>Archived</InspectorRow>}
        <InspectorRow value={t.key}>Key</InspectorRow>
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
            <FormActions id="version-save-reason" reason={saveReason} sticky className="mt-3">
              <Button
                variant="primary"
                icon="check"
                onClick={saveVersion}
                disabled={busy !== null || live.pending || !check?.valid || body === latest.body}
                aria-describedby={saveReason ? "version-save-reason" : undefined}
              >
                {busy === "version" ? "Saving…" : "Save as new version"}
              </Button>
              {dirty && (
                <Button variant="ghost" onClick={() => setDraft(null)}>
                  Discard changes
                </Button>
              )}
            </FormActions>
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
                    v{v.version} · {formatDate(v.created_at)}
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
            <span data-testid="version-required" className="min-w-0 break-words">
              {sectionNames(shownTitles, shown.required_sections)}
            </span>
            <Label className="ml-2">Brief</Label>
            <span data-testid="version-brief" className="min-w-0 break-words">
              {sectionNames(shownTitles, shown.brief_sections)}
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
          <pre
            data-testid="version-body"
            className="max-h-[32rem] overflow-auto rounded-button border border-line bg-surface2 p-3 font-mono text-[13px] leading-5 whitespace-pre-wrap text-text"
          >
            {shown.body}
          </pre>
        </Panel>
      </Split>
    </>
  );
}
