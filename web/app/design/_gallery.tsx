"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import {
  Avatar,
  Bars,
  Button,
  Chip,
  CostFigure,
  DataTable,
  Empty,
  FaviconMark,
  GoalTag,
  Icon,
  InfoTip,
  Inspector,
  InspectorRow,
  InspectorSection,
  JourneyTrack,
  KpiStrip,
  Label,
  LinkButton,
  Mark,
  Meter,
  Notice,
  Numeral,
  PageHeader,
  Panel,
  Ring,
  FilterChips,
  MARK_LABEL,
  ScrollStrip,
  SegmentedControl,
  Sparkline,
  StatusMark,
  ToGo,
  Wordmark,
  type ButtonVariant,
  type Column,
} from "@/components/ds";

import { CHIP_KINDS, FEATURES, ICONS, type SampleFeature } from "./_samples";

const VARIANTS: ButtonVariant[] = ["primary", "secondary", "solid", "ghost", "danger", "hero"];

/** A labelled cell in a panel: the state's name above the sample. */
function State({ name, children, wide = false }: { name: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`flex min-w-0 flex-col gap-2 ${wide ? "basis-full" : ""}`}>
      <Label>{name}</Label>
      <div className="flex min-w-0 flex-wrap items-center gap-2.5">{children}</div>
    </div>
  );
}

