import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import { SegmentedControl } from "./SegmentedControl";

/*
 * The render-test pattern (#1583): a component beside its test, in happy-dom with Testing
 * Library. protects = the picked segment says it is pressed, a click picks another, and the
 * arrow keys move between segments; fails_when = aria-pressed or the arrow keys stop working;
 * no_claim = how the control looks (Playwright drives the pages that use it).
 */
const ITEMS = [
  { value: "brief", label: "Brief" },
  { value: "full", label: "Full", count: 3 },
] as const;

test("the picked segment is pressed and a click picks another", async () => {
  const onChange = vi.fn();
  render(<SegmentedControl label="Detail" items={[...ITEMS]} value="brief" onChange={onChange} />);
  expect(screen.getByRole("group", { name: "Detail" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Brief" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "Full 3" })).toHaveAttribute("aria-pressed", "false");
  await userEvent.click(screen.getByRole("button", { name: "Full 3" }));
  expect(onChange).toHaveBeenCalledWith("full");
});

test("the arrow keys move between segments, round the end", async () => {
  render(<SegmentedControl label="Detail" items={[...ITEMS]} value="brief" onChange={() => {}} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Brief" }));
  await user.keyboard("{ArrowRight}");
  expect(screen.getByRole("button", { name: "Full 3" })).toHaveFocus();
  await user.keyboard("{ArrowRight}");
  expect(screen.getByRole("button", { name: "Brief" })).toHaveFocus();
});
