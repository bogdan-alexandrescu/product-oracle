import { plural } from "./format";

/**
 * qa-docs-60: the one wording Publish and Quality both show for a version's publish verdict
 * (the readiness check's `blocked`): "Not blocked" when nothing refuses the publish, else
 * the number of blocks when the page lists them ("2 blocks"), or "Blocked".
 */
export function blockedLabel(blocked: boolean, blocks?: number): string {
  if (!blocked) return "Not blocked";
  return blocks ? plural(blocks, "block") : "Blocked";
}
