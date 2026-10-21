"use client";

import { useId, useState } from "react";

import { PersonPicker, type Person } from "@/components/PersonPicker";
import { Button, Chip, SegmentedControl } from "@/components/ds";
import { InlineError, TEXTAREA } from "@/components/review/parts";
import { Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { errorMessage, useQuery } from "@/lib/use-query";

import { DiscussionList, isHidden } from "./DiscussionList";
import { DiscussionThread } from "./DiscussionThread";

/** What a discussion is about (G1 3.2), and the label its title starts from. */
export type DiscussionSubject = {
  kind: Schemas["DiscussionCreate"]["subject_kind"];
  subject: Record<string, unknown>;
  label: string;
};

/**
 * Start a discussion: the title (prefilled with the subject's label), Open or Private, the
 * people a private one is for, and an optional first message.
 */
export function StartDiscussion({
  subject,
  onStarted,
  onCancel,
}: {
  subject: DiscussionSubject;
  onStarted: (id: string) => void;
  onCancel?: () => void;
}) {
  const id = useId();
  const [title, setTitle] = useState(subject.label.slice(0, 200));
  const [visibility, setVisibility] = useState<"open" | "private">("open");
  const [people, setPeople] = useState<Person[]>([]);
  const [first, setFirst] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setSaving(true);
    setError(null);
    try {
      const d = await unwrap(
        api.POST("/v1/discussions", {
          body: {
            subject_kind: subject.kind,
            subject: subject.subject,
            title: title.trim() || null,
            visibility,
            participants: visibility === "private" ? people.map((p) => p.user_id) : [],
            message: first.trim() ? { body: first.trim(), mention_oracle: false } : null,
          },
        }),
      );
      onStarted(d.id);
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  };

  return (
    <form
      data-testid="start-discussion"
      className="flex min-w-0 flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
    >
      <h3 className="font-display text-[15px] font-bold tracking-heading">Start a discussion</h3>
      <label className="flex flex-col gap-1 text-sm font-semibold text-text2" htmlFor={`${id}-title`}>
        Title
      </label>
      <input
        id={`${id}-title`}
        value={title}
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
        className={`${TEXTAREA} -mt-2 h-9`}
      />
      <SegmentedControl<"open" | "private">
        label="Who can read it"
        size="sm"
        value={visibility}
        onChange={setVisibility}
        items={[
          { value: "open", label: "Open" },
          { value: "private", label: "Private" },
        ]}
      />
      {visibility === "private" ? (
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-sm leading-5 text-text2">Only the people you pick can read it. Everyone else sees that a private discussion exists.</p>
          {people.length > 0 && (
            <ul className="flex flex-wrap gap-1.5" aria-label="People in it">
              {people.map((p) => (
                <li key={p.user_id} data-testid="picked-person">
                  <Chip kind="acc">
                    {p.name}
                    <button
                      type="button"
                      aria-label={`Remove ${p.name}`}
                      className="ml-1 font-bold"
                      onClick={() => setPeople((all) => all.filter((x) => x.user_id !== p.user_id))}
                    >
                      ×
                    </button>
                  </Chip>
                </li>
              ))}
            </ul>
          )}
          <PersonPicker
            writersOnly={false}
            exclude={people.map((p) => p.user_id)}
            onPick={(p) => setPeople((all) => [...all, p])}
          />
        </div>
      ) : (
        <p className="text-sm leading-5 text-text2">Everyone who can see this can read it.</p>
      )}
      <label className="text-sm font-semibold text-text2" htmlFor={`${id}-first`}>
        First message
      </label>
      <textarea
        id={`${id}-first`}
        rows={3}
        maxLength={8000}
        placeholder="Write to the team…"
        value={first}
        onChange={(e) => setFirst(e.target.value)}
        className={`${TEXTAREA} -mt-2`}
      />
      {error && <InlineError>{error}</InlineError>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="solid" disabled={saving}>
          Start discussion
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

/**
 * Everything about one subject in one place (the run page's Discuss sheet): its latest
 * discussion the reader can open, else the list, and Start a discussion.
 */
export function DiscussSubject({ subject, subjectKey }: { subject: DiscussionSubject; subjectKey: string }) {
  const [key, setKey] = useState(0);
  const [view, setView] = useState<{ id: string } | "start" | "list" | null>(null);
  const rowsQ = useQuery(`discussions|${subjectKey}|${key}`, () =>
    unwrap(api.GET("/v1/discussions", { params: { query: { subject_key: subjectKey } } })).then((r) => r.items),
  );
  const rows = rowsQ.data;
  if (rowsQ.error) return <InlineError>{rowsQ.error}</InlineError>;
  if (!rows) return <Loading />;
  const latest = rows.find((r) => !isHidden(r));
  const shown = view ?? (latest ? { id: latest.id } : rows.length ? "list" : "start");
  const toList = () => {
    setView("list");
    setKey((k) => k + 1);
  };
  if (shown === "start")
    return (
      <StartDiscussion
        subject={subject}
        onStarted={(id) => {
          setView({ id });
          setKey((k) => k + 1);
        }}
        onCancel={rows.length ? toList : undefined}
      />
    );
  if (shown === "list")
    return (
      <div className="flex flex-col gap-3">
        <div>
          <Button icon="comment" onClick={() => setView("start")}>
            Start a discussion
          </Button>
        </div>
        <DiscussionList rows={rows} onOpen={(id) => setView({ id })} />
      </div>
    );
  return <DiscussionThread key={shown.id} id={shown.id} onBack={toList} backLabel="All discussions" onChanged={() => setKey((k) => k + 1)} />;
}
