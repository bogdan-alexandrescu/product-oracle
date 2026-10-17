"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { api, type DocumentSummary } from "@/lib/api/client";

type State =
  | { kind: "loading" }
  | { kind: "ready"; documents: DocumentSummary[] }
  | { kind: "error"; message: string };

export default function DocumentsPage() {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, response } = await api.GET("/v1/documents");
      if (cancelled) return;
      if (response.status === 401) {
        router.replace("/login");
      } else if (data) {
        setState({ kind: "ready", documents: data });
      } else if (response.status === 501) {
        // Backend not implemented yet (lane 1): show the empty state.
        setState({ kind: "ready", documents: [] });
      } else {
        setState({ kind: "error", message: `Could not load documents (${response.status}).` });
      }
    })().catch(() => !cancelled && setState({ kind: "error", message: "Cannot reach the API." }));
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Documents</h1>
      {state.kind === "loading" && <p className="text-neutral-500">Loading…</p>}
      {state.kind === "error" && <p className="text-red-700">{state.message}</p>}
      {state.kind === "ready" && state.documents.length === 0 && (
        <p className="text-neutral-600">
          No documents yet. Import a draft with <code>POST /v1/documents/&#123;doc&#125;/versions</code>.
        </p>
      )}
      {state.kind === "ready" && state.documents.length > 0 && (
        <ul className="divide-y divide-neutral-200 rounded border border-neutral-200 bg-white">
          {state.documents.map((d) => (
            <li key={d.id} className="flex items-center justify-between px-4 py-3">
              <Link href={`/documents/${d.slug}`} className="font-medium hover:underline">
                {d.title}
              </Link>
              <span className="text-sm text-neutral-500">
                {d.status}
                {d.latest_version != null && ` · v${d.latest_version}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
