/**
 * H11 Autonomy in the mock: the registry (the API's oracle/autonomy.py, as GET /v1/autonomy
 * gives it with nothing stored), the owner's levels with their validation, and the
 * "Oracle did" rows of the Inbox. Roles are checked here, as in the API: everyone reads,
 * owners change a level; only the people an action notified see, open or undo it.
 */
import type { Schemas } from "@/lib/api/client";

type Item = Schemas["AutonomyItem"];
type Level = Item["level"];
type Role = Schemas["Me"]["role"];
type Limits = Record<string, unknown>;
type RegistryRow = Omit<Item, "level" | "limits" | "limits_summary"> & { limits_default: Limits | null };
type Stored = { level: Level; limits?: Limits };

export type OracleActionRow = Omit<Schemas["InboxOracleAction"], "state" | "counts"> & {
  notify_ids: string[];
  opened_by: string[];
  undone_by: string | null;
};

export interface AutonomyDb {
  stored: Record<string, Stored>;
  updated_by: string | null;
  updated_at: string | null;
  actions: OracleActionRow[];
}

const ORDER: Level[] = ["observe", "draft", "recommend", "act"];
const LEVEL_TITLES: Record<Level, string> = { observe: "Observe", draft: "Draft", recommend: "Recommend", act: "Act within limits" };
const STAYS_WITH_PEOPLE = [
  "Hiring, coaching and performance",
  "Pricing",
  "Hard-to-reverse decisions",
  "Date commitments",
  "What is said to the board and investors",
  "The vision itself",
];

const usd = (n: number) => `$${n}`;
const places = (n: number) => (n === 1 ? "1 place" : `${n} places`);
/* eslint-disable @typescript-eslint/no-explicit-any */
const SUMMARIES: Record<string, (l: any) => string> = {
  baseline: () => "unlocked entries only",
  next_drafts: (l) => `once ${l.min_staged} changes wait`,
  requests: (l) => `at ${Math.round(l.min_confidence * 100)}% confidence or more`,
  questions: (l) => `up to ${l.max_per_person_per_week} a person a week`,
  priorities: (l) => `within one goal, up to ${places(l.max_rank_move)}`,
  decisions: (l) => `reversible only, from ${l.origins.join(" and ")}, up to ${usd(l.max_cost_usd)}`,
  rituals: (l) => `up to ${usd(l.max_run_usd)} a run`,
  outcomes: () => "only actuals read from data",
  launches: () => "internal only",
};
/* eslint-enable @typescript-eslint/no-explicit-any */

