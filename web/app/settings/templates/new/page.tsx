"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Field, INPUT } from "@/app/settings/_components/fields";
import { Button, InfoTip, Notice, PageHeader, Panel } from "@/components/ds";
import { ProblemList, TEMPLATE_SKELETON, TemplateBodyEditor, useTemplateCheck } from "@/components/TemplateBodyEditor";
import { api } from "@/lib/api/client";
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
  const [problems, setProblems] = useState<Problem[]>([]);
  const live = useTemplateCheck(body);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setProblems([]);
    try {
      const t = await unwrapProblems(
        api.POST("/v1/templates", {
          body: { key: key.trim(), name: name.trim(), kind, description: description.trim() || null, body },
        }),
      );
      router.push(`/settings/templates/${t.key}`);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : errorMessage(err));
      if (err instanceof ProblemsError) setProblems(err.problems);
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        back={
          <Link href="/settings/templates" className="hover:text-text hover:underline">
            ← Templates
          </Link>
        }
        title="New template"
        action={
          <Button
            type="submit"
            form="new-template"
            variant="primary"
            icon="plus"
            disabled={busy || live.pending || !live.data?.valid || !key || !name}
          >
            {busy ? "Creating…" : "Create template"}
          </Button>
        }
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
          </Panel>
        </div>
        <Panel title="Details" bodyClassName="flex flex-col gap-3 p-4 max-[600px]:p-3" className="max-[1100px]:order-1">
          <Field
            label="Key"
            htmlFor="template-key"
            tip={
              <InfoTip label="allowed characters" align="start">
                Lowercase letters, digits and hyphens. It cannot change later.
              </InfoTip>
            }
          >
            <input
              id="template-key"
              className={`${INPUT} font-mono`}
              value={key}
              onChange={(e) => setKey(e.target.value.toLowerCase())}
              placeholder="launch-brief"
              pattern="[a-z0-9][a-z0-9-]{1,62}"
              title="Lowercase letters, digits and hyphens"
              required
            />
          </Field>
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
            <input
              className={INPUT}
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
