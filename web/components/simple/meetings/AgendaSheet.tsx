"use client";

/**
 * agenda-sheet (mk-edit-meetings-tracks, proposal b, the owner's pick Nov 5): a live review
 * meeting's agenda. The strip says Now, Next and "Item 2 of 5" with Edit agenda; that opens
 * the Agenda sheet (a bottom sheet on a phone): numbered rows with minutes, up and down arrows
 * and dragging, Rename in place, × to remove and an Add box for a feature or a typed topic.
 * The meeting's own can_* fields say who acts: edit_agenda saves, propose_agenda proposes to
 * the decider, anyone else reads. A removed item is not kept in Trash (agenda items are not
 * deletable there): it goes, with Undo.
 */
import { useRef, useState } from "react";

import { InfoTip, Sheet, toast } from "@/components/ds";
import { openFeaturePanel } from "@/components/simple/FeaturePanelHost";
import { api, ApiError, unwrap, type Schemas } from "@/lib/api/client";
import { errorMessage } from "@/lib/use-query";

type Agenda = Schemas["SimpleAgenda"];
type Row = Schemas["SimpleAgendaRow"];
type Op = Schemas["SimpleAgendaEditIn"];

const BTN = "inline-flex h-8 items-center gap-1 rounded-lg border border-line bg-surface px-2.5 text-sm font-medium hover:bg-surface2 disabled:opacity-50";
const PRIMARY = "inline-flex h-8 items-center gap-1 rounded-lg bg-accent px-3 text-sm font-medium text-on-accent hover:brightness-110 disabled:opacity-50";
const FIELD = "h-9 w-full rounded-lg border border-line bg-surface px-2.5 text-[15px] outline-none focus:border-accent";
const CHIP = "inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2 py-px text-sm font-medium text-text";
const LINK = "text-sm font-medium text-accent-ink underline underline-offset-2";
const ICON = "h-8 w-8 rounded text-text2 hover:bg-surface2";

/** "moved X up", "added Y" -> "Moved X up and added Y." (one line for the batch). */
export function agendaSentence(words: string[]): string {
  const w = words.filter((x, i) => x !== words[i - 1]);
  if (!w.length) return "";
  const s = w.length === 1 ? w[0]! : `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}`;
  return `${s[0]!.toUpperCase()}${s.slice(1)}.`;
}

/** A feature's name opens the one feature panel (data-feature on the strip; in the sheet, a
 * dialog, it closes the sheet first: `onOpen`); a topic is plain text. */
function Name({ x, onOpen }: { x: Row; onOpen?: () => void }) {
  return x.feature_id ? (
    <button
      type="button"
      data-feature={x.feature_id}
      className="text-left hover:underline"
      onClick={
        onOpen
          ? () => {
              onOpen();
              openFeaturePanel(x.feature_id!);
            }
          : undefined
      }
    >
      {x.title}
    </button>
  ) : (
    <span>{x.title}</span>
  );
}

/** "1 left out": the ops whose item was removed since, said behind the (i). */
function LeftOut({ words, testId }: { words: string[]; testId: string }) {
  return (
    <span className="flex items-center gap-1 text-text2">
      <span data-testid={testId}>{words.length} left out</span>
      <InfoTip label="What was left out" align="start">
        The item was removed since: {agendaSentence(words)}
      </InfoTip>
    </span>
  );
}

function Mark({ s }: { s: Row["state"] }) {
  if (s === "done") return <span aria-label="Done" className="text-text-faint">✓</span>;
  if (s === "now") return <span aria-label="Now" className="inline-block h-2.5 w-2.5 rounded-full bg-accent" />;
  if (s === "skipped") return <span className="text-sm text-text-faint">skipped</span>;
  return null;
}