const REGISTRY: RegistryRow[] = [
  {
    "key": "baseline",
    "title": "Keep the baseline current",
    "group": "knowledge",
    "group_title": "Knowledge",
    "default": "act",
    "ceiling": "act",
    "allowed": [
      "observe",
      "draft",
      "recommend",
      "act"
    ],
    "levels": {
      "observe": "Oracle reads what runs find and writes nothing to the baseline.",
      "draft": "Agents write every change as a proposal for a person to edit and accept.",
      "recommend": "Agents propose every change; a person accepts each one.",
      "act": "Agents write unlocked entries directly; locked ones become proposals."
    },
    "ceiling_reason": null,
    "limits_schema": {
      "additionalProperties": false,
      "properties": {
        "unlocked_only": {
          "const": true,
          "default": true,
          "fixed": true,
          "title": "Unlocked entries only",
          "type": "boolean"
        }
      },
      "title": "BaselineLimits",
      "type": "object"
    },
    "fixed_limits": [
      "unlocked_only"
    ],
    "wired": true,
    "wired_by": "H11",
    "wired_by_name": "H11 Autonomy",
    "limits_default": {
      "unlocked_only": true
    }
  },
  {
    "key": "feedback_triage",
    "title": "Triage review feedback",
    "group": "documents",
    "group_title": "Documents",
    "default": "recommend",
    "ceiling": "recommend",
    "allowed": [
      "observe",
      "draft",
      "recommend"
    ],
    "levels": {
      "observe": "Oracle runs no review jobs; feedback waits for a person.",
      "draft": "Oracle drafts suggestions on new feedback for an approver to edit and own.",
      "recommend": "Oracle classifies new feedback, suggests changes and pushes back once; a person accepts."
    },
    "ceiling_reason": "a person accepts each suggestion until Oracle can act here",
    "limits_schema": null,
    "fixed_limits": [],
    "wired": true,
    "wired_by": "H11",
    "wired_by_name": "H11 Autonomy",
    "limits_default": null
  },
  {
    "key": "next_drafts",
    "title": "Build next drafts",
    "group": "documents",
    "group_title": "Documents",
    "default": "draft",
    "ceiling": "act",
    "allowed": [
      "observe",
      "draft",
      "recommend",
      "act"
    ],
    "levels": {
      "observe": "Oracle counts staged changes and builds nothing.",
      "draft": "Oracle builds the next draft when an approver clicks Build next draft.",
      "recommend": "Oracle says when staged changes are worth a draft; an approver builds it.",
      "act": "Oracle builds the next draft once enough changes wait, and never approves it."
    },
    "ceiling_reason": null,
    "limits_schema": {
      "additionalProperties": false,
      "properties": {
        "min_staged": {
          "default": 5,
          "maximum": 20,
          "minimum": 3,
          "title": "Staged changes before a draft",
          "type": "integer"
        }
      },
      "title": "NextDraftsLimits",
      "type": "object"
    },
    "fixed_limits": [],
    "wired": true,
    "wired_by": "D12",
    "wired_by_name": "D12 One Build next draft",
    "limits_default": {
      "min_staged": 5
    }
  },
  {
    "key": "requests",
    "title": "Triage requests",
    "group": "knowledge",
    "group_title": "Knowledge",
    "default": "recommend",
    "ceiling": "act",
    "allowed": [
      "observe",
      "draft",
      "recommend",
      "act"
    ],
    "levels": {
      "observe": "Oracle records and indexes requests. Oracle never says no on its own.",
      "draft": "Oracle drafts a summary of each request for its owner to edit. Oracle never says no on its own.",
      "recommend": "Oracle suggests duplicates, goals and when to say no for each request; a person decides. Oracle never says no on its own.",
      "act": "Oracle merges duplicates and links requests to goals at or above your confidence, then tells the owner. Oracle never says no on its own."
    },
    "ceiling_reason": null,
    "limits_schema": {
      "additionalProperties": false,
      "properties": {
        "min_confidence": {
          "default": 0.9,
          "maximum": 1.0,
          "minimum": 0.8,
          "title": "Lowest confidence",
          "type": "number"
        }
      },
      "title": "RequestsLimits",
      "type": "object"
    },
    "fixed_limits": [],
    "wired": true,
    "wired_by": "C1",
    "wired_by_name": "C1 Requests API and screen",
    "limits_default": {
      "min_confidence": 0.9
    }
  },
  {
    "key": "questions",
    "title": "Ask people questions",
    "group": "knowledge",
    "group_title": "Knowledge",
    "default": "recommend",
    "ceiling": "act",
    "allowed": [
      "observe",
      "draft",
      "recommend",
      "act"
    ],
    "levels": {
      "observe": "Oracle notes what it does not know and asks no one.",
      "draft": "Oracle drafts questions for a named person to edit and send.",
      "recommend": "Oracle proposes the next questions and who to ask; a person asks each batch.",
      "act": "Oracle asks the next batch to named people on its own, within your weekly cap."
    },
    "ceiling_reason": null,
    "limits_schema": {
      "additionalProperties": false,
      "properties": {
        "max_per_person_per_week": {
          "default": 5,
          "maximum": 20,
          "minimum": 1,
          "title": "Questions a person a week",
          "type": "integer"
        }
      },
      "title": "QuestionsLimits",
      "type": "object"
    },
    "fixed_limits": [],
    "wired": true,
    "wired_by": "C2",
    "wired_by_name": "C2 Questions to people",
    "limits_default": {
      "max_per_person_per_week": 5
    }
  },
  {
    "key": "goals",
    "title": "Shape goals",
    "group": "knowledge",
    "group_title": "Knowledge",
    "default": "recommend",
    "ceiling": "recommend",
    "allowed": [
      "observe",
      "draft",
      "recommend"
    ],
    "levels": {
      "observe": "Oracle tracks goals and flags gaps.",
      "draft": "Oracle drafts goals for a named person to edit and own.",
      "recommend": "Oracle proposes goals with evidence and a default; a person confirms them."
    },
    "ceiling_reason": "the company's goals are set by people",
    "limits_schema": null,
    "fixed_limits": [],
    "wired": true,
    "wired_by": "B6",
    "wired_by_name": "B6 Goals interview",
    "limits_default": null
  },
  {
    "key": "priorities",
    "title": "Order priorities",
    "group": "planning",
    "group_title": "Planning",
    "default": "recommend",
    "ceiling": "act",
    "allowed": [
      "observe",
      "draft",
      "recommend",
      "act"
    ],
    "levels": {
      "observe": "Oracle scores priorities and changes no order.",
      "draft": "Oracle drafts an order for a named person to edit.",
      "recommend": "Oracle proposes an order; a person saves it.",
      "act": "Oracle reorders within one goal, by at most your limit, and tells the owner."
    },
    "ceiling_reason": null,
    "limits_schema": {
      "additionalProperties": false,
      "properties": {
        "within_goal": {
          "const": true,
          "default": true,
          "fixed": true,
          "title": "Within one goal",
          "type": "boolean"
        },
        "max_rank_move": {
          "default": 3,
          "maximum": 5,
          "minimum": 1,
          "title": "Most places moved",
          "type": "integer"
        }
      },
      "title": "PrioritiesLimits",
      "type": "object"
    },
    "fixed_limits": [
      "within_goal"
    ],
    "wired": false,
    "wired_by": "C9",
    "wired_by_name": "C9 Priorities move and pin",
    "limits_default": {
      "within_goal": true,
      "max_rank_move": 3
    }
  },
  {
    "key": "roadmap_watch",
    "title": "Watch the roadmap",
    "group": "planning",
    "group_title": "Planning",
    "default": "observe",
    "ceiling": "recommend",
    "allowed": [
      "observe",
      "draft",
      "recommend"
    ],
    "levels": {
      "observe": "Oracle watches tracks every hour and flags drift.",
      "draft": "Oracle drafts a track update for its owner to edit.",
      "recommend": "Oracle proposes date and scope changes with evidence; a person decides."
    },
    "ceiling_reason": "date commitments",
    "limits_schema": null,
    "fixed_limits": [],
    "wired": false,
    "wired_by": "F2",
    "wired_by_name": "F2 Track health, drift and date slips",
    "limits_default": null
  },
  {
    "key": "decisions",
    "title": "Decide reversible calls",
    "group": "operating",
    "group_title": "Operating",
    "default": "recommend",
    "ceiling": "act",
    "allowed": [
      "observe",
      "draft",
      "recommend",
      "act"
    ],
    "levels": {
      "observe": "Oracle records decisions and their reasons.",
      "draft": "Oracle drafts a decision record for the approver to edit.",
      "recommend": "Oracle gives options with evidence, a default and the cost of being wrong; the approver decides.",
      "act": "Oracle decides reversible calls of the listed origins within your cost limit, then tells the approver."
    },
    "ceiling_reason": null,
    "limits_schema": {
      "additionalProperties": false,
      "properties": {
        "reversible_only": {
          "const": true,
          "default": true,
          "fixed": true,
          "title": "Reversible decisions only",
          "type": "boolean"
        },
        "origins": {
          "items": {
            "enum": [
              "manual",
              "oracle"
            ],
            "type": "string"
          },
          "minItems": 1,
          "title": "Origins",
          "type": "array"
        },
        "max_cost_usd": {
          "default": 0,
          "maximum": 50,
          "minimum": 0,
          "title": "Highest cost (USD)",
          "type": "number"
        }
      },
      "title": "DecisionsLimits",
      "type": "object"
    },
    "fixed_limits": [
      "reversible_only"
    ],
    "wired": false,
    "wired_by": "H1",
    "wired_by_name": "H1 Decision log",
    "limits_default": {
      "reversible_only": true,
      "origins": [
        "manual",
        "oracle"
      ],
      "max_cost_usd": 0
    }
  },
  {
    "key": "rituals",
    "title": "Run rituals",
    "group": "operating",
    "group_title": "Operating",
    "default": "draft",
    "ceiling": "act",
    "allowed": [
      "observe",
      "draft",
      "recommend",
      "act"
    ],
    "levels": {
      "observe": "Oracle notes when rituals are due.",
      "draft": "Oracle drafts each ritual's pre-read for its owner to edit.",
      "recommend": "Oracle proposes when to start a ritual's preparation; a person starts it.",
      "act": "Oracle starts a ritual's preparation runs within your cost limit, then tells the owner."
    },
    "ceiling_reason": null,
    "limits_schema": {
      "additionalProperties": false,
      "properties": {
        "max_run_usd": {
          "default": 10,
          "maximum": 50,
          "minimum": 0,
          "title": "Highest cost a run (USD)",
          "type": "number"
        }
      },
      "title": "RitualsLimits",
      "type": "object"
    },
    "fixed_limits": [],
    "wired": true,
    "wired_by": "H2",
    "wired_by_name": "H2 Cadence engine",
    "limits_default": {
      "max_run_usd": 10
    }
  },
  {
    "key": "outcomes",
    "title": "Check outcomes",
    "group": "operating",
    "group_title": "Operating",
    "default": "recommend",
    "ceiling": "act",
    "allowed": [
      "observe",
      "draft",
      "recommend",
      "act"
    ],
    "levels": {
      "observe": "Oracle records predicted and actual results.",
      "draft": "Oracle drafts an outcome review for its owner to edit.",
      "recommend": "Oracle proposes a verdict with evidence; a person records it.",
      "act": "Oracle records the verdict when the actual was read from data, then tells the owner."
    },
    "ceiling_reason": null,
    "limits_schema": {
      "additionalProperties": false,
      "properties": {
        "only_parsed_actuals": {
          "const": true,
          "default": true,
          "fixed": true,
          "title": "Only actuals read from data",
          "type": "boolean"
        }
      },
      "title": "OutcomesLimits",
      "type": "object"
    },
    "fixed_limits": [
      "only_parsed_actuals"
    ],
    "wired": false,
    "wired_by": "H3",
    "wired_by_name": "H3 Predicted versus actual",
    "limits_default": {
      "only_parsed_actuals": true
    }
  },
  {
    "key": "launches",
    "title": "Internal launch work",
    "group": "operating",
    "group_title": "Operating",
    "default": "draft",
    "ceiling": "act",
    "allowed": [
      "observe",
      "draft",
      "recommend",
      "act"
    ],
    "levels": {
      "observe": "Oracle notes what shipped.",
      "draft": "Oracle drafts internal changelog entries for a named person to publish.",
      "recommend": "Oracle proposes the entries and who to tell; a person publishes them.",
      "act": "Oracle publishes internal changelog entries and tells member requesters on launch."
    },
    "ceiling_reason": null,
    "limits_schema": {
      "additionalProperties": false,
      "properties": {
        "internal_only": {
          "const": true,
          "default": true,
          "fixed": true,
          "title": "Internal only",
          "type": "boolean"
        }
      },
      "title": "LaunchesLimits",
      "type": "object"
    },
    "fixed_limits": [
      "internal_only"
    ],
    "wired": true,
    "wired_by": "H6",
    "wired_by_name": "H6 Launches and changelog",
    "limits_default": {
      "internal_only": true
    }
  },
  {
    "key": "strategy",
    "title": "Shape product strategy",
    "group": "planning",
    "group_title": "Planning",
    "default": "recommend",
    "ceiling": "recommend",
    "allowed": [
      "observe",
      "draft",
      "recommend"
    ],
    "levels": {
      "observe": "Oracle tracks what strategy rests on and flags conflicts.",
      "draft": "Oracle drafts strategy for a named person to edit and own.",
      "recommend": "Oracle proposes strategic choices with evidence and a default; a person decides."
    },
    "ceiling_reason": "strategy is a person's call",
    "limits_schema": null,
    "fixed_limits": [],
    "wired": false,
    "wired_by": "H4",
    "wired_by_name": "H4 Strategy and vision",
    "limits_default": null
  },
  {
    "key": "vision",
    "title": "Draft the vision",
    "group": "planning",
    "group_title": "Planning",
    "default": "draft",
    "ceiling": "draft",
    "allowed": [
      "observe",
      "draft"
    ],
    "levels": {
      "observe": "Oracle notes where work strays from the vision.",
      "draft": "Oracle drafts vision text for a named person to edit and own."
    },
    "ceiling_reason": "the vision itself",
    "limits_schema": null,
    "fixed_limits": [],
    "wired": false,
    "wired_by": "H4",
    "wired_by_name": "H4 Strategy and vision",
    "limits_default": null
  },
  {
    "key": "external_messages",
    "title": "Words for people outside",
    "group": "outside",
    "group_title": "Outside the company",
    "default": "draft",
    "ceiling": "draft",
    "allowed": [
      "observe",
      "draft"
    ],
    "levels": {
      "observe": "Oracle notes what people outside may need to hear.",
      "draft": "Oracle drafts release notes, customer notes, why-not replies to people who asked, the public changelog and board and investor updates for a named person to edit and send."
    },
    "ceiling_reason": "what is said to people outside the company",
    "limits_schema": null,
    "fixed_limits": [],
    "wired": false,
    "wired_by": "H6",
    "wired_by_name": "H6 Launches and changelog",
    "limits_default": null
  },
  {
    "key": "market",
    "title": "Watch the market",
    "group": "planning",
    "group_title": "Planning",
    "default": "recommend",
    "ceiling": "recommend",
    "allowed": [
      "observe",
      "draft",
      "recommend"
    ],
    "levels": {
      "observe": "Oracle reads the pages you watch and lists what changed.",
      "draft": "Oracle also searches the web each month and writes the digest for a named person to edit.",
      "recommend": "Oracle also suggests positioning changes with evidence; a person accepts each."
    },
    "ceiling_reason": "the category and positioning bet stay with people",
    "limits_schema": null,
    "fixed_limits": [],
    "wired": true,
    "wired_by": "H7",
    "wired_by_name": "H7 Competitive digest",
    "limits_default": null
  }
] as RegistryRow[];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const rank = (l: Level) => ORDER.indexOf(l);
const now = () => new Date().toISOString();

