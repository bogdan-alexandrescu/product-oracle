import { expect, test } from "./test";

import { asSentence, roleRefusal } from "../lib/api/client";
import { MOCK_NOW } from "../lib/api/mock/clock";
import {
  formatAge,
  formatCount,
  formatDateRange,
  formatMoney,
  formatMoneyOf,
  formatPercent,
  formatShortDate,
  formatTime,
  formatWeekday,
  plural,
  zoneName,
} from "../lib/format";
import { docLabel, runLabel } from "../lib/labels";

/*
 * One way to write each value, unit-tested without a browser: dates, times, ranges and ages
 * in the Company time zone, money, counts, plurals, percentages, zone names, run and
 * document names, and what a failed call says. Zone and now are passed, so the results hold
 * on any machine.
 * protects = what a person reads for these values; fails_when = a year shows for this year,
 * an age reads "24h" or "11 d", a count has no separator, a run shows its slug, or an error
 * shows a status; no_claim = where each screen uses them.
 */

const LA = "America/Los_Angeles";
const now = Date.parse(MOCK_NOW);

test("dates: the year only when it is not this year, in the Company zone", () => {
  expect(formatShortDate("2026-10-28T16:00:00Z", now, LA)).toBe("Oct 28");
  expect(formatShortDate("2025-10-28T16:00:00Z", now, LA)).toBe("Oct 28, 2025");
  expect(formatShortDate("2027-01-05", now, LA)).toBe("Jan 5, 2027");
  // 03:00 UTC on Oct 29 is still Oct 28 in Los Angeles.
  expect(formatShortDate("2026-10-29T03:00:00Z", now, LA)).toBe("Oct 28");
  expect(formatWeekday("2026-11-02T17:00:00Z", LA)).toBe("Mon, Nov 2");
  // A timestamp without a zone is a moment in UTC, not a calendar day.
  expect(formatShortDate("2026-10-29T03:00:00", now, LA)).toBe("Oct 28");
  expect(formatDateRange("2026-10-20T03:00:00", "2026-10-29T03:00:00", LA)).toBe("Oct 19 – Oct 28, 2026");
});

test("times: hour, minute and the zone's short name", () => {
  expect(formatTime("2026-10-22T16:00:00Z", LA)).toBe("9:00 AM PDT");
  expect(formatTime("2026-12-01T17:00:00Z", LA)).toBe("9:00 AM PST");
});

test("date ranges: an en dash, the year once when both ends share it", () => {
  expect(formatDateRange("2026-09-08", "2026-10-20", LA)).toBe("Sep 8 – Oct 20, 2026");
  expect(formatDateRange("2026-12-08", "2027-01-20", LA)).toBe("Dec 8, 2026 – Jan 20, 2027");
  expect(formatDateRange("2026-10-20", "2026-10-20", LA)).toBe("Oct 20, 2026");
});

test("ages: now, minutes, hours, days and weeks, with no space and no 24h", () => {
  expect(formatAge("2026-10-22T11:59:30Z", now)).toBe("now");
  expect(formatAge("2026-10-22T11:55:00Z", now)).toBe("5m");
  expect(formatAge("2026-10-22T09:00:00Z", now)).toBe("3h");
  expect(formatAge("2026-10-21T12:00:00Z", now)).toBe("1d");
  expect(formatAge("2026-10-11T12:00:00Z", now)).toBe("11d");
  expect(formatAge("2026-09-22T12:00:00Z", now)).toBe("4w");
  // A time still to come is not "now".
  expect(formatAge("2026-10-22T12:05:00Z", now)).toBe("in 5m");
  expect(formatAge("2026-10-25T12:00:00Z", now)).toBe("in 3d");
  expect(formatAge("2026-10-22T12:00:20Z", now)).toBe("now");
});

test("money, counts, plurals and percentages", () => {
  expect(formatMoney(6.82)).toBe("$6.82");
  expect(formatMoney(1250)).toBe("$1,250.00");
  expect(formatMoneyOf(6.82, 4)).toBe("$6.82 of $4.00");
  expect(formatCount(12345)).toBe("12,345");
  expect(plural(1, "item")).toBe("1 item");
  expect(plural(2, "item")).toBe("2 items");
  expect(plural(0, "item")).toBe("0 items");
  expect(plural(1234, "run")).toBe("1,234 runs");
  expect(plural(2, "person", "people")).toBe("2 people");
  expect(formatPercent(0.375)).toBe("38%");
});

test("time zones in words, with the city", () => {
  expect(zoneName(LA)).toBe("Pacific Time (Los Angeles)");
  expect(zoneName("Nowhere/Some_City")).toBe("Some City");
});

test("documents and runs by name, never by slug", () => {
  expect(docLabel({ title: "Usage alerts PRD", kind: "prd" })).toBe("Usage alerts PRD");
  expect(docLabel({ title: "Visit reminders", kind: "prd" })).toBe("Visit reminders PRD");
  expect(docLabel({ title: "Usage alerts roadmap", kind: "roadmap" })).toBe("Usage alerts roadmap");
  expect(docLabel({ title: "Q4 update", kind: "update" })).toBe("Q4 update");
  const run = { flow_title: "Roadmap items for a PRD draft", document_slug: "usage-alerts", document_kind: "prd" as const };
  expect(runLabel(run, "Usage alerts PRD")).toBe("Usage alerts PRD · Roadmap items for a PRD draft");
  expect(runLabel(run)).toBe("Usage alerts PRD · Roadmap items for a PRD draft");
  expect(runLabel({ flow_title: "Build the baseline", document_slug: null })).toBe("Build the baseline");
});

test("errors: a role refusal names who may act; a message reads as a sentence or not at all", () => {
  expect(roleRefusal("Requires the approver role")).toBe("Only approvers and owners can do this.");
  expect(roleRefusal("Requires the owner role")).toBe("Only owners can do this.");
  expect(roleRefusal("Requires the commenter role")).toBe("Only commenters, approvers and owners can do this.");
  expect(roleRefusal("Requires the approver role or the engineering lead")).toBe("Only approvers, owners and the engineering lead can do this.");
  expect(roleRefusal("Only an owner can decide this stop")).toBeNull();
  // The lead's clause counts only right after the role it widens.
  expect(roleRefusal("This stop is decided by the owner or the engineering lead")).toBeNull();
  expect(roleRefusal("Requires the engineering lead or an owner")).toBe("Only owners and the engineering lead can do this.");
  expect(asSentence("Slack is busy: try again in 30 seconds")).toBe("Slack is busy: try again in 30 seconds");
  expect(asSentence("reconciling needs a reason")).toBe("reconciling needs a reason");
  expect(asSentence("source_changed")).toBeNull();
  // One plain word reads as a sentence; a host before a colon is not a field's name.
  expect(asSentence("Forbidden")).toBe("Forbidden.");
  expect(asSentence("posthog.com: the project was not found")).toBe("posthog.com: the project was not found");
  expect(asSentence("bad {json}")).toBeNull();
  expect(asSentence("a dated milestone needs a verified estimate (basis_ids); Oracle never invents dates")).toBe(
    "a dated milestone needs a verified estimate; Oracle never invents dates",
  );
});
