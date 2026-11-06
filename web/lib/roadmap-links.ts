import type { Schemas } from "@/lib/api/client";

/** fix4 qa-simple-roadmap-8: the flags that are a broken link between items (a dependency
 * out of order, a cut item others still depend on); a draft with no owner or an end past its
 * milestone is red too, but it is not a broken link. Shared by the Roadmap and the side menu's
 * count (fix 2). */
export const LINK_KINDS: Schemas["SimpleFlag"]["kind"][] = ["dependency_order", "cut_with_dependents"];
