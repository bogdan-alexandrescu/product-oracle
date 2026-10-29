"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Button, useFocusTrap } from "@/components/ds";
import { Icon } from "@/components/ds/Icon";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatInZone, useCompanyZone } from "@/lib/dates";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import { CHECK, SimpleSelect } from "./SimpleSelect";

type Options = Schemas["SimpleStartOptions"];
type Mode = Schemas["SimpleMeetingIn"]["change_mode"] & string;
type Origin = Schemas["SimpleMeetingIn"]["origin"] & string;

const LENGTHS = [15, 30, 45, 60, 90, 120];

/** The design system's form controls (qa-simple-prd-46, qa-simple-decide): a box or dot in the
 * accent (CHECK) and Simple's select (SimpleSelect), never the browser's bare ones. */
const CHOICE = "flex min-h-8 cursor-pointer items-center gap-2.5 has-[:disabled]:cursor-not-allowed has-[:disabled]:text-text2";

/**
 * Simple S8 (#723): the start sheet. Opened from the Meetings page, a one-pager, the
 * roadmap and a scheduled review: what is reviewed (a PRD picker unless the PRD is fixed),
 * who attends (the PRD's defaults checked, any member can be added), who may change things
 * through the meeting's chat, and its length. Who may start comes from the API's can_start;
 * everyone else reads who starts it and, when one is live, joins it.
 */
export function StartSheet({
  open,
  onClose,
  prd,
  occurrence,
  ritual,
  origin = "one_pager",
}: {
  open: boolean;
  onClose: () => void;
  /** The PRD reviewed (a one-pager's); none: the sheet asks. */
  prd?: string;
  /** A scheduled review it starts from. */
  occurrence?: string;
  /** A ritual's next review whose occurrence is not made yet (starting it makes it). */
  ritual?: Schemas["SimpleUpcomingMeeting"];
  origin?: Origin;
}) {
  // qa-simple-decide-16: the focus moves into the sheet and stays there until it closes (Escape closes it).
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, open, onClose);
  if (!open || typeof document === "undefined") return null;
  // On document.body (qa-simple-prd-46): inside the page the rail and the tab bar stacked above
  // the backdrop, so the page behind was dimmed unevenly; the app's Dialog backdrop colour, dark
  // in both themes (qa-simple-decide-5).
  return createPortal(
    <div data-testid="start-backdrop" className="fixed inset-0 z-50 flex items-end justify-center bg-hero/50 sm:items-center" onClick={onClose}>
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Start a review"
        className="max-h-[92vh] w-full overflow-auto rounded-t-2xl border border-border bg-surface p-5 text-[length:var(--simple-body)] text-text shadow-xl sm:max-w-[560px] sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <h2 className="simple-h2">Start a review</h2>
          <button type="button" className="simple-button simple-button-quiet" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={18} stroke={1.7} />
            Close
          </button>
        </div>
        <Body prd={prd} occurrence={occurrence} ritual={ritual} origin={origin} onClose={onClose} />
      </div>
    </div>,
    document.body,
  );
}

function Body({ prd, occurrence, ritual, origin, onClose }: { prd?: string; occurrence?: string; ritual?: Schemas["SimpleUpcomingMeeting"]; origin: Origin; onClose: () => void }) {
  const q = useQuery(`simple-meeting-options|${prd ?? ""}|${occurrence ?? ""}`, () =>
    unwrap(api.GET("/v1/simple/meetings/options", { params: { query: { prd: prd || undefined, occurrence: occurrence || undefined } } })),
  );
  const live = useQuery("simple-meetings", () => unwrap(api.GET("/v1/simple/meetings")));
  if (q.loading && !q.data) return <Loading />;
  if (q.error || !q.data) return <ErrorNote>{q.error ?? "Not found"}</ErrorNote>;
  return <Form key={q.data.prds.map((p) => p.document.slug).join()} options={q.data} fixed={!!prd} occurrence={occurrence} ritual={ritual} origin={origin} live={live.data?.live ?? []} onClose={onClose} />;
}

