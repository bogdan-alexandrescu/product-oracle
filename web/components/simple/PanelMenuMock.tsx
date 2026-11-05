"use client";

// MOCK-HOOK (whole file): mk-panel-menu mock-ups only, never merged. The feature panel's menu
// (Cut, Restore, Delete to Trash), the Delete confirm for a feature and for a goal, and the
// features and goals in Settings > Trash, each drawn as the owner's switchable proposals:
//   ?pm1=a|b|c|d  where the menu sits and how a cut feature's panel reads
//   ?pm2=a|b|c|d  the Delete confirm
//   ?pm3=a|b|c    Settings > Trash with features and goals beside documents
//   &as=owner|approver|viewer  who is signed in (sets the mock's role)
//   &open=menu|cut|delete|goal  opens that control on load

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";

import { Button, Chip, InfoTip, toast } from "@/components/ds";
import { mkCutBy, mkSaveTrash, mkSetCutBy, mkTrash, type MkTrash } from "@/lib/api/mock/panel-trash";
import { sendCardChanged } from "@/lib/api/simple-chat";
import { calendarDay } from "@/lib/dates";
import { formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";

import type { Act } from "@/app/simple/roadmap/_card";
import { deciderWords, statusWord, type Item } from "@/app/simple/roadmap/_lib";

export const mkParam = (name: string, dflt: string): string => (typeof location === "undefined" ? dflt : (new URLSearchParams(location.search).get(name) ?? dflt)); // MOCK-HOOK

/** `?as=` sets the mock's signed-in role before the first read (MOCK-HOOK). */
export function mkRoleFromUrl(): void { // MOCK-HOOK
  if (typeof location === "undefined") return;
  const as = new URLSearchParams(location.search).get("as");
  if (as === "owner") localStorage.removeItem("po-mock-role");
  else if (as) localStorage.setItem("po-mock-role", as);
}

const MENU = "absolute right-0 top-9 z-[80] w-72 rounded-lg border border-line bg-surface p-1 text-[15px] shadow-lg";
const ITEM = "flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left hover:bg-surface2";
const ICON = "inline-flex h-8 w-8 flex-none items-center justify-center rounded-lg border border-transparent text-[16px] text-text hover:border-line-strong hover:bg-surface2";
const andList = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** The decisions that name a feature: the mock invents a steady count per feature. */
const decisionsOf = (item: Item) => [...item.key].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 3 + (item.needed_by.length ? 1 : 0);

function useAway(open: boolean, close: () => void) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), close());
    document.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc, true);
    };
  }, [open, close]);
  return ref;
}

