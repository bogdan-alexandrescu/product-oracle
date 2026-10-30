"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { KeyField, keyValid } from "@/app/settings/_components/KeyField";
import { GrowingTextarea } from "@/app/settings/_components/GrowingTextarea";
import { Field, INPUT } from "@/app/settings/_components/fields";
import { FormActions } from "@/app/settings/_components/FormActions";
import { Button, Notice, PageHeader, Panel } from "@/components/ds";
import { ProblemList, TEMPLATE_SKELETON, TemplateBodyEditor, useTemplateCheck } from "@/components/TemplateBodyEditor";
import { ApiError, api } from "@/lib/api/client";
import { ProblemsError, unwrapProblems, type Problem } from "@/lib/api/problems";
import { errorMessage } from "@/lib/use-query";

export default function NewTemplatePage() {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"prd" | "roadmap">("prd");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState(TEMPLATE_SKELETON);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A key that is taken: said under the Key field.
  const [keyError, setKeyError] = useState<string | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const live = useTemplateCheck(body);
  // qa-settings-28: why Create is disabled, said next to it.
  const reason = busy
    ? null
    : !key
      ? "Enter a key to create the template."
      : !keyValid(key)
        ? "Fix the key to create the template."
        : !name.trim()
          ? "Enter a name to create the template."
          : live.pending || !live.data
            ? "Checking the template…"
            : !live.data.valid
              ? "Fix the problems in the template to create it."
              : null;

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setKeyError(null);
    setProblems([]);
    try {
      const t = await unwrapProblems(
        api.POST("/v1/templates", {
          body: { key: key.trim(), name: name.trim(), kind, description: description.trim() || null, body },
        }),
      );
      router.push(`/settings/templates/${t.key}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setKeyError(err.message);
      else setError(err instanceof Error && err.message ? err.message : errorMessage(err));
      if (err instanceof ProblemsError) setProblems(err.problems);
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        back={
          <Link href="/settings/templates" className="inline-flex items-center hover:text-text hover:underline max-[600px]:min-h-11">
            ← Templates
          </Link>
        }
        title="New template"
      />
      <form
        id="new-template"
        onSubmit={create}
        className="grid grid-cols-[minmax(0,1fr)_380px] items-start gap-4 max-[1100px]:grid-cols-1 max-[600px]:gap-3"
      >
        <div className="flex min-w-0 flex-col gap-4 max-[1100px]:order-2 max-[600px]:gap-3">
          {error && <Notice tone="error">{error}</Notice>}
          {problems.length > 0 && <ProblemList problems={problems} testId="save-problems" />}
          <Panel title="Markdown" bodyClassName="p-4 max-[600px]:p-3">
            <TemplateBodyEditor value={body} onChange={setBody} live={live} />
            <FormActions id="create-template-reason" reason={reason} sticky className="mt-3">
              <Button
                type="submit"
                variant="primary"
                icon="plus"
                disabled={busy || live.pending || !live.data?.valid || !keyValid(key) || !name.trim()}
                aria-describedby={reason ? "create-template-reason" : undefined}
              >
                {busy ? "Creating…" : "Create template"}
              </Button>
            </FormActions>
          </Panel>
        </div>
        <Panel title="Details" bodyClassName="flex flex-col gap-3 p-4 max-[600px]:p-3" className="max-[1100px]:order-1">
          <KeyField
            id="template-key"
            value={key}
            onChange={(v) => {
              setKey(v);
              setKeyError(null);
            }}
            error={keyError}
            placeholder="launch-brief"
          />
          <Field label="Name">
            <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} placeholder="Launch brief" required />
          </Field>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2">Kind</legend>
            <div className="flex gap-4 text-[15px]">
              {(["prd", "roadmap"] as const).map((k) => (
                <label key={k} className="inline-flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="kind"
                    className="size-4 accent-[var(--accent)]"
                    checked={kind === k}
                    onChange={() => setKind(k)}
                  />
                  {k === "prd" ? "PRD" : "Roadmap"}
                </label>
              ))}
            </div>
          </fieldset>
          <Field label="Description">
            <GrowingTextarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this template is for"
            />
          </Field>
        </Panel>
      </form>
    </>
  );
}