export function emptyAutonomy(): AutonomyDb {
  return { stored: {}, updated_by: null, updated_at: null, actions: [] };
}

function levelOf(r: RegistryRow, s: Stored | undefined): Level {
  if (!s || !ORDER.includes(s.level)) return r.default;
  return rank(s.level) <= rank(r.ceiling) ? s.level : r.ceiling;
}

/** A responsibility's level as Oracle follows it now (its default with nothing stored). */
export function levelFor(db: AutonomyDb, key: string): Level {
  const r = REGISTRY.find((x) => x.key === key);
  if (!r) throw new Error(`no responsibility ${key}`);
  return levelOf(r, db.stored[key]);
}

function itemOut(r: RegistryRow, s: Stored | undefined): Item {
  const { limits_default, ...rest } = r;
  const limits = limits_default ? { ...limits_default, ...Object.fromEntries(Object.entries(s?.limits ?? {}).filter(([k]) => !r.fixed_limits.includes(k))) } : null;
  return { ...rest, level: levelOf(r, s), limits, limits_summary: limits ? SUMMARIES[r.key](limits) : null };
}

type Prop = { title?: string; type?: string; minimum?: number; maximum?: number; minItems?: number; items?: { enum?: string[] } };

/** The API's checks: the ceiling, unknown and fixed limits, each limit's range. */
function validate(r: RegistryRow, level: Level, limits: Limits | null | undefined, before: Stored | undefined): Stored | string {
  if (!ORDER.includes(level)) return `level must be one of ${ORDER.join(", ")}`;
  if (rank(level) > rank(r.ceiling)) return `${LEVEL_TITLES[r.ceiling]} is the highest level for ${r.title}`;
  const kept: Limits = { ...(before?.limits ?? {}) };
  if (limits && Object.keys(limits).length) {
    if (!r.limits_default) return `${r.title} has no limits`;
    const props = (r.limits_schema?.properties ?? {}) as Record<string, Prop>;
    for (const [k, v] of Object.entries(limits)) {
      if (!(k in props)) return `${k}: Extra inputs are not permitted`;
      if (r.fixed_limits.includes(k)) {
        if (v !== r.limits_default[k]) return `This limit is fixed: ${k}`;
        continue;
      }
      const p = props[k];
      if (p.type === "array") {
        if (!Array.isArray(v) || v.length < (p.minItems ?? 0) || v.some((x) => !p.items?.enum?.includes(x))) return `${k}: not a valid choice`;
      } else {
        if (typeof v !== "number" || Number.isNaN(v)) return `${k}: Input should be a valid number`;
        if (p.type === "integer" && !Number.isInteger(v)) return `${k}: Input should be a valid integer`;
        if (p.minimum != null && v < p.minimum) return `${k}: Input should be greater than or equal to ${p.minimum}`;
        if (p.maximum != null && v > p.maximum) return `${k}: Input should be less than or equal to ${p.maximum}`;
      }
      kept[k] = v;
    }
  }
  return Object.keys(kept).length ? { level, limits: kept } : { level };
}

