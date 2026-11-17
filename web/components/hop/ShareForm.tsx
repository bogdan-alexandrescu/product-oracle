"use client";

import { useEffect, useMemo, useState } from "react";

import { useFeatureStates } from "@/components/current-state/CurrentState";
import { Button } from "@/components/ds";
import { InlineError, TEXTAREA } from "@/components/review/parts";
import { api, unwrap } from "@/lib/api/client";
import { named } from "@/lib/codes";
import { plainText } from "@/lib/raw-tokens";
import { errorMessage } from "@/lib/use-query";

/** Share as discussion (G7 3.1): the chat's summary, edited, opens an open discussion on the same subject. */
export function ShareForm({ id, onShared, onCancel }: { id: string; onShared: (id: string) => void; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // qa-nov17 ask 1: the features, so each one the answer names reads with its code ("F-06 Weekly alert digest").
  const states = useFeatureStates();
  const read = !!states.data || !!states.error;
  const features = useMemo(() => (states.data?.features ?? []).map((f) => named(f.title, f.code)), [states.data]);
  useEffect(() => {
    if (!read) return;
    let live = true;
    Promise.all([
      unwrap(api.GET("/v1/discussions/{discussion_id}", { params: { path: { discussion_id: id } } })),
      unwrap(api.GET("/v1/discussions/{discussion_id}/messages", { params: { path: { discussion_id: id }, query: { limit: 200 } } })),
    ])
      .then(([d, page]) => {
        if (!live) return;
        const lastReply = [...page.items].reverse().find((m) => m.author_kind === "oracle" && m.body && !m.deleted);
        setTitle(d.title);
        // ask-phone QA row 1: the first message is everyone's to read, so Oracle's raw citation
        // tokens ("[c:1]") are not carried into it; nor its markdown ("**", "###", qa-nov17 ask 1).
        setText(plainText(d.summary ?? lastReply?.body ?? "", features));
      })
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [id, read, features]);
  const post = async () => {
    if (!text?.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const d = await unwrap(
        api.POST("/v1/discussions/{discussion_id}/share", { params: { path: { discussion_id: id } }, body: { title: title.trim() || null, first_message: text.trim() } }),
      );
      onShared(d.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex flex-col gap-2"
      data-testid="hop-share-form"
      onSubmit={(e) => {
        e.preventDefault();
        void post();
      }}
    >
      <h3 className="font-display text-[17px] font-bold">Share as discussion</h3>
      <label className="flex flex-col gap-1 text-sm font-semibold">
        Title
        <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} className={`${TEXTAREA} h-10`} />
      </label>
      <label className="flex flex-col gap-1 text-sm font-semibold">
        First message
        <textarea rows={5} maxLength={8000} value={text ?? ""} disabled={text === null} onChange={(e) => setText(e.target.value)} className={TEXTAREA} />
      </label>
      {error && <InlineError>{error}</InlineError>}
      <div className="flex gap-2">
        <Button type="submit" variant="solid" disabled={busy || !text?.trim()}>
          Post
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