/** A dark strip for samples drawn on the Inspector head. */
function HeroStrip({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2.5 rounded-button bg-hero px-3 py-2.5 text-hero-text">{children}</div>;
}

/** The three grounds the mark is drawn on (brand/README.md): fixed colours, not the theme's. */
const BRAND_GROUNDS = [
  { name: "Light", bg: "#f3f6f9", ink: "#0b3a7a", accent: "#0369a1", sky: false },
  { name: "Dark", bg: "#06101e", ink: "#bcd6ee", accent: "#7cc8f8", sky: false },
  { name: "Navy", bg: "linear-gradient(#0b3a7a, #06101e)", ink: "#ffffff", accent: "#7dd3fc", sky: true },
] as const;

/** The Compass mark, its compact cut, the tab icon and the wordmark on each ground. */
function BrandGrounds({ tid }: { tid: string }) {
  return (
    <div className="grid grid-cols-3 gap-3 p-4 max-[900px]:grid-cols-1">
      {BRAND_GROUNDS.map((g) => (
        <div
          key={g.name}
          data-testid={`${tid}-${g.name.toLowerCase()}`}
          className="flex flex-col gap-4 rounded-button border border-line p-4"
          style={{ background: g.bg, color: g.ink }}
        >
          <span className="text-[13px] font-semibold">{g.name}</span>
          <div className="flex items-end gap-5">
            <Mark size={44} tone={g.sky ? "sky" : "current"} label="Full mark, 44 px" />
            <Mark size={22} tone={g.sky ? "sky" : "current"} label="Compact mark, 22 px" />
            <Mark size={16} tone={g.sky ? "sky" : "current"} label="Compact mark, 16 px" />
            <FaviconMark />
          </div>
          <div className="flex items-center gap-3">
            <Mark size={40} tone={g.sky ? "sky" : "current"} />
            <Wordmark className="text-xl" accent={g.accent} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Body({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`flex flex-wrap gap-x-6 gap-y-4 p-4 ${className}`}>{children}</div>;
}

/**
 * A scroll box as tall as the table's header plus its first `rows` rows, measured, so it
 * never cuts a row in half (row heights differ on a phone, where rows stack).
 */
function WholeRows({ rows, testId, children }: { rows: number; testId: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const last = el.querySelectorAll("tr[data-row]")[rows - 1];
      if (!last) return setHeight(undefined);
      const top = el.getBoundingClientRect().top - el.scrollTop;
      setHeight(Math.ceil(last.getBoundingClientRect().bottom - top));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el.firstElementChild ?? el);
    return () => ro.disconnect();
  }, [rows]);
  return (
    <div ref={box} className="overflow-y-auto" style={{ maxHeight: height }} data-testid={testId}>
      {children}
    </div>
  );
}

const columns: Column<SampleFeature>[] = [
  { key: "title", header: "Feature", cell: (f) => <span className="font-medium">{f.title}</span> },
  { key: "goal", header: "Goal", width: "64px", cell: (f) => <GoalTag id={f.goal} proposed={f.proposed} /> },
  {
    key: "status",
    header: "Status",
    width: "120px",
    cell: (f) => (
      <Chip kind={f.status.kind} dot>
        {f.status.label}
      </Chip>
    ),
  },
  { key: "journey", header: "Journey", width: "120px", hideOnPhone: true, cell: (f) => <JourneyTrack current={f.journey} variant="dots" /> },
  { key: "conf", header: "Conf.", width: "64px", align: "center", cell: (f) => <Ring value={f.confidence} size={28} stroke={4} /> },
  { key: "cost", header: "Cost", width: "84px", align: "right", hideOnPhone: true, cell: (f) => <CostFigure usd={f.cost} /> },
];

/**
 * Every part of components/ds in each state. `tid` prefixes the test ids, so the
 * dark copy ("Both") never clashes with the first.
 */
export function Gallery({ tid = "design" }: { tid?: string }) {
  const id = (s: string) => `${tid}-${s}`;
  const [selected, setSelected] = useState<string | null>(FEATURES[0]!.id);
  const [opened, setOpened] = useState<string | null>(null);
  const [seg, setSeg] = useState<"brief" | "full" | "diff">("brief");
  const sel = FEATURES.find((f) => f.id === selected) ?? FEATURES[0]!;

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,340px),1fr))] gap-4" data-testid={id("gallery")}>
      <Panel title="Brand" className="col-span-full" testId={id("brand")}>
        <BrandGrounds tid={id("brand")} />
      </Panel>

      <Panel title="Page header" className="col-span-full" testId={id("page-header")}>
        <div className="px-4">
          <PageHeader
            title="Check-in"
            suffix="v3"
            status={
              <>
                <Chip kind="warn" dot>
                  In review
                </Chip>
                <Chip kind="acc">2 blockers</Chip>
              </>
            }
            action={
              <Button variant="primary" icon="check">
                Approve r4
              </Button>
            }
          />
        </div>
      </Panel>

      <Panel
        title="Data table"
        count={FEATURES.length}
        className="col-span-full"
        tools={
          <Chip kind={opened ? "pass" : "na"} data-testid={id("table-opened")}>
            {opened ? `Opened ${FEATURES.find((f) => f.id === opened)?.title}` : "Enter opens"}
          </Chip>
        }
        testId={id("table-panel")}
      >
        <WholeRows rows={5} testId={id("table-scroll")}>
          <DataTable
            label="Sample features"
            testId={id("table")}
            columns={columns}
            rows={FEATURES}
            rowKey={(f) => f.id}
            selected={selected}
            onSelect={(k) => setSelected(k)}
            onActivate={(k) => setOpened(k)}
          />
        </WholeRows>
      </Panel>

      <Panel title="Grouped rows" className="col-span-full" testId={id("table-grouped")}>
        <DataTable
          label="Sample roadmap"
          columns={columns.filter((c) => c.key !== "cost")}
          rows={FEATURES.slice(0, 6)}
          rowKey={(f) => f.id}
          group={(f) => f.horizon}
        />
      </Panel>

      <Panel title="Empty table" testId={id("table-empty")}>
        <DataTable label="Empty sample" columns={columns.slice(0, 3)} rows={[]} rowKey={(f) => f.id} empty="No features" />
      </Panel>

      <Panel title="Loading table" testId={id("table-loading")}>
        <DataTable label="Loading sample" columns={columns.slice(0, 3)} rows={undefined} rowKey={(f) => f.id} loading />
      </Panel>

      <div className="min-w-0" data-testid={id("inspector")}>
        <Inspector
          eyebrow="Feature · selected"
          title={sel.title}
          chips={
            <>
              <Chip kind="now" hero>
                {sel.horizon}
              </Chip>
              <Chip kind={sel.status.kind} hero>
                {sel.status.label}
              </Chip>
            </>
          }
          action={
            <Button variant="hero" icon="arrow">
              Open
            </Button>
          }
          stats={[
            { label: "Confidence", figure: <Ring value={sel.confidence} size={44} /> },
            { label: "Evidence", value: 14 },
            { label: "Blockers", value: 2, tone: "crit" },
          ]}
        >
          <InspectorSection label="Goal" tools={<GoalTag id={sel.goal} proposed={sel.proposed} />}>
            <div className="flex items-center justify-between gap-3">
              <ToGo amount={5} unit="%" />
              <Sparkline values={[84, 85, 85, 86, 88, 87]} target={92} />
            </div>
          </InspectorSection>
          <InspectorSection label="Journey">
            <JourneyTrack current={sel.journey} variant="bar" />
          </InspectorSection>
          <InspectorSection label="Sources">
            <InspectorRow value={12}>Interviews</InspectorRow>
            <InspectorRow value={1}>Support tickets</InspectorRow>
            <InspectorRow value={<CostFigure usd={sel.cost} />}>Run cost</InspectorRow>
          </InspectorSection>
        </Inspector>
      </div>

      <Panel title="Chips" testId={id("chips")}>
        <Body>
          <State name="Kinds">
            {CHIP_KINDS.map((c) => (
              <Chip key={c.kind} kind={c.kind}>
                {c.label}
              </Chip>
            ))}
          </State>
          <State name="With dot">
            {CHIP_KINDS.map((c) => (
              <Chip key={c.kind} kind={c.kind} dot>
                {c.label}
              </Chip>
            ))}
          </State>
          <State name="Hero" wide>
            <HeroStrip>
              {CHIP_KINDS.map((c) => (
                <Chip key={c.kind} kind={c.kind} hero>
                  {c.label}
                </Chip>
              ))}
            </HeroStrip>
          </State>
        </Body>
      </Panel>

      <Panel title="Goal tags" testId={id("goal-tags")}>
        <Body>
          <State name="Normal">
            <GoalTag id="G1" />
            <GoalTag id="G2" />
            <GoalTag id="G3" />
          </State>
          <State name="Proposed">
            <GoalTag id="G4" proposed />
          </State>
        </Body>
      </Panel>

      <Panel title="Rings" testId={id("rings")}>
        <Body>
          <State name="0 · 34 · 66 · 100 · none">
            {[0, 34, 66, 100, null].map((v) => (
              <Ring key={String(v)} value={v} />
            ))}
          </State>
          <State name="Sizes">
            <Ring value={81} size={28} stroke={4} />
            <Ring value={81} size={56} stroke={6} />
          </State>
          <State name="Hero">
            <HeroStrip>
              <Ring value={81} hero size={56} stroke={6} />
              <Ring value={34} hero />
            </HeroStrip>
          </State>
        </Body>
      </Panel>

      <Panel title="Charts" testId={id("charts")}>
        <Body>
          <State name="Sparkline · target">
            <Sparkline values={[84, 85, 85, 86, 88, 87]} target={92} />
            <Sparkline values={[4.6, 4.4, 4.1, 3.9, 3.4, 3.2]} target={3} width={160} />
          </State>
          <State name="Meter" wide>
            <div className="flex w-full flex-col gap-2">
              <Meter value={6} max={9} label="Tracks on plan" />
              <Meter value={0} max={4} label="Checks passed" />
              <Meter value={12} max={12} label="Sections" showMax={false} />
            </div>
          </State>
          <State name="Bars">
            <Bars values={[3, 5, 4, 7, 6, 8, 5, 9]} label="Requests per week" />
          </State>
        </Body>
      </Panel>

      <Panel title="Journey" className="col-span-full" testId={id("journey")}>
        <Body className="flex-col">
          <State name="Pill · 1 · 5 · 9" wide>
            <div className="flex w-full min-w-0 flex-col gap-2">
              <JourneyTrack current={1} />
              <JourneyTrack current={5} />
              <JourneyTrack current={9} />
            </div>
          </State>
          <State name="Bar · 3 · 8" wide>
            <div className="grid w-full grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-4">
              <JourneyTrack current={3} variant="bar" />
              <JourneyTrack current={8} variant="bar" />
            </div>
          </State>
          <State name="Dots · 2 · 6 · 9">
            <JourneyTrack current={2} variant="dots" />
            <JourneyTrack current={6} variant="dots" />
            <JourneyTrack current={9} variant="dots" />
          </State>
        </Body>
      </Panel>

      <Panel title="Segmented" testId={id("segmented")}>
        <Body>
          <State name="Buttons">
            <SegmentedControl
              label="Sample view"
              value={seg}
              onChange={setSeg}
              items={[
                { value: "brief", label: "Brief" },
                { value: "full", label: "Full", count: 8 },
                { value: "diff", label: "Diff", disabled: true },
              ]}
            />
          </State>
          <State name="Small">
            <SegmentedControl
              label="Sample version"
              size="sm"
              value="v2"
              items={[
                { value: "v1", label: "v1" },
                { value: "v2", label: "v2" },
                { value: "v3", label: "v3" },
              ]}
            />
          </State>
          <State name="Links">
            <SegmentedControl
              label="Sample routes"
              value="members"
              items={[
                { value: "members", label: "Members", href: "/design#members" },
                { value: "sources", label: "Sources", href: "/design#sources", count: 4 },
              ]}
            />
          </State>
        </Body>
      </Panel>

      <Panel title="Scroll strip" testId={id("scroll-strip")}>
        <Body className="flex-col">
          <ScrollStrip className="w-full rounded-lg border border-line" stripClassName="gap-1 p-1">
            {["Summary", "Goal trace", "Problem", "Users and jobs", "Scope", "Proposed flow", "Risks", "Metrics"].map((t) => (
              <span key={t} className="flex h-8 flex-none items-center rounded-lg px-2.5 text-sm font-medium whitespace-nowrap">
                {t}
              </span>
            ))}
          </ScrollStrip>
        </Body>
      </Panel>

      <Panel title="Status marks" testId={id("status-marks")}>
        <Body>
          {(["approved", "changes_requested", "rejected", "none", "locked"] as const).map((m) => (
            <State key={m} name={MARK_LABEL[m]}>
              <StatusMark state={m} size={20} />
            </State>
          ))}
        </Body>
      </Panel>

      <Panel title="Filter chips" testId={id("filter-chips")}>
        <Body>
          <FilterChips
            label="Show sections"
            value="review"
            onChange={() => {}}
            items={[
              { value: "all", label: "All", count: 104 },
              { value: "review", label: "To review", count: 91 },
              { value: "feedback", label: "Feedback", count: 9 },
            ]}
          />
        </Body>
      </Panel>

      <Panel title="Info tip" testId={id("infotips")}>
        <Body>
          <State name="Closed">
            <span className="inline-flex items-center gap-1.5 font-semibold" data-testid={id("infotip")}>
              Confidence
              <InfoTip label="confidence" side="bottom" align="start">
                How sure the Oracle is, from 0 to 100, given the evidence it traced.
              </InfoTip>
            </span>
          </State>
          <State name="Open">
            {/* A static copy of the open state, drawn with the tip's own tokens. */}
            <span className="inline-flex flex-col items-start gap-2.5" aria-hidden>
              <span className="grid size-5 place-items-center rounded-full border-[1.5px] border-accent bg-accent font-serif text-[13px] leading-none font-bold text-on-accent italic">
                i
              </span>
              <span className="max-w-[260px] rounded-button bg-tip px-3.5 py-2.5 text-sm leading-5 text-tip-text shadow-tip">
                Deposits held at booking, refunded at check-in.
              </span>
            </span>
          </State>
          <State name="Hero">
            <HeroStrip>
              <span className="text-[13px] font-semibold text-hero-text2">Run cost</span>
              <InfoTip label="run cost" hero side="bottom" align="start">
                Spent so far against the estimate.
              </InfoTip>
            </HeroStrip>
          </State>
        </Body>
      </Panel>

      <div className="col-span-full min-w-0" data-testid={id("kpis")}>
        <KpiStrip
          label="Sample counts"
          items={[
            { label: "Goals", value: 3, of: 4 },
            { label: "Evidence", value: 86 },
            {
              label: "Conflicts",
              value: 2,
              tone: "crit",
              extra: (
                <InfoTip label="conflicts" side="bottom" align="start">
                  Two sources disagree.
                </InfoTip>
              ),
            },
            { label: "Flagged", value: 1, tone: "warn" },
          ]}
        />
      </div>

      <Panel title="Avatars" testId={id("avatars")}>
        <Body>
          <State name="Default">
            <Avatar name="Rosa Lind" />
            <Avatar name="front.desk@example.com" size={32} />
            <Avatar name="Tomas Weir" size={38} />
          </State>
          <State name="Oracle">
            <Avatar name="Oracle" initials="O" tone="oracle" />
          </State>
          <State name="Me">
            <Avatar name="admin@example.com" tone="me" size={32} />
          </State>
        </Body>
      </Panel>

      <Panel title="Cost" testId={id("cost")}>
        <Body>
          <State name="Small">
            <CostFigure usd={18.4} />
            <CostFigure usd={18.4} of={22} />
            <CostFigure usd={null} />
          </State>
          <State name="Estimate">
            <CostFigure usd={64} est />
          </State>
          <State name="Hero">
            <HeroStrip>
              <CostFigure usd={18.4} of={22} est hero />
            </HeroStrip>
          </State>
          <State name="Approval">
            <CostFigure usd={64} est prominent />
          </State>
          <State name="Overrun">
            <CostFigure usd={27.6} of={18} prominent />
          </State>
        </Body>
      </Panel>

      <Panel title="Buttons" className="col-span-full" testId={id("buttons")}>
        <Body className="flex-col">
          {VARIANTS.map((v) => {
            const row = (
              <>
                <Button variant={v} icon="plus">
                  {v}
                </Button>
                <Button variant={v}>No icon</Button>
                <Button variant={v} icon="plus" disabled>
                  Disabled
                </Button>
                <LinkButton variant={v} href="/design#buttons" icon="arrow">
                  Link
                </LinkButton>
              </>
            );
            return (
              <State key={v} name={v[0]!.toUpperCase() + v.slice(1)} wide>
                {v === "hero" ? <HeroStrip>{row}</HeroStrip> : row}
              </State>
            );
          })}
        </Body>
      </Panel>

      <Panel title="Numerals" testId={id("numerals")}>
        <Body>
          <State name="Sizes">
            <Numeral value={7} size="sm" />
            <Numeral value={41} />
            <Numeral value={86} size="lg" />
          </State>
          <State name="Of · unit">
            <Numeral value={6} of={9} />
            <Numeral value={3.2} unit=" min" />
          </State>
          <State name="Tones">
            <Numeral value={2} tone="crit" />
            <Numeral value={1} tone="warn" />
          </State>
        </Body>
      </Panel>

      <Panel title="To go" testId={id("to-go")}>
        <Body className="flex-col">
          <State name="Points">
            <ToGo amount={5} unit="%" />
          </State>
          <State name="Minutes">
            <ToGo amount={1.6} unit="min" />
          </State>
          <State name="Count">
            <ToGo amount={164} />
          </State>
          <State name="At target">
            <ToGo amount={0} unit="%" />
          </State>
        </Body>
      </Panel>

      <Panel
        title="Panels"
        count={3}
        tools={
          <>
            <Chip kind="acc">Tools</Chip>
            <Button icon="search">Find</Button>
          </>
        }
        testId={id("panels")}
      >
        <Body className="flex-col">
          <State name="No head" wide>
            <Panel className="w-full">
              <p className="p-4">Body only</p>
            </Panel>
          </State>
          <State name="Empty" wide>
            <Panel title="Requests" className="w-full">
              <Empty>No requests</Empty>
            </Panel>
          </State>
        </Body>
      </Panel>

      <Panel title="Notices" testId={id("notices")}>
        <Body className="flex-col">
          <Notice>Saved r4</Notice>
          <Notice tone="pass">Published v3</Notice>
          <Notice tone="error">Deposit sync failed</Notice>
        </Body>
      </Panel>

      <Panel title="Icons" count={ICONS.length} className="col-span-full" testId={id("icons")}>
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-1 p-3">
          {ICONS.map((n) => (
            <li key={n} className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-text2">
              <span className="text-text">
                <Icon name={n} />
              </span>
              <span className="min-w-0 font-mono text-[13px] break-all">{n}</span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