function actionOut(a: OracleActionRow, me: string): Schemas["InboxOracleAction"] {
  const { notify_ids, opened_by, undone_by, ...rest } = a;
  void notify_ids;
  void undone_by;
  const done = opened_by.includes(me) || !!a.undone_at;
  return { ...rest, state: done ? "done" : "open", counts: !done };
}

/** The "Oracle did" rows of `me`, newest first. */
export function inboxActions(db: AutonomyDb, me: string): Schemas["InboxOracleAction"][] {
  return db.actions
    .filter((a) => a.notify_ids.includes(me))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((a) => actionOut(a, me));
}

/** The "oracle-did" scenario: Oracle moved a priority within its goal and told the owner. */
export function seedOracleDid(ownerId: string, id: string, summary = "Moved 'Saved addresses' up 2 within Raise activation"): OracleActionRow {
  return {
    id,
    responsibility: "priorities",
    responsibility_title: "Order priorities",
    summary,
    subject: { kind: "feature", key: "saved-addresses", href: "/priorities" },
    undo: { method: "POST", path: "/v1/priorities/moves/undo", body: { feature: "saved-addresses" } },
    created_at: new Date(Date.now() - 20 * 60_000).toISOString(),
    undone_at: null,
    notify_ids: [ownerId],
    opened_by: [],
    undone_by: null,
  };
}

