"use client";
// MOCK-HOOK: this whole file is the feature panel mock-up (decisions FP1..FP3), shown only behind ?fp1= / ?fp2= / ?fp3=.

import { useSearchParams } from "next/navigation";
import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ds";
import { usePhone } from "@/components/simple/FlowViews";
import { FP_ADDED, FP_ADDED_CONFLICT, FP_AFTER_SET, FP_BIG, FP_DIGEST, FP_ME, FP_NEW_END, FP_QUERY, FP_SEARCH, FP_TALK, type FpDep, type FpFeature } from "@/lib/api/mock/feature-panel";
import { useMe } from "@/lib/me";

type Phase = "rest" | "mid" | "set" | "deps" | "added" | "done";
type Opts = { fp1: string; fp2: string; fp3: string; phase: Phase; read: boolean; phone: boolean; f: FpFeature; big: boolean; setPhase: (p: Phase) => void };

const NEW_END = FP_NEW_END;
// The roadmap items a person may pick on the page (FP3 b).
const PICKABLE = ["Alert rules engine", "Alert history export", "Mobile alert push", "Alert routing by team", "Setup checklist", "Sample data import"];

/** The element on the page that names `title` (the smallest visible one), or null. */
function findOnPage(title: string): HTMLElement | null {
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let best: HTMLElement | null = null;
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const el = n.parentElement;
    if (!el || el.closest("[data-fp-mock]") || n.textContent?.trim() !== title) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > innerHeight) continue;
    const box = el.closest("button, a, li, [role=button]") as HTMLElement | null;
    if (!best) best = box && box.getBoundingClientRect().height < 72 ? box : el;
  }
  return best;
}

function useRect(title: string | null, tick: unknown): DOMRect | null {
  const [r, setR] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!title) return setR(null);
    const read = () => setR(findOnPage(title)?.getBoundingClientRect() ?? null);
    const t = setInterval(read, 400);
    read();
    addEventListener("scroll", read, true);
    return () => {
      clearInterval(t);
      removeEventListener("scroll", read, true);
    };
  }, [title, tick]);
  return r;
}

export function FeaturePanelMock() {
  const p = useSearchParams(); // MOCK-HOOK
  const active = p.has("fp1") || p.has("fp2") || p.has("fp3"); // MOCK-HOOK
  const fp1 = p.get("fp1") ?? "a"; // MOCK-HOOK
  const fp2 = p.get("fp2") ?? "a"; // MOCK-HOOK
  const fp3 = p.get("fp3") ?? "a"; // MOCK-HOOK
  const big = p.get("feat") === "big"; // MOCK-HOOK
  const urlPhase = (p.get("phase") ?? "rest") as Phase; // MOCK-HOOK
  const { can } = useMe();
  const read = p.get("viewer") === "read" || !can("create_simple_change"); // MOCK-HOOK
  const [open, setOpen] = useState(p.get("open") === "1" && urlPhase !== "done"); // MOCK-HOOK
  const [phase, setPhase] = useState<Phase>(urlPhase);
  const phone = usePhone();
  const f = big ? FP_BIG : FP_DIGEST;
  // The panel opens from any page: a click on a feature's name (Roadmap's bars, a goal bucket's rows, Home's cards).
  useEffect(() => {
    if (!active) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("[data-fp-mock]")) return;
      if ((t.textContent ?? "").trim() === FP_DIGEST.title) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(true);
        setPhase("rest");
      }
    };
    addEventListener("click", onClick, true);
    return () => removeEventListener("click", onClick, true);
  }, [active]);
  const anchor = useRect(active ? f.title : null, open);
  if (!active) return null;
  const o: Opts = { fp1, fp2, fp3, phase, read, phone, f, big, setPhase };
  const done = phase === "done" || (!open && urlPhase === "done");
  return (
    <div data-fp-mock="" data-testid="fp-mock">
      {done && <PageResult o={o} />}
      {fp3 === "b" && phase === "deps" && open && <PickMarks />}
      {fp3 === "b" && (phase === "added" || done) && <LinkLine from={FP_ADDED.title} to={FP_DIGEST.title} />}
      {open && !done && <Panel o={o} anchor={anchor} onClose={() => setOpen(false)} />}
    </div>
  );
}

