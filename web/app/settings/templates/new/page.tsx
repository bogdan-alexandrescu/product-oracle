"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { ProblemList, TEMPLATE_SKELETON, TemplateBodyEditor } from "@/components/TemplateBodyEditor";
import { Button, ErrorNote, INPUT } from "@/components/ui";
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
    <div className="mx-auto max-w-4xl px-6 py-8">
      <p className="mb-2 text-sm">
        <Link href="/settings/templates" className="text-neutral-500 hover:text-neutral-900 hover:underline">
          ← Templates
        </Link>
      </p>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight text-neutral-900">New template</h1>
      <form onSubmit={create} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-neutral-700">Key</span>
            <input
              className={`${INPUT} font-mono`}
              value={key}
              onChange={(e) => setKey(e.target.value.toLowerCase())}
              placeholder="launch-brief"
              pattern="[a-z0-9][a-z0-9-]{1,62}"
              title="Lowercase letters, digits and hyphens"
              required
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-neutral-700">Name</span>
            <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} placeholder="Launch brief" required />
          </label>
        </div>
        <fieldset className="text-sm">
          <legend className="mb-1 font-medium text-neutral-700">Kind</legend>
          <div className="flex gap-4">
            {(["prd", "roadmap"] as const).map((k) => (
              <label key={k} className="inline-flex items-center gap-1.5">
                <input type="radio" name="kind" checked={kind === k} onChange={() => setKind(k)} />
                {k === "prd" ? "PRD" : "Roadmap"}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-neutral-700">Description</span>
          <input
            className={INPUT}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this template is for"
          />
        </label>
        <TemplateBodyEditor value={body} onChange={setBody}>
          {({ check, pending }) => (
            <div className="flex items-center gap-3">
              <Button type="submit" variant="primary" disabled={busy || pending || !check?.valid || !key || !name}>
                {busy ? "Creating…" : "Create template"}
              </Button>
              <span className="text-xs text-neutral-500">
                Headings end with <code>{"{#id}"}</code>; the last section is <code>## Sources and data points {"{#sources}"}</code>.
              </span>
            </div>
          )}
        </TemplateBodyEditor>
        {error && <ErrorNote>{error}</ErrorNote>}
        {problems.length > 0 && <ProblemList problems={problems} testId="save-problems" />}
      </form>
    </div>
  );
}