/** The "oracle-did-launch-ritual" scenario: at Act within limits, Oracle published a launch's
 * internal entries and told its member requester (as the API's launches.service does). */
export function seedLaunchDid(ownerId: string, id: string, launch: { id: string; title: string }): OracleActionRow {
  return {
    id,
    responsibility: "launches",
    responsibility_title: "Internal launch work",
    summary: `${launch.title} launched: Oracle published 1 internal changelog entry and told 1 member requester`,
    subject: { kind: "launch", key: launch.id, href: `/roadmap/launches?launch=${launch.id}` },
    undo: null,
    created_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    undone_at: null,
    notify_ids: [ownerId],
    opened_by: [],
    undone_by: null,
  };
}

/** The same scenario: at Act within limits, Oracle started the summary of a ritual's pre-read
 * (as the API's rituals.summaries does). No Undo: the mock has no run of it to cancel. */
export function seedRitualDid(ownerId: string, id: string, ritual: { id: string; title: string }, occurrenceId: string): OracleActionRow {
  return {
    id,
    responsibility: "rituals",
    responsibility_title: "Run rituals",
    summary: `Started a summary of the pre-read for '${ritual.title}' ($3.00, within your limit)`,
    subject: { kind: "ritual", key: ritual.id, href: `/company/rituals/${occurrenceId}` },
    undo: null,
    created_at: new Date(Date.now() - 25 * 60_000).toISOString(),
    undone_at: null,
    notify_ids: [ownerId],
    opened_by: [],
    undone_by: null,
  };
}