/* ---------- FP1: the panel's form ---------- */

function Panel({ o, anchor, onClose }: { o: Opts; anchor: DOMRect | null; onClose: () => void }) {
  const { fp1, phone } = o;
  const [tab, setTab] = useState<"details" | "talk">("details");
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [onClose]);
  // A link step opens the panel at its Links part.
  useEffect(() => {
    if (o.phase === "deps" || o.phase === "added") document.querySelector('[data-fp-section="links"]')?.scrollIntoView({ block: "start" });
  }, [o.phase]);
  const head = <Head o={o} onClose={onClose} />;
  const body = <Body o={o} />;
  const talk = <Talk />;
  const dim = fp1 === "b" || fp1 === "c" || phone;
  const backdrop = dim && <div aria-hidden onClick={onClose} className="fixed inset-0 z-[55] bg-black/30" />;
  const base = "fixed z-[60] flex flex-col border-line bg-surface text-[15px] leading-[22px] text-text shadow-tip";
  const tabs = (
    <div role="tablist" aria-label="The feature" className="mt-2.5 flex gap-1 rounded-lg bg-surface2 p-1 text-sm">
      {(["details", "talk"] as const).map((t) => (
        <button key={t} role="tab" aria-selected={tab === t} type="button" onClick={() => setTab(t)} className={`flex-1 rounded-md px-2 py-1 ${tab === t ? "bg-surface font-medium shadow-sm" : "text-text2"}`}>
          {t === "details" ? "Details" : "Talk to Oracle"}
        </button>
      ))}
    </div>
  );
  if (phone) {
    // a, d: a sheet from the bottom; b, c: the whole screen.
    const full = fp1 === "b" || fp1 === "c";
    const tall = fp1 === "d" ? "h-[60dvh]" : "h-[88dvh]";
    return (
      <>
        {backdrop}
        <aside role="dialog" aria-label={o.f.title} data-fp-panel={fp1} className={`${base} ${full ? "inset-0" : `inset-x-0 bottom-0 ${tall} rounded-t-2xl border-t`}`}>
          {!full && <span aria-hidden className="mx-auto mt-2 mb-1 block h-1 w-10 flex-none rounded-sm bg-line-strong opacity-60" />}
          <div className="flex-none border-b border-line px-4 pt-2 pb-2.5">
            {head}
            {fp1 === "c" ? <Jumps /> : fp1 !== "d" && tabs}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-24">{tab === "talk" ? talk : body}</div>
          {fp1 === "d" && <p className="flex-none border-t border-line px-4 py-2 text-center text-sm text-accent-ink">Pull up for all details</p>}
          <Footer o={o} />
        </aside>
      </>
    );
  }
  if (fp1 === "b") {
    return (
      <>
        {backdrop}
        <aside role="dialog" aria-label={o.f.title} data-fp-panel="b" className={`${base} top-4 right-4 bottom-4 w-[880px] max-w-[calc(100vw-32px)] rounded-xl border`}>
          <div className="flex-none border-b border-line px-4 pt-3.5 pb-2.5">{head}</div>
          <div className="grid min-h-0 flex-1 grid-cols-[460px_minmax(0,1fr)]">
            <div className="flex min-h-0 flex-col border-r border-line">
              <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">{body}</div>
              <Footer o={o} />
            </div>
            <div className="flex min-h-0 min-w-0 flex-col">{talk}</div>
          </div>
        </aside>
      </>
    );
  }
  if (fp1 === "c") {
    return (
      <>
        {backdrop}
        <aside role="dialog" aria-label={o.f.title} data-fp-panel="c" className={`${base} top-6 bottom-0 left-1/2 w-[1040px] max-w-[calc(100vw-48px)] -translate-x-1/2 rounded-t-2xl border border-b-0`}>
          <div className="flex-none border-b border-line px-6 pt-4 pb-3">{head}</div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
            <Body o={o} grid />
          </div>
          <Footer o={o} />
        </aside>
      </>
    );
  }
  if (fp1 === "d") {
    // Beside the feature it was opened from, as today's roadmap card is.
    // Right of the feature when there is room, else left of it.
    const left = anchor ? (anchor.right + 392 < innerWidth ? anchor.right + 12 : Math.max(8, anchor.left - 392)) : 360;
    const top = anchor ? Math.max(12, Math.min(anchor.top - 8, innerHeight - 560)) : 120;
    return (
      <aside role="dialog" aria-label={o.f.title} data-fp-panel="d" style={{ left, top }} className={`${base} max-h-[560px] w-[380px] rounded-xl border`}>
        <div className="flex-none px-4 pt-3.5 pb-2">{head}</div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">{body}</div>
        <Footer o={o} />
      </aside>
    );
  }
  // a: a side panel over the right of the page; the page stays usable beside it.
  return (
    <aside role="dialog" aria-label={o.f.title} data-fp-panel="a" className={`${base} top-0 right-0 bottom-0 w-[460px] border-l`}>
      <div className="flex-none border-b border-line px-4 pt-3.5 pb-2.5">
        {head}
        {tabs}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">{tab === "talk" ? talk : body}</div>
      <Footer o={o} />
    </aside>
  );
}