function Form({ options, fixed, occurrence, ritual, origin, live, onClose }: { options: Options; fixed: boolean; occurrence?: string; ritual?: Schemas["SimpleUpcomingMeeting"]; origin: Origin; live: Schemas["SimpleMeetingBrief"][]; onClose: () => void }) {
  const router = useRouter();
  const zone = useCompanyZone();
  const [slug, setSlug] = useState(options.prds[0]?.document.slug ?? "");
  const chosen = options.prds.find((p) => p.document.slug === slug);
  const occ = options.occurrence ?? ritual ?? null;
  const defaults = (p = chosen) => [...new Set([...(p?.default_attendee_ids ?? []), ...(occ?.attendees.map((a) => a.id) ?? [])])];
  const [people, setPeople] = useState<string[]>(() => defaults());
  const [mode, setMode] = useState<Mode>("everyone");
  const [named, setNamed] = useState<string[]>([]);
  // qa-simple-decide-6: a scheduled review keeps its own length.
  const [length, setLength] = useState(occ?.length_min ?? options.length_min);
  const { me } = useMe();
  // qa-simple-decide-35: someone besides the presenter attends.
  const others = people.filter((id) => id !== me?.user_id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const liveOne = chosen ? live.find((m) => m.prd.slug === chosen.document.slug) : undefined;
  const name = (id: string) => options.members.find((m) => m.id === id)?.name ?? "someone";

  function pick(next: string) {
    setSlug(next);
    setPeople(defaults(options.prds.find((p) => p.document.slug === next)));
    setNamed([]);
  }
  const toggle = (id: string) => {
    setPeople((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));
    setNamed((xs) => xs.filter((x) => x !== id));
  };
  const toggleNamed = (id: string) => setNamed((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : xs.length < 2 ? [...xs, id] : xs));

  async function start() {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const m = await unwrap(api.POST("/v1/simple/meetings", {
        body: {
          prd: chosen.document.slug, origin: occurrence || ritual ? "ritual" : origin, occurrence_id: occurrence ?? null,
          ritual_id: !occurrence && ritual ? ritual.ritual_id : null,
          due_at: !occurrence && ritual ? ritual.due_at : null,
          attendee_ids: people, change_mode: mode, change_people: mode === "named" ? named : [], length_min: length,
        },
      }));
      router.push(`/simple/meetings/${m.id}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  if (!options.prds.length) return <p>No PRD to review yet.</p>;
  return (
    <div className="space-y-4">
      {occ && (
        <p data-testid="start-occurrence">
          <strong>{occ.ritual_title}</strong> · {formatInZone(occ.due_at, zone, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
        </p>
      )}
      <section aria-label="What is reviewed">
        <h3 className="font-semibold">What is reviewed</h3>
        {fixed ? (
          <p>{chosen?.document.title}</p>
        ) : (
          <label className="mt-1 flex flex-col gap-1">
            <span className="simple-small">PRD</span>
            <SimpleSelect className="w-full" value={slug} onChange={(e) => pick(e.target.value)}>
              {options.prds.map((p) => <option key={p.document.slug} value={p.document.slug}>{p.document.title}</option>)}
            </SimpleSelect>
          </label>
        )}
        <p className="simple-small">The PRD, its roadmap slice, its open decisions</p>
      </section>
      {chosen && !chosen.can_start ? (
        <div role="status" className="space-y-2" data-testid="start-not-allowed">
          {/* qa-simple-decide-14: never "Only <me> can start": the person's role is why. */}
          <p>
            {chosen.starters.some((s) => s.id === me?.user_id) || !chosen.starters.length
              ? "You can't start a review of this PRD. Ask its decider to start it."
              : `Only ${chosen.starters.map((s) => s.name).join(", ")} can start this review.`}
          </p>
          {liveOne && <Button variant="primary" onClick={() => router.push(`/simple/meetings/${liveOne.id}`)}>Join</Button>}
        </div>
      ) : (
        <>
          <fieldset>
            <legend className="font-semibold">Invite people with these roles</legend>
            <div className="mt-1 grid gap-1 sm:grid-cols-2">
              {options.members.map((m) => (
                <label key={m.id} className={CHOICE}>
                  <input type="checkbox" className={CHECK} checked={people.includes(m.id)} onChange={() => toggle(m.id)} />
                  {m.name}
                </label>
              ))}
            </div>
            {others.length === 0 && (
              <p role="status" className="simple-small text-crit" data-testid="start-no-attendees">
                Pick at least one attendee besides you.
              </p>
            )}
            {/* qa-simple-decide-36: say what else the list changes. */}
            {occ && <p className="simple-small">The people ticked here also attend the next reviews of {occ.ritual_title}.</p>}
          </fieldset>
          <fieldset>
            <legend className="font-semibold">Who changes things in the chat</legend>
            {([["everyone", "Everyone"], ["presenter", "Only the presenter"], ["named", "Presenter plus one or two people"]] as const).map(([v, label]) => (
              <label key={v} className={CHOICE}>
                <input type="radio" className={CHECK} name="change-mode" checked={mode === v} onChange={() => setMode(v)} />
                {label}
              </label>
            ))}
            {mode === "named" && (
              <div className="ml-6 mt-1" aria-label="Who else changes things">
                {people.map((id) => (
                  <label key={id} className={CHOICE}>
                    <input type="checkbox" className={CHECK} checked={named.includes(id)} disabled={!named.includes(id) && named.length >= 2} onChange={() => toggleNamed(id)} />
                    {name(id)}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          <label className="flex items-center gap-2">
            <span className="font-semibold">Length</span>
            <SimpleSelect value={length} onChange={(e) => setLength(Number(e.target.value))}>
              {[...new Set([...LENGTHS, options.length_min, occ?.length_min ?? options.length_min])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{n} min</option>)}
            </SimpleSelect>
          </label>
          {error && <ErrorNote>{error}</ErrorNote>}
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
            <Button variant="secondary" className="h-10 px-4" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button variant="primary" disabled={busy || others.length === 0 || (mode === "named" && named.length === 0)} onClick={start}>Start</Button>
          </div>
        </>
      )}
    </div>
  );
}