function Modal({ label, children, onClose }: { label: string; children: ReactNode; onClose: () => void }) {
  return (
    <div data-backdrop="" className="fixed inset-0 z-[90] flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={label} data-testid="mk-confirm" className="flex max-h-[88vh] w-full max-w-lg flex-col overflow-y-auto rounded-t-[var(--simple-card-radius)] border border-line bg-surface p-4 text-[15px] leading-[22px] shadow-lg sm:rounded-[var(--simple-card-radius)]" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

const H = ({ children }: { children: ReactNode }) => <h2 className="text-[length:var(--simple-h2)] font-semibold leading-[var(--simple-h2-leading)]">{children}</h2>;

/** What points at a thing about to go to Trash, one row each (pm2 b and c). */
function Points({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="mt-2 grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-lg bg-surface2 px-3 py-2 text-[15px]" data-testid="mk-points">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-text2">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const TRASH_LINE = "Restore it from Settings › Trash for 30 days.";

/** The Delete confirm, as each pm2 proposal draws it; `kind` a feature or a goal. */
export function DeleteConfirm({ kind, title, rows, counts, dependents, decides, decider, onClose, onDelete }: { kind: "feature" | "goal"; title: string; rows: [string, ReactNode][]; counts: string; dependents: string[]; decides: boolean; decider: string; onClose: () => void; onDelete: () => void }) {
  const v = mkParam("pm2", "b");
  const [typed, setTyped] = useState("");
  const needType = v === "c" && dependents.length > 0;
  const ok = !needType || typed.trim().toLowerCase() === title.toLowerCase();
  const go = decides ? "Move to Trash" : "Propose moving to Trash";
  return (
    <Modal label={`Delete ${title}`} onClose={onClose}>
      <H>{decides ? `Move ${title} to Trash?` : `Propose moving ${title} to Trash?`}</H>
      {v === "a" && (
        <p className="mt-2 flex items-center gap-1.5 text-text2">
          {counts}
          <InfoTip label="What goes with it" align="start" side="bottom">
            <span className="block">{rows.map(([k, val]) => <span key={k} className="block">{k}: {typeof val === "string" ? val : val}</span>)}</span>
          </InfoTip>
        </p>
      )}
      {(v === "b" || v === "c") && <Points rows={rows} />}
      {needType && (
        <label className="mt-3 grid gap-1">
          <span className="text-warn">⚠ {andList(dependents)} {dependents.length === 1 ? "depends" : "depend"} on it. Type its name to go on.</span>
          <input aria-label="Its name" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={title} className="h-9 rounded-md border-2 border-accent bg-surface px-2" />
        </label>
      )}
      <p className="mt-2 text-text2">{decides ? TRASH_LINE : `It waits for ${decider} to accept.`}</p>
      <div className="mt-3 flex items-center gap-2">
        <Button variant={decides ? "danger" : "solid"} disabled={!ok} onClick={onDelete}>
          {go}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        {kind === "feature" && decides && <span className="ml-auto text-[13px] text-text2">Not now? Cut keeps it on the roadmap.</span>}
        {kind === "goal" && decides && <span className="ml-auto text-[13px] text-text2">Not now? Archive keeps it.</span>}
      </div>
    </Modal>
  );
}

/** Sends a feature to Trash in the mock (its roadmap leaves it out), with Undo. */
function trashFeature(item: Item, by: string, onGone: () => void) {
  const row: MkTrash = {
    id: `t-${item.key}`,
    kind: "Feature",
    title: item.title,
    where: item.roadmap.title.replace(/ roadmap$/i, ""),
    key: item.key,
    by,
    at: new Date().toISOString(),
    days_left: 30,
    back: [`Dates ${calendarDay(item.start.date)} – ${calendarDay(item.end.date)}`, plural(item.depends_on.length + item.needed_by.length, "link"), ...(item.milestone?.name ? [`Milestone ${item.milestone.name}`] : []), ...(item.goal ? [`Goal ${item.goal.title}`] : [])],
  };
  mkSaveTrash([row, ...mkTrash().filter((t) => t.id !== row.id)]);
  onGone();
  sendCardChanged();
  toast({
    message: `Moved ${item.title} to Trash`,
    action: {
      label: "Undo",
      onClick: () => {
        mkSaveTrash(mkTrash().filter((t) => t.id !== row.id));
        sendCardChanged();
      },
    },
  });
}

function CutConfirm({ item, items, decides, decider, onClose, onCut }: { item: Item; items: Map<string, Item>; decides: boolean; decider: string; onClose: () => void; onCut: () => void }) {
  const deps = item.needed_by.map((id) => items.get(id)?.title).filter((t): t is string => !!t);
  return (
    <Modal label={`Cut ${item.title}`} onClose={onClose}>
      <H>{decides ? `Cut ${item.title} from the roadmap?` : `Propose cutting ${item.title}?`}</H>
      <p className={`mt-2 ${deps.length ? "text-warn" : "text-text2"}`}>{deps.length ? `⚠ ${andList(deps)} ${deps.length === 1 ? "depends" : "depend"} on it.` : "Nothing depends on it."}</p>
      <p className="mt-1 text-text2">{decides ? "It stays on the roadmap as cut; Restore brings it back." : `It waits for ${decider} to accept.`}</p>
      <div className="mt-3 flex items-center gap-2">
        <Button variant="solid" onClick={onCut}>
          {decides ? "Cut from the roadmap" : "Propose the cut"}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Modal>
  );
}

/** Everything the panel shows for its menu, as the picked pm1 proposal places it. */
export function useMkPanel({ item, items, act, canChange, onClose }: { item: Item; items: Map<string, Item>; act: Act; canChange: boolean; onClose: () => void }) {
  const v = mkParam("pm1", "a");
  const [first] = useState(() => mkParam("open", ""));
  const [menu, setMenu] = useState(first === "menu");
  const [ask, setAsk] = useState<"cut" | "delete" | null>(first === "cut" || first === "delete" ? first : null);
  const ref = useAway(menu, () => setMenu(false));
  const { me } = useMe();
  const myName = (me as { name?: string | null } | null)?.name ?? "you";
  const cut = item.status === "cut";
  const decides = !!item.can_decide;
  const decider = deciderWords(item.deciders);
  const cutBy = mkCutBy(item.key);
  const cutWords = `Cut ${calendarDay(cutBy.at)} by ${cutBy.by}`;
  const doCut = async () => {
    setAsk(null);
    if (decides) mkSetCutBy(item.key, myName, new Date().toISOString().slice(0, 10));
    await act(`Cut ${item.title}`, { op: "cut", target: { item_id: item.id }, before: { cut: false }, after: { cut: true } }, { words: () => `Cut ${item.title} from the roadmap` });
  };
  const doRestore = async () => {
    setMenu(false);
    await act(`Restored ${item.title}`, { op: "restore", target: { item_id: item.id }, before: { cut: true }, after: { cut: false } }, { words: () => `Restored ${item.title} to the roadmap` });
  };
  const doDelete = () => {
    setAsk(null);
    if (!decides) return toast({ message: `Proposed: move ${item.title} to Trash · waiting for ${decider}` });
    trashFeature(item, myName, onClose);
  };
  const say = (w: string, p: string) => (decides ? w : p);
  const entries = (
    <div role="menu" className={v === "b" ? MENU.replace("right-0", "left-0").replace("top-9", "top-7") : MENU} data-testid="mk-menu">
      {cut ? (
        <button type="button" role="menuitem" className={ITEM} onClick={() => void doRestore()}>
          {say("Restore to the roadmap", "Propose a restore")}
        </button>
      ) : (
        <button type="button" role="menuitem" className={`${ITEM} text-warn`} onClick={() => (setMenu(false), setAsk("cut"))}>
          {say("Cut from the roadmap", "Propose a cut")}
        </button>
      )}
      <button type="button" role="menuitem" className={`${ITEM} text-crit`} onClick={() => (setMenu(false), setAsk("delete"))}>
        {say("Move to Trash…", "Propose moving to Trash…")}
      </button>
      {!decides && <p className="border-t border-line px-3 pt-1.5 pb-1 text-[13px] text-text2">{decider} decides</p>}
    </div>
  );
  const menuOn = canChange;
  // pm1 a: ⋯ by the close; c: a named Actions button there.
  const headerButton =
    menuOn && (v === "a" || v === "c") ? (
      <span ref={ref} className="relative flex-none">
        {v === "a" ? (
          <button type="button" aria-label={`More for ${item.title}`} aria-haspopup="menu" aria-expanded={menu} className={`${ICON} ${menu ? "border-line-strong bg-surface2" : ""}`} onClick={() => setMenu((o) => !o)}>
            ⋯
          </button>
        ) : (
          <Button aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((o) => !o)}>
            Actions ▾
          </Button>
        )}
        {menu && entries}
      </span>
    ) : null;
  // pm1 b: the status chip is the menu.
  const chip =
    v === "b" && menuOn ? (
      <span ref={ref} className="relative">
        <button type="button" aria-haspopup="menu" aria-expanded={menu} data-testid="fp-status" onClick={() => setMenu((o) => !o)} className={`rounded-full px-2 py-px font-medium ${cut ? "bg-surface2 text-text2 ring-1 ring-line-strong" : "bg-accent-soft text-accent-ink"} hover:brightness-95`}>
          {statusWord(item.status)} ▾
        </button>
        {menu && entries}
      </span>
    ) : cut && v !== "a" ? (
      <span className="rounded-full bg-surface2 px-2 py-px font-medium text-text2 ring-1 ring-line-strong" data-testid="fp-status">
        {statusWord(item.status)}
      </span>
    ) : null;
  // a: a strip under the title with Restore; b, c: the words in the header's line; d: the Status row.
  const strip =
    cut && v === "a" ? (
      <p className="mt-2 flex items-center gap-3 rounded-lg bg-surface2 px-3 py-1.5 text-sm" data-testid="mk-cut-strip">
        <span className="min-w-0 flex-1 text-text2">{cutWords}</span>
        {menuOn && (
          <Button onClick={() => void doRestore()}>{say("Restore", "Propose a restore")}</Button>
        )}
      </p>
    ) : null;
  const metaWords = cut && (v === "b" || v === "c") ? <span data-testid="mk-cut-words">{cutWords}</span> : null;
  const statusRow =
    v === "d" ? (
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>{cut ? cutWords : statusWord(item.status)}</span>
        {menuOn && (
          <>
            {cut ? (
              <button type="button" className="font-medium text-accent-ink underline" onClick={() => void doRestore()}>
                {say("Restore", "Propose a restore")}
              </button>
            ) : (
              <button type="button" className="font-medium text-warn underline" onClick={() => setAsk("cut")}>
                {say("Cut", "Propose a cut")}
              </button>
            )}
            <button type="button" className="font-medium text-crit underline" onClick={() => setAsk("delete")}>
              {say("Move to Trash", "Propose moving to Trash")}
            </button>
          </>
        )}
      </span>
    ) : null;
  const muted = cut && v === "c";
  const linkTitles = (ids: string[]) => ids.map((id) => items.get(id)?.title).filter((t): t is string => !!t);
  const needed = linkTitles(item.needed_by);
  const dependsOn = linkTitles(item.depends_on);
  const dec = decisionsOf(item);
  const rows: [string, ReactNode][] = [
    ["Needed by", needed.length ? <>{andList(needed)} <span className="text-text2">lose this link</span></> : <span className="text-text2">Nothing</span>],
    ["Depends on", dependsOn.length ? andList(dependsOn) : <span className="text-text2">Nothing</span>],
    ["Decisions", dec ? <>{plural(dec, "decision")} <span className="text-text2">name it; they stay</span></> : <span className="text-text2">None name it</span>],
    ["Milestone", item.milestone?.name ?? <span className="text-text2">None</span>],
    ["Goal", item.goal?.title ?? <span className="text-text2">None</span>],
  ];
  const counts = `${plural(needed.length + dependsOn.length, "link")}, ${plural(dec, "decision")}${item.milestone?.name ? ", a milestone" : ""}${item.goal ? " and a goal" : ""} go with it.`;
  useEffect(() => {
    // pm2 d: no confirm; Delete moves it to Trash at once, with Undo.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- pm2 d has no confirm
    if (ask === "delete" && mkParam("pm2", "b") === "d") doDelete();
  });
  const dialog =
    ask === "cut" ? (
      <CutConfirm item={item} items={items} decides={decides} decider={decider} onClose={() => setAsk(null)} onCut={() => void doCut()} />
    ) : ask === "delete" && mkParam("pm2", "b") !== "d" ? (
      <DeleteConfirm kind="feature" title={item.title} rows={rows} counts={counts} dependents={needed} decides={decides} decider={decider} onClose={() => setAsk(null)} onDelete={doDelete} />
    ) : null;
  return { headerButton, chip, strip, metaWords, statusRow, muted, dialog };
}

/** A goal's Delete (Priorities' goal menu), as each pm2 proposal asks it. */
export function GoalDelete({ title, features, measure, onClose }: { title: string; features: string[]; measure: string; onClose: () => void }) {
  const { me, role } = useMe();
  const decides = role === "owner";
  const by = (me as { name?: string | null } | null)?.name ?? "you";
  const done = () => {
    onClose();
    if (!decides) return toast({ message: `Proposed: move ${title} to Trash · waiting for the company's owners` });
    const row: MkTrash = { id: `t-goal-${title}`, kind: "Goal", title, where: "Goals", by, at: new Date().toISOString(), days_left: 30, back: [`Its measure: ${measure}`, `${plural(features.length, "feature")} linked to it again`] };
    mkSaveTrash([row, ...mkTrash().filter((t) => t.id !== row.id)]);
    toast({ message: `Moved ${title} to Trash`, action: { label: "Undo", onClick: () => mkSaveTrash(mkTrash().filter((t) => t.id !== row.id)) } });
  };
  useEffect(() => {
    if (mkParam("pm2", "b") === "d") done();
  });
  if (mkParam("pm2", "b") === "d") return null;
  const rows: [string, ReactNode][] = [
    ["Features", features.length ? <>{andList(features)} <span className="text-text2">stay, under No goal</span></> : <span className="text-text2">None</span>],
    ["Measured by", measure],
  ];
  return <DeleteConfirm kind="goal" title={title} rows={rows} counts={`${plural(features.length, "feature")} ${features.length === 1 ? "loses" : "lose"} this goal and stay on the roadmap.`} dependents={features} decides={decides} decider="the company's owners" onClose={onClose} onDelete={done} />;
}

/** Settings › Trash's features and goals beside documents, as each pm3 proposal lists them. */
export function MkTrashList({ docs, owner, role }: { docs: { kind: string; title: string; by: string; at: string; days_left: number; node: ReactNode }[]; owner: boolean; role: string | null }) {
  const v = mkParam("pm3", "a");
  const [rows, setRows] = useState<MkTrash[]>([]);
  const [tab, setTab] = useState<"All" | "Feature" | "Goal" | "Document">("All");
  // eslint-disable-next-line react-hooks/set-state-in-effect -- the mock's store is read once mounted
  useEffect(() => setRows(mkTrash()), []);
  const approver = role === "approver";
  const restore = (t: MkTrash) => {
    if (!owner) return toast({ message: `Proposed: restore ${t.title} · waiting for the company's owners` });
    mkSaveTrash(mkTrash().filter((x) => x.id !== t.id));
    setRows(mkTrash());
    sendCardChanged();
    toast({ message: `Restored ${t.title}${t.kind === "Feature" ? ` to ${t.where}` : ""}, with ${andList(t.back.map((b) => b.charAt(0).toLowerCase() + b.slice(1)))}` });
  };
  const fmt = formatDateTime;
  const line = (t: MkTrash, chip: boolean) => (
    <li key={t.id} data-testid="mk-trash-entry" className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3 max-[600px]:px-3">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2">
          {chip && <Chip kind={t.kind === "Goal" ? "acc" : "line"}>{t.kind}</Chip>}
          <span className="min-w-0 font-semibold break-words">{t.title}</span>
          {t.kind === "Feature" && <span className="text-sm text-text2">{t.where}</span>}
        </p>
        <p className="mt-1 text-sm text-text2">
          Deleted by {t.by} on {fmt(t.at)}
        </p>
      </div>
      <div className="flex flex-none items-center gap-2">
        <Chip kind={t.days_left <= 3 ? "warn" : "line"}>{plural(t.days_left, "day")} left</Chip>
        <InfoTip label={`What Restore puts back for ${t.title}`}>
          <span className="block">{t.back.map((b) => <span key={b} className="block">{b}</span>)}</span>
        </InfoTip>
        {(owner || approver) && (
          <Button aria-label={`Restore ${t.title}`} onClick={() => restore(t)}>
            {owner ? "Restore" : "Propose a restore"}
          </Button>
        )}
      </div>
    </li>
  );
  // A document's row is the page's own (its kind a chip in pm3 a, drawn there).
  const docLine = (d: (typeof docs)[number], _chip: boolean, i: number) => <Fragment key={`d${i}`}>{d.node}</Fragment>;
  type Any = { at: string; el: (chip: boolean) => ReactNode; kind: string };
  const all: Any[] = [...rows.map((t) => ({ at: t.at, kind: t.kind, el: (chip: boolean) => line(t, chip) })), ...docs.map((d, i) => ({ at: d.at, kind: "Document", el: (chip: boolean) => docLine(d, chip, i) }))].sort((a, b) => (a.at < b.at ? 1 : -1));
  const panel = (title: string, list: Any[], chip: boolean) => (
    <section key={title} className="rounded-xl border border-line bg-surface" data-testid="mk-trash-group">
      <h2 className="flex items-baseline gap-2 border-b border-line px-4 py-2.5 font-semibold">
        {title} <span className="text-sm font-normal text-text2">{list.length}</span>
      </h2>
      {list.length ? <ul className="divide-y divide-line">{list.map((x) => x.el(chip))}</ul> : <p className="px-4 py-3 text-text2">Nothing here.</p>}
    </section>
  );
  if (v === "b")
    return (
      <div className="grid gap-4">
        {panel("Features", all.filter((x) => x.kind === "Feature"), false)}
        {panel("Goals", all.filter((x) => x.kind === "Goal"), false)}
        {docs.length > 0 || owner ? panel("Documents", all.filter((x) => x.kind === "Document"), false) : null}
      </div>
    );
  if (v === "c") {
    const tabs: ("All" | "Feature" | "Goal" | "Document")[] = ["All", "Feature", "Goal", ...(owner ? (["Document"] as const) : [])];
    const shown = tab === "All" ? all : all.filter((x) => x.kind === tab);
    return (
      <div className="grid gap-3">
        <div role="tablist" aria-label="Kind" className="flex flex-wrap gap-1 rounded-lg bg-surface2 p-1 text-sm self-start">
          {tabs.map((t) => (
            <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)} className={`rounded-md px-3 py-1 ${tab === t ? "bg-surface font-medium shadow-sm" : "text-text2"}`}>
              {t === "All" ? "All" : `${t}s`} <span className="text-text2">{t === "All" ? all.length : all.filter((x) => x.kind === t).length}</span>
            </button>
          ))}
        </div>
        {panel(tab === "All" ? "Deleted" : `${tab}s`, shown, tab === "All")}
      </div>
    );
  }
  return panel("Deleted", all, true);
}