function Jumps() {
  return (
    <nav aria-label="Parts" className="mt-2.5 flex gap-1.5 overflow-x-auto text-sm">
      {["Dates", "Goal", "Links", "Milestone", "Details", "Talk"].map((s) => (
        <span key={s} className="flex-none rounded-full border border-line px-2.5 py-0.5 text-text2">
          {s}
        </span>
      ))}
    </nav>
  );
}

function Head({ o, onClose }: { o: Opts; onClose: () => void }) {
  const { f, read, fp2, phase } = o;
  const allEdit = fp2 === "b" && phase === "mid";
  return (
    <div>
      <div className="flex items-start gap-2">
        <h2 className={`min-w-0 flex-1 text-lg leading-6 font-semibold ${o.big ? "line-clamp-3" : ""}`} title={f.title}>
          {f.title}
        </h2>
        {fp2 === "b" && !read && !allEdit && (
          <Button variant="ghost" onClick={() => o.setPhase("mid")}>
            Edit
          </Button>
        )}
        <button type="button" aria-label="Close" onClick={onClose} className="h-8 w-8 flex-none rounded text-text2 hover:bg-surface2">
          ×
        </button>
      </div>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text2">
        <span className="rounded-full bg-accent-soft px-2 py-px font-medium text-accent-ink">{f.status}</span>
        <span>Owner {f.owner}</span>
        <span aria-hidden>·</span>
        <span>{f.confidence} confidence</span>
        {o.f.conflict && <span className="rounded-full bg-crit-bg px-2 py-px font-medium text-crit">Dates clash</span>}
      </p>
      {read && (
        <p className="mt-2 rounded-lg bg-surface2 px-3 py-2 text-sm text-text2" data-testid="fp-read-only">
          You can read this feature. Its owner and approvers can change it.{" "}
          <button type="button" className="font-medium text-accent-ink underline">
            Suggest a change
          </button>
        </p>
      )}
    </div>
  );
}

function Footer({ o }: { o: Opts }) {
  if (o.fp2 !== "b" || o.phase !== "mid" || o.read) return null;
  return (
    <div className="flex flex-none items-center gap-2 border-t border-line bg-surface px-4 py-2.5" data-testid="fp-edit-footer">
      <span className="flex-1 text-sm text-text2">1 change: delivery</span>
      <Button variant="ghost" onClick={() => o.setPhase("rest")}>
        Cancel
      </Button>
      <Button variant="solid" onClick={() => o.setPhase("set")}>
        Save changes
      </Button>
    </div>
  );
}