/** The "oracle-did-request" scenario: at Act within limits, Oracle merged a request into the
 * one it repeats and told the triage run's starter (as the API's requests.triage does), with
 * Undo reopening it. */
export function seedRequestDid(
  ownerId: string,
  id: string,
  request: { id: string; title: string; lock_version: number },
  into: { title: string },
): OracleActionRow {
  return {
    id,
    responsibility: "requests",
    responsibility_title: "Triage requests",
    summary: `Merged “${request.title}” into “${into.title}” (95% sure)`,
    subject: { kind: "request", key: request.id, href: `/requests?request=${request.id}` },
    undo: { method: "POST", path: `/v1/requests/${request.id}/reopen`, body: { lock_version: request.lock_version } },
    created_at: new Date(Date.now() - 15 * 60_000).toISOString(),
    undone_at: null,
    notify_ids: [ownerId],
    opened_by: [],
    undone_by: null,
  };
}

export async function routeAutonomy(db: AutonomyDb, req: Request, p: string[], me: { id: string; role: Role }): Promise<Response | null> {
  const m = req.method;
  if (p[1] === "autonomy") {
    if (p.length === 2 && m === "GET") {
      const any = Object.keys(db.stored).length > 0;
      const out: Schemas["AutonomyOut"] = {
        items: REGISTRY.map((r) => itemOut(r, db.stored[r.key])),
        stays_with_people: STAYS_WITH_PEOPLE,
        updated_by: any ? db.updated_by : null,
        updated_at: any ? db.updated_at : null,
      };
      return json(200, out);
    }
    if (p.length === 3 && m === "PUT") {
      const r = REGISTRY.find((x) => x.key === p[2]);
      if (!r) return json(404, { detail: `Unknown responsibility '${p[2]}'` });
      if (me.role !== "owner") return json(403, { detail: "Requires the owner role" });
      const body = JSON.parse((await req.text()) || "null") as Schemas["AutonomyIn"];
      if (!body?.reason?.trim()) return json(422, { detail: "Say why" });
      const next = validate(r, body.level, body.limits, db.stored[r.key]);
      if (typeof next === "string") return json(422, { detail: next });
      db.stored[r.key] = next;
      db.updated_by = me.id;
      db.updated_at = now();
      return json(200, itemOut(r, next));
    }
    return null;
  }
  if (p[1] === "oracle-actions" && p[2] && m === "POST") {
    const a = db.actions.find((x) => x.id === p[2]);
    if (!a || !a.notify_ids.includes(me.id)) return json(404, { detail: "Not found" });
    if (p[3] === "open") {
      if (!a.opened_by.includes(me.id)) a.opened_by.push(me.id);
      return json(200, actionOut(a, me.id));
    }
    if (p[3] === "undo") {
      if (!a.undo) return json(409, { detail: "This action has no undo" });
      if (a.undone_at) return json(409, { detail: "Already undone" });
      // The API calls the stored route as the person; the mock records the undo.
      a.undone_at = now();
      a.undone_by = me.id;
      if (!a.opened_by.includes(me.id)) a.opened_by.push(me.id);
      return json(200, actionOut(a, me.id));
    }
  }
  return null;
}
