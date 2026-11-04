/**
 * As oracle.intake.discovery (walk 2 problem 19): an answer saying something is unknown and
 * finding it out is part of this work plans work, never a blocker. The same plain-word
 * reading as the API's is_discovery, and the requirement it makes of a gap.
 */

const UNKNOWN = new RegExp(
  "\\b(unknown|not (yet )?known|(don't|do not|doesn't|does not|didn't|did not) know|" +
    "(no one|nobody) knows|not sure|unsure|unclear|not clear|no idea|" +
    "(no one|nobody) (has )?(checked|looked|measured|tested)|" +
    "(haven't|have not|hasn't|has not|not) (yet )?(been )?" +
    "(checked|measured|tested|confirmed|verified|looked)|tbd|" +
    "to be (found|determined|confirmed|checked))\\b",
);
const FINDING =
  "\\b(find(s|ing)?|found|figur(e|es|ing)|work(s|ing)? (it|them|this|that|these|those) out|" +
  "learn(s|ing)?|discover(s|ing|y)?|check(s|ing)?|measur(e|es|ing)|test(s|ing)?|" +
  "investigat(e|es|ing|ion)|research(es|ing)?|spike)\\b";
const PART = "\\bpart of (this|the|our) (work|project|job|plan|build|scope|effort|feature|prd)\\b";
const FINDING_IS_PART = new RegExp(FINDING + "[^.;!?]{0,80}?" + PART);
const WE_WILL_FIND = /\b(we'll|we will|we're going to|the team will|will be) (find|figure|work|found|figured|worked)( (it|them|this|that))? out\b/;
const DISCOVERY_STEP = /\b(discovery|spike)\b/;
const NOT_PART = new RegExp(
  "\\b(not|never|isn't|aren't|nor)\\b[^.;!?]{0,30}" + PART + "|\\boutside (of )?(this|the|our) (work|scope|project|plan)\\b|\\bout of scope\\b",
);

export function isDiscovery(text: string | null | undefined): boolean {
  if (!text?.trim()) return false;
  const t = text.replace(/[‘’]/g, "'").toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  if (NOT_PART.test(t)) return false;
  if (FINDING_IS_PART.test(t)) return true;
  return UNKNOWN.test(t) && (new RegExp(PART).test(t) || WE_WILL_FIND.test(t) || DISCOVERY_STEP.test(t));
}

const REQUIREMENTS: Record<string, string> = {
  third_party_policy: "Find out the platform's policy and API limits",
  blockers: "Find out what could stop this shipping",
};

/** As discovery.requirement_for: what to find out, from the gap's category (and its label). */
export function requirementFor(category: string, label: string | undefined, statement: string): string {
  if (REQUIREMENTS[category]) return REQUIREMENTS[category];
  if (label) return `Find out the ${label[0].toLowerCase()}${label.slice(1)}`;
  return `Find out: ${statement.replace(/\.$/, "")}`;
}