function Talk() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <h3 className="flex-none px-4 pt-3 font-semibold">Talk about this feature</h3>
      <ul className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {FP_TALK.map((m, i) => (
          <li key={i} className={`max-w-[85%] rounded-xl px-3 py-2 text-[15px] ${m.who === "Oracle" ? "bg-surface2" : "ml-auto bg-accent-soft"}`}>
            <span className="block text-xs text-text2">{m.who}</span>
            {m.text}
          </li>
        ))}
      </ul>
      <div className="flex-none border-t border-line p-3">
        <div className="rounded-lg border border-line px-3 py-2 text-text-faint">Ask about this feature…</div>
      </div>
    </div>
  );
}

/* ---------- The panel's parts ---------- */

function Section({ title, o, id, children, wide }: { title: string; o: Opts; id: string; children: ReactNode; wide?: boolean }) {
  const editing = o.fp2 === "c" && o.phase === "mid" && id === "dates";
  const changed = o.fp2 === "c" && id === "dates" && afterSet(o.phase);
  return (
    <section className={`border-b border-line py-3 ${wide ? "col-span-2" : ""}`} data-fp-section={id}>
      <div className="flex items-center gap-2">
        <h3 className="flex-1 font-semibold">{title}</h3>
        {changed && <span className="rounded-full bg-warn-bg px-2 py-px text-xs font-medium text-warn">Changed by hand</span>}
        {o.fp2 === "c" && !o.read && !editing && (
          <button type="button" onClick={() => id === "dates" && o.setPhase("mid")} className="text-sm font-medium text-accent-ink hover:underline">
            Change
          </button>
        )}
      </div>
      <div className="mt-1.5">{children}</div>
    </section>
  );
}

const afterSet = (p: Phase) => p === "set";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-2 py-1">
      <dt className="text-sm leading-[22px] text-text2">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/** A value as FP2 lets it be changed: in place (a), in the panel's Edit mode (b), or in its section (c). */
function Value({ o, section, children, input }: { o: Opts; section: string; children: ReactNode; input?: string }) {
  const field = o.read ? "read" : o.fp2 === "a" ? "place" : o.phase === "mid" && (o.fp2 === "b" || section === "dates") ? "input" : "read";
  if (field === "input") return <input readOnly value={input ?? String(children)} className="h-9 w-full rounded-md border border-line-strong bg-surface px-2 text-[15px]" />;
  if (field === "place")
    return (
      <button type="button" className="-mx-1 rounded px-1 text-left decoration-line-strong decoration-dotted underline-offset-4 hover:bg-surface2 hover:underline" title="Click to change">
        {children}
      </button>
    );
  return <span>{children}</span>;
}

function Body({ o, grid }: { o: Opts; grid?: boolean }) {
  const { f } = o;
  const parts = [
    <Section key="dates" id="dates" title="Dates" o={o}>
      <Dates o={o} />
    </Section>,
    <Section key="goal" id="goal" title="Goal" o={o}>
      <Goal o={o} />
    </Section>,
    <Section key="links" id="links" title="Links" o={o}>
      <Links o={o} />
    </Section>,
    <Section key="milestone" id="milestone" title="Milestone" o={o}>
      <dl>
        <Row label="Milestone">
          <Value o={o} section="milestone">
            {f.milestone.name} · {f.milestone.date}
          </Value>
        </Row>
      </dl>
    </Section>,
    <Section key="details" id="details" title="Details" o={o}>
      <dl>
        <Row label="Outcome">
          <Value o={o} section="details">
            {f.outcome}
          </Value>
        </Row>
        <Row label="Status">
          <Value o={o} section="details">
            {f.status}
          </Value>
        </Row>
        <Row label="Owner">
          <Value o={o} section="details">
            {f.owner}
          </Value>
        </Row>
        <Row label="Confidence">
          <Value o={o} section="details">
            {f.confidence}
          </Value>
        </Row>
        <Row label="Notes">
          <Value o={o} section="details">
            {f.notes}
          </Value>
        </Row>
      </dl>
    </Section>,
  ];
  if (grid)
    return (
      <div className="grid grid-cols-2 gap-x-8">
        <div>{[parts[0], parts[2]]}</div>
        <div>{[parts[1], parts[3], parts[4]]}</div>
      </div>
    );
  // A compact card (FP1 d) shows dates, goal and links first; the rest below.
  return <div>{parts}</div>;
}

