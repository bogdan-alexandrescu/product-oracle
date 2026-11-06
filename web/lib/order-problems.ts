/**
 * The API's unknown_goal sentence (oracle.priorities.run_order._check_new_goals): "Gift wrap
 * choice names the goal g.no-such-goal, which is not a goal in the baseline: ...". The key
 * is all the run gave, so it has no name to show.
 */
const UNKNOWN_GOAL_TEXT = /^(.*? names )the goal (\S+), (which is not a goal in the baseline.*)$/;

/** The sentence's parts around the goal key, or null when it names no unknown goal. */
export function unknownGoalParts(message: string): { before: string; key: string; after: string } | null {
  const m = message.match(UNKNOWN_GOAL_TEXT);
  return m ? { before: m[1], key: m[2], after: m[3] } : null;
}

/** The sentence in words: the goal key reads "an unknown goal". */
export function unknownGoalWords(message: string): string {
  const m = unknownGoalParts(message);
  return m ? `${m.before}an unknown goal, ${m.after}` : message;
}
