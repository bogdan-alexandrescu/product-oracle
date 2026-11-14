// goalFigure lives apart from lib/format so the mock API can import it without a cycle
// (format -> dates -> me -> client -> mock/server -> the mock modules).

/** A stored currency unit, any case, as its sign ("usd" is "$"); a sign stays itself. */
export const CURRENCY_SIGNS: Record<string, string> = { usd: "$", eur: "€", gbp: "£", $: "$", "€": "€", "£": "£" };

/** A unit's word in the singular (as the API's goals.singular_unit): "events" → "event",
 * "failed payments per 100 orders" → "failed payment per 100 orders", "stories" → "story", "percent of
 * orders" → "percent of orders" (the noun after "of" stays plural); a "%"
 * unit ("% of orders") and an all-caps word ("NPS") stay as they are. */
export function singularUnit(unit: string): string {
  if (unit.startsWith("%")) return unit;
  // What follows " per " or " of " stays as it is: "1 percent of orders", "1 failed payment per 100 orders".
  const at = unit.search(/ (?:per|of) /);
  const [head, ...per] = at < 0 ? [unit] : [unit.slice(0, at), unit.slice(at)];
  const one = head.replace(/[A-Za-z]{3,}$/, (w) =>
    /^[A-Z]+$/.test(w) || /(ss|us|is|series|news)$/i.test(w) || !/s$/i.test(w)
      ? w
      : /[^aeiou]ies$/i.test(w)
        ? `${w.slice(0, -3)}y`
        : /(ch|sh|x|z)es$/i.test(w)
          ? w.slice(0, -2)
          : w.slice(0, -1),
  );
  return [one, ...per].join("");
}

/** goal-figure-words (as the API's goals.figure_words): a goal's number in its unit as people write
 * it: a currency's sign before it ("$50,000", "€1,200", "£3.5"), other units after it ("1,200 shops",
 * "60%", "3 days"), singular for 1 ("1 day"); commas between thousands, decimals kept (a currency's to at most two: "$13,400.56"). */
export function goalFigure(value: number, unit?: string | null): string {
  const u = (unit ?? "").trim();
  const sign = CURRENCY_SIGNS[u.toLowerCase()];
  const shown = Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: sign ? 2 : 20 });
  const minus = value < 0 && shown !== "0" ? "-" : "";
  if (sign) return `${minus}${sign}${shown}`;
  if (u === "%") return `${minus}${shown}%`;
  return `${minus}${shown} ${Math.abs(value) === 1 ? singularUnit(u) : u}`.trim();
}