function Dates({ o }: { o: Opts }) {
  const { f, phase, fp2 } = o;
  const set = !o.big && afterSet(phase);
  const end = set ? NEW_END : f.end.date;
  const mid = phase === "mid" && !o.read;
  const conflict = phase === "added" && !o.big ? null : o.big ? f.conflict : set ? FP_AFTER_SET : f.conflict;
  return (
    <div>
      {fp2 === "b" && set && (
        <p className="mb-2 rounded-lg border border-warn/40 bg-warn-bg px-3 py-2 text-sm" data-testid="fp-overrides">
          <b className="font-medium">1 change from Oracle&apos;s plan.</b> Delivery Dec 10 → Nov 27, by {FP_ME}.{" "}
          <button type="button" onClick={() => o.setPhase("rest")} className="font-medium text-accent-ink underline">
            Restore
          </button>
        </p>
      )}
      <dl>
        <Row label="Start">
          <Value o={o} section="dates">
            {f.start.date}
          </Value>
          <span className="block text-sm text-text2">{f.start.from}</span>
        </Row>
        <Row label="Delivery">
          {mid && fp2 === "a" ? (
            <div data-testid="fp-mid-edit">
              <input readOnly autoFocus value={NEW_END} className="h-9 w-full rounded-md border-2 border-accent bg-surface px-2 text-[15px]" />
              <p className="mt-1 text-sm text-text2">Oracle suggests {f.end.suggested} (engineering estimate). Your date replaces it; you can restore it later.</p>
              <div className="mt-1.5 flex gap-2">
                <Button variant="solid" onClick={() => o.setPhase("set")}>
                  Save
                </Button>
                <Button variant="ghost" onClick={() => o.setPhase("rest")}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <>
              <span className="flex flex-wrap items-center gap-2">
                <Value o={o} section="dates" input={NEW_END}>
                  {end}
                </Value>
                {mid && fp2 === "b" && <span className="text-sm text-text2">Oracle: {f.end.suggested}</span>}
                {set && fp2 === "b" && <span className="rounded-full bg-warn-bg px-2 py-px text-xs font-medium text-warn">Set by hand</span>}
              </span>
              {set && fp2 === "a" ? (
                <span className="block text-sm text-text2" data-testid="fp-override">
                  Oracle suggested Dec 10; set to Nov 27 by {FP_ME} ·{" "}
                  <button type="button" onClick={() => o.setPhase("rest")} className="font-medium text-accent-ink underline">
                    Restore
                  </button>
                </span>
              ) : set ? (
                <span className="block text-sm text-text2">Set by {FP_ME}</span>
              ) : (
                <span className="block text-sm text-text2">
                  {f.end.from}
                  {o.big && f.end.suggested && ` · Oracle suggests ${f.end.suggested}`}
                </span>
              )}
            </>
          )}
        </Row>
        {mid && fp2 === "c" && (
          <Row label="Why">
            <textarea readOnly rows={2} value="To be ready for the Beta on Nov 30" className="w-full resize-none rounded-md border border-line-strong bg-surface px-2 py-1 text-[15px]" />
            <span className="mt-1 block text-sm text-text2">Oracle suggests Dec 10 (engineering estimate). Saving keeps your dates until someone restores Oracle&apos;s.</span>
            <div className="mt-1.5 flex gap-2">
              <Button variant="solid" onClick={() => o.setPhase("set")}>
                Save dates
              </Button>
              <Button variant="ghost" onClick={() => o.setPhase("rest")}>
                Cancel
              </Button>
            </div>
          </Row>
        )}
      </dl>
      {set && fp2 === "c" && (
        <p className="mt-1 text-sm text-text2" data-testid="fp-override">
          {FP_ME} changed the delivery from Dec 10 to Nov 27: &quot;To be ready for the Beta on Nov 30.&quot;{" "}
          <button type="button" onClick={() => o.setPhase("rest")} className="font-medium text-accent-ink underline">
            Restore Oracle&apos;s dates
          </button>
        </p>
      )}
      {conflict && <Clash text={conflict.text} fixes={conflict.fixes} read={o.read} />}
    </div>
  );
}

