// A goal's unit check, apart from ./goals so simple-roadmap can read it without importing
// home's goals (and through them the API client and this mock server: an import cycle).

const CURRENCIES = ["USD", "EUR", "GBP"];
const UNITS = ["%", ...CURRENCIES, "ms", "s", "min", "h", "days"];
const NOUN = /^[a-z][a-z -]{0,23}$/;

export const unitOk = (v: unknown) => typeof v === "string" && (UNITS.includes(v) || NOUN.test(v));