export function AgendaSheet({ meetingId, agenda, can, phone, reload }: { meetingId: string; agenda: Agenda; can: Schemas["SimpleMeetingCan"]; phone: boolean; reload: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [adding, setAdding] = useState("");
  const [dragged, setDragged] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const batch = useRef<string>("");
  const [mine, setMine] = useState<string[]>([]);
  const mode = can.edit_agenda ? "save" : can.propose_agenda ? "propose" : "read";
  const may = mode !== "read";
  const rows = agenda.items ?? [];
  const nowAt = rows.findIndex((x) => x.state === "now");
  const chatNext = agenda.next ? rows.find((x) => x.feature_id === agenda.next!.id) ?? ({ id: agenda.next.id, kind: "feature", feature_id: agenda.next.id, title: agenda.next.title, mins: 0, state: "next" } as Row) : null;
  const next = chatNext ?? rows.find((x, i) => i > nowAt && x.state === "next");
  const locked = (x: Row) => x.state === "done" || x.state === "now";
  const firstMovable = rows.findIndex((x) => !locked(x));
  const label = mode === "propose" ? "Propose" : "Save";

  const send = async (op: Op) => {
    setBusy(true);
    try {
      await unwrap(api.POST("/v1/simple/meetings/{meeting_id}/agenda", { params: { path: { meeting_id: meetingId } }, body: { batch: batch.current, ...op } }));
      await reload();
      return true;
    } catch (e) {
      toast({ message: errorMessage(e) });
      // Someone changed the agenda since: read it again, so a stale Undo line goes at once.
      if (e instanceof ApiError && e.status === 409) await reload();
      return false;
    } finally {
      setBusy(false);
    }
  };
  const openSheet = () => {
    batch.current = crypto.randomUUID();
    setMine((was) => [...was, batch.current]);
    setOpen(true);
  };
  // The decider's accept is their own batch, so its Undo line shows to them.
  const accept = () => {
    const b = crypto.randomUUID();
    setMine((was) => [...was, b]);
    return send({ op: "accept", batch: b });
  };
  const move = (x: Row, to: number) => send({ op: "move", item_id: x.id, to });
  const add = async (body: Op) => {
    if (await send(body)) setAdding("");
  };
  const typed = adding.trim();
  const addable = (agenda.addable ?? []).filter((f) => !typed || f.title.toLowerCase().includes(typed.toLowerCase())).slice(0, phone ? 2 : 4);

  const leftOut = agenda.left_out ?? [];
  const showDone = mode === "save" && agenda.batch && mine.includes(agenda.batch) && (agenda.words.length > 0 || leftOut.length > 0);
  const prop = agenda.proposal;

  return (
    <>
      <div aria-label="Agenda" data-testid="agenda-strip" className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-line px-4 py-2 text-base [overflow-wrap:anywhere]">
        {nowAt >= 0 && (
          <p data-testid="agenda-now">
            <span className="font-semibold">Now:</span> <Name x={rows[nowAt]!} />
          </p>
        )}
        {next && (
          <p data-testid="agenda-next">
            <span className="font-semibold">Next:</span> <Name x={next} />
            {next.kind === "topic" && <span className="text-sm text-text-faint"> · topic</span>}
          </p>
        )}
        {nowAt >= 0 && (
          <p className="text-text2" data-testid="agenda-count">
            Item {nowAt + 1} of {rows.length}
          </p>
        )}
        <button type="button" className={`ml-auto ${BTN}`} onClick={openSheet} data-testid="agenda-open">
          {may ? "Edit agenda" : "See agenda"}
        </button>
      </div>
      {showDone && (
        <p role="status" className="flex flex-wrap items-center gap-x-3 border-b border-line bg-[var(--simple-edited)] px-4 py-1.5 text-base" data-testid="agenda-done">
          {agendaSentence(agenda.words)}
          {leftOut.length > 0 && <LeftOut words={leftOut} testId="agenda-left-out" />}
          <button type="button" className={LINK} disabled={busy} onClick={() => send({ op: "undo", batch: agenda.batch })}>
            Undo
          </button>
        </p>
      )}
      {prop && (
        <p role="status" className="flex flex-wrap items-center gap-x-3 border-b border-line bg-[var(--simple-edited)] px-4 py-1.5 text-base" data-testid="agenda-proposal">
          <span className="flex items-center gap-1">
            <span className={CHIP}>Proposed</span>
            <InfoTip label="What is proposed" align="start">
              {agendaSentence(prop.words)}
            </InfoTip>
          </span>
          <span>Waits for {prop.decider?.name ?? "an owner"}</span>
          {mode === "save" && (
            <button type="button" className={LINK} disabled={busy} onClick={accept}>
              Accept
            </button>
          )}
          {(mode === "save" || mode === "propose") && (
            <button type="button" className={LINK} disabled={busy} onClick={() => send({ op: "withdraw" })}>
              {mode === "save" ? "Decline" : "Withdraw"}
            </button>
          )}
          {mode === "propose" && (prop.dropped ?? []).length > 0 && <LeftOut words={prop.dropped ?? []} testId="agenda-dropped" />}
        </p>
      )}
      <Sheet open={open} title="Agenda" onClose={() => setOpen(false)} side testId="agenda-sheet" tools={!may ? <span className="text-sm text-text2">View only</span> : undefined}>
        <div className="px-4 pb-4">
          <ol className="flex flex-col" data-testid="agenda-rows">
            {rows.map((x, i) => {
              const edit = renaming?.id === x.id;
              const movable = may && !locked(x);
              const drag = movable && !phone;
              return (
                <li
                  key={x.id}
                  data-testid="agenda-row"
                  data-state={x.state}
                  draggable={drag && !edit}
                  onDragStart={drag ? (e) => { e.dataTransfer.setData("text/plain", x.id); e.dataTransfer.effectAllowed = "move"; setDragged(x.id); } : undefined}
                  onDragEnd={() => { setDragged(null); setOver(null); }}
                  onDragOver={dragged && i >= firstMovable ? (e) => { e.preventDefault(); setOver(i); } : undefined}
                  onDrop={dragged ? (e) => { e.preventDefault(); const it = rows.find((r) => r.id === dragged); setDragged(null); setOver(null); if (it && rows.indexOf(it) !== i) void move(it, i); } : undefined}
                  className={`flex items-center gap-2 border-b border-line py-2 ${edit ? "-mx-2 rounded-lg bg-accent-soft px-2" : ""} ${over === i && dragged !== x.id ? "border-t-2 border-t-accent" : ""} ${dragged === x.id ? "opacity-50" : ""}`}
                >
                  {movable ? <span aria-hidden className={`text-text-faint ${drag ? "cursor-grab" : ""}`}>⠿</span> : <span className="w-[10px]" />}
                  <span className="w-5 text-sm text-text-faint">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    {edit ? (
                      <form
                        className="grid gap-1.5"
                        onSubmit={async (e) => {
                          e.preventDefault();
                          if (renaming.title.trim() && (await send({ op: "rename", item_id: x.id, title: renaming.title.trim() }))) setRenaming(null);
                        }}
                      >
                        <input aria-label="Item name" autoFocus value={renaming.title} onChange={(e) => setRenaming({ id: x.id, title: e.target.value })} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setRenaming(null))} className={FIELD} maxLength={200} />
                        <div className="flex gap-2">
                          <button type="submit" className={PRIMARY} disabled={busy || !renaming.title.trim()}>
                            {label}
                          </button>
                          <button type="button" className={BTN} onClick={() => setRenaming(null)}>
                            Cancel
                          </button>
                        </div>
                      </form>
                    ) : (
                      <>
                        <p className={`break-words ${x.state === "done" ? "text-text2" : ""}`}>
                          <Name x={x} onOpen={() => setOpen(false)} /> <Mark s={x.state} />
                        </p>
                        <p className="text-sm text-text-faint">
                          {x.mins} min{x.kind === "topic" ? " · topic" : ""}
                          {x.by_name && x.kind === "topic" ? ` · added by ${x.by_name}` : ""}
                        </p>
                      </>
                    )}
                  </div>
                  {movable && !edit && (
                    <span className="flex flex-none items-center gap-1">
                      {i === firstMovable ? <span aria-hidden className="w-8" /> : <button type="button" aria-label={`Move ${x.title} up`} className={ICON} disabled={busy} onClick={() => move(x, i - 1)}>↑</button>}
                      {i === rows.length - 1 ? <span aria-hidden className="w-8" /> : <button type="button" aria-label={`Move ${x.title} down`} className={ICON} disabled={busy} onClick={() => move(x, i + 1)}>↓</button>}
                      <button type="button" aria-label={`Rename ${x.title}`} className="h-8 rounded px-1.5 text-sm text-text2 hover:bg-surface2" onClick={() => setRenaming({ id: x.id, title: x.title })}>
                        Rename
                      </button>
                      <button type="button" aria-label={`Remove ${x.title}`} className={`${ICON} hover:text-crit`} disabled={busy} onClick={() => send({ op: "remove", item_id: x.id })}>
                        ×
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
          {may && (
            <form
              className="mt-3 grid gap-2"
              data-testid="agenda-add"
              onSubmit={(e) => {
                e.preventDefault();
                if (!typed) return;
                const f = (agenda.addable ?? []).find((a) => a.title.toLowerCase() === typed.toLowerCase());
                void add(f ? { op: "add", feature_id: f.id } : { op: "add", title: typed });
              }}
            >
              <label className="text-sm font-medium" htmlFor="agenda-add-name">
                Add a feature or a topic
              </label>
              <input id="agenda-add-name" placeholder="Type a name" value={adding} onChange={(e) => setAdding(e.target.value)} className={FIELD} maxLength={200} enterKeyHint="done" />
              {addable.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {addable.map((f) => (
                    <button key={f.id} type="button" disabled={busy} className="rounded-full border border-line px-2.5 py-0.5 text-sm hover:bg-surface2" onClick={() => add({ op: "add", feature_id: f.id })}>
                      + {f.title}
                    </button>
                  ))}
                </div>
              )}
            </form>
          )}
          {mode === "propose" && (
            <p className="mt-3">
              <span className={CHIP}>Waits for {prop?.decider?.name ?? agenda.decider?.name ?? "an owner"}</span>
            </p>
          )}
        </div>
      </Sheet>
    </>
  );
}