function Clash({ text, fixes, read }: { text: string; fixes: string[]; read: boolean }) {
  return (
    <div className="mt-2 rounded-lg border border-crit/40 bg-crit-bg px-3 py-2" data-testid="fp-clash">
      <p className="text-sm font-medium text-crit">{text}</p>
      {!read && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {fixes.map((x, i) => (
            <Button key={x} variant={i === 0 ? "solid" : "secondary"}>
              {x}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

function Goal({ o }: { o: Opts }) {
  const g = o.f.goal;
  return (
    <dl>
      <Row label="Serves">
        <Value o={o} section="goal">
          {g.title}
        </Value>
        {g.suggested && <span className="block text-sm text-text2">Oracle linked it from the PRD{o.read ? "" : " · Change"}</span>}
      </Row>
      <Row label="Measure">{g.measure}</Row>
      <Row label="Reading">
        <span className="tnum">
          Today <b className="font-semibold">{g.today}</b> · target <b className="font-semibold">{g.target}</b> by {g.by}
        </span>
      </Row>
    </dl>
  );
}

/* ---------- FP3: links both ways ---------- */

function Links({ o }: { o: Opts }) {
  const { f, phase, fp3 } = o;
  const added = !o.big && (phase === "added" || phase === "done");
  const dependsOn = added ? [...f.dependsOn, FP_ADDED] : f.dependsOn;
  if (fp3 === "c") return <LinkMap o={o} dependsOn={dependsOn} />;
  return (
    <div>
      <DepList o={o} title="Depends on" deps={dependsOn} add="Add an item it depends on" />
      {phase === "deps" && !o.read && (fp3 === "a" ? <Search /> : <PickHint />)}
      {added && <Clash text={FP_ADDED_CONFLICT.text} fixes={FP_ADDED_CONFLICT.fixes} read={o.read} />}
      <DepList o={o} title="Needed by" deps={f.neededBy} add="Add an item that needs it" />
    </div>
  );
}

function DepList({ o, title, deps, add }: { o: Opts; title: string; deps: FpDep[]; add: string }) {
  return (
    <div className="py-1">
      <h4 className="text-sm text-text2">
        {title} <span className="tnum">({deps.filter((d) => !d.removed).length})</span>
      </h4>
      <ul>
        {deps.map((d) => (
          <li key={d.title} className="flex items-start gap-2 border-b border-line py-1.5 last:border-0" data-testid="fp-dep">
            <div className="min-w-0 flex-1">
              <span className={`block ${d.removed ? "text-text2 line-through" : "font-medium"}`}>{d.title}</span>
              <span className="block text-sm text-text2">
                {d.dates} ·{" "}
                {d.removed ? (
                  <>
                    Oracle&apos;s link, removed by {d.by}
                    {!o.read && (
                      <>
                        {" · "}
                        <button type="button" className="font-medium text-accent-ink underline">
                          Restore
                        </button>
                      </>
                    )}
                  </>
                ) : d.from === "oracle" ? (
                  "Found by Oracle"
                ) : (
                  `Added by ${d.by}`
                )}
              </span>
              {d.conflict && <span className="mt-0.5 inline-block rounded-full bg-crit-bg px-2 py-px text-xs font-medium text-crit">Ends after this starts</span>}
            </div>
            {!o.read && !d.removed && (
              <button type="button" aria-label={`Remove ${d.title}`} className="h-7 w-7 flex-none rounded text-text2 hover:bg-surface2">
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      {!o.read && (
        <button type="button" onClick={() => o.setPhase("deps")} className="mt-1 text-sm font-medium text-accent-ink hover:underline">
          + {add}
        </button>
      )}
    </div>
  );
}

function Search() {
  return (
    <div className="my-2 rounded-lg border border-line-strong bg-surface p-2 shadow-tip" data-testid="fp-search">
      <input readOnly autoFocus value={FP_QUERY} className="h-9 w-full rounded-md border-2 border-accent bg-surface px-2 text-[15px]" />
      <ul className="mt-1">
        {FP_SEARCH.map((s, i) => (
          <li key={s.title} className={`rounded px-2 py-1.5 ${i === 0 ? "bg-surface2" : ""} ${s.note ? "text-text2" : ""}`}>
            <span className="block">{s.title}</span>
            <span className="block text-sm text-text2">
              {s.dates} · {s.roadmap}
              {s.note && ` · ${s.note}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PickHint() {
  const chart = typeof location !== "undefined" && location.pathname.startsWith("/simple/roadmap");
  return (
    <div className="my-2 rounded-lg border-2 border-accent bg-accent-soft px-3 py-2 text-sm" data-testid="fp-pick">
      <b className="font-medium">{chart ? "Click the item it depends on, on the roadmap." : "This page has no chart: type the item's name."}</b>
      <input readOnly value={chart ? "" : FP_QUERY} placeholder="Or type its name" className="mt-1.5 h-9 w-full rounded-md border border-line-strong bg-surface px-2 text-[15px]" />
      <button type="button" className="mt-1 font-medium text-accent-ink underline">
        Stop picking
      </button>
    </div>
  );
}

/** FP3 c: the links as a small map, what it needs on the left, what needs it on the right. */
function LinkMap({ o, dependsOn }: { o: Opts; dependsOn: FpDep[] }) {
  const node = (d: FpDep) => (
    <li key={d.title} className={`rounded-md border px-2 py-1 text-sm ${d.conflict ? "border-crit bg-crit-bg" : d.removed ? "border-dashed border-line text-text2 line-through" : "border-line bg-surface"}`}>
      <span className="block truncate font-medium">{d.title}</span>
      <span className="block truncate text-xs text-text2">
        {d.dates}
        {d.from === "oracle" && !d.removed ? " · Oracle" : ""}
      </span>
    </li>
  );
  const plus = (label: string) =>
    !o.read && (
      <li>
        <button type="button" onClick={() => o.setPhase("deps")} className="w-full rounded-md border border-dashed border-line-strong px-2 py-1 text-sm text-accent-ink">
          + {label}
        </button>
      </li>
    );
  const clash = o.big ? null : o.phase === "added" ? FP_ADDED_CONFLICT : null;
  return (
    <div data-testid="fp-map">
      <div className="grid grid-cols-[minmax(0,1fr)_28px_120px_28px_minmax(0,1fr)] items-center">
        <ul className="max-h-[260px] space-y-1.5 overflow-y-auto pr-1">
          {dependsOn.map(node)}
          {plus("Depends on")}
        </ul>
        <svg aria-hidden className="h-full w-full" viewBox="0 0 28 100" preserveAspectRatio="none">
          {dependsOn.map((d, i) => (
            <line key={i} x1="0" y1={((i + 0.5) / (dependsOn.length + 1)) * 100} x2="28" y2="50" stroke={d.conflict ? "var(--crit)" : "var(--line-strong)"} strokeWidth={d.conflict ? 2 : 1} vectorEffect="non-scaling-stroke" strokeDasharray={d.removed ? "3 3" : undefined} />
          ))}
        </svg>
        <div className="rounded-md border-2 border-accent bg-accent-soft px-2 py-2 text-center text-sm font-semibold">
          <span className="line-clamp-3">{o.f.title}</span>
          <span className="block text-xs font-normal text-text2">
            {o.f.start.date} – {!o.big && afterSet(o.phase) ? NEW_END : o.f.end.date}
          </span>
        </div>
        <svg aria-hidden className="h-full w-full" viewBox="0 0 28 100" preserveAspectRatio="none">
          {o.f.neededBy.map((d, i) => (
            <line key={i} x1="0" y1="50" x2="28" y2={((i + 0.5) / (o.f.neededBy.length + 1)) * 100} stroke="var(--line-strong)" vectorEffect="non-scaling-stroke" strokeDasharray={d.removed ? "3 3" : undefined} />
          ))}
        </svg>
        <ul className="space-y-1.5 pl-1">
          {o.f.neededBy.map(node)}
          {plus("Needed by")}
        </ul>
      </div>
      <p className="mt-1.5 text-xs text-text2">Dashed: Oracle&apos;s link, removed by a person. Red: the dates clash.</p>
      {o.phase === "deps" && !o.read && <Search />}
      {clash && <Clash text={clash.text} fixes={clash.fixes} read={o.read} />}
    </div>
  );
}

/* ---------- On the page ---------- */

/** FP3 b: while picking, every item on the chart is marked as one to click. */
function PickMarks() {
  const [rects, setRects] = useState<DOMRect[]>([]);
  useLayoutEffect(() => {
    const read = () => setRects(PICKABLE.filter((t) => t !== FP_DIGEST.title).flatMap((t) => findOnPage(t)?.getBoundingClientRect() ?? []));
    read();
    const t = setInterval(read, 400);
    return () => clearInterval(t);
  }, []);
  return (
    <>
      {rects.map((r, i) => (
        <div key={i} aria-hidden className="pointer-events-none fixed z-[58] rounded-md border-2 border-dashed border-accent bg-accent/10" style={{ left: r.left - 3, top: r.top - 3, width: r.width + 6, height: r.height + 6 }} />
      ))}
    </>
  );
}

function LinkLine({ from, to }: { from: string; to: string }) {
  const a = useRect(from, 0);
  const b = useRect(to, 0);
  if (!a || !b) return null;
  const x1 = a.right, y1 = a.top + a.height / 2, x2 = b.left, y2 = b.top + b.height / 2;
  const mx = (x1 + x2) / 2;
  return (
    <svg aria-hidden className="pointer-events-none fixed inset-0 z-[57] h-full w-full">
      <path d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} fill="none" stroke="var(--crit)" strokeWidth="2" strokeDasharray="5 4" />
      <circle cx={x2} cy={y2} r="4" fill="var(--crit)" />
    </svg>
  );
}

/** The page after the change: the feature marked where it is, and a note of what changed. */
function PageResult({ o }: { o: Opts }) {
  const r = useRect(FP_DIGEST.title, 0);
  const msg = new URLSearchParams(location.search).get("what") === "link" // MOCK-HOOK
    ? "Weekly alert digest now depends on Mobile alert push, and starts after it: Dec 21 – Jan 30, 2027."
    : `Weekly alert digest saved: delivery Nov 27, set by ${FP_ME} (Oracle suggested Dec 10).`;
  return (
    <>
      {r && <div aria-hidden className="pointer-events-none fixed z-[56] rounded-md ring-2 ring-accent ring-offset-2 ring-offset-surface" style={{ left: r.left - 2, top: r.top - 2, width: r.width + 4, height: r.height + 4 }} />}
      <div role="status" className={`fixed bottom-4 z-[60] flex max-w-[560px] items-center gap-3 rounded-lg bg-tip px-4 py-2.5 text-[15px] text-tip-text shadow-tip ${o.phone ? "inset-x-3" : "left-1/2 -translate-x-1/2"}`}>
        <span className="flex-1">{msg}</span>
        <button type="button" className="font-medium underline">
          Undo
        </button>
      </div>
    </>
  );
}
