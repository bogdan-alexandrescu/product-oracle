# QA pass 4 · Documents (PRD pages) · design changes (7)
Found on the mock app (invented data) at desktop 1512 and phone 390, train AD's build. Ids qa4-<area>-N.

## qa4-docs-6 · major · Held rewrites squeezes outline and review panel into tiny scroll boxes
- Page: /documents/checkout-redesign/v/2
- What: Opening Held rewrites pushes the outline, section and review panels down but keeps them viewport-high, so the outline and the review panel become tiny inner scroll boxes showing only two or three rows.
- Steps: Checkout redesign PRD > v2 > Held rewrites.
- Expected: The held-rewrites panel opens as a drawer/dialog, or the three panels keep a usable height and the page scrolls.

## qa4-docs-34 · minor · Quality is a bordered button on the right while Impact and Compare are plain links on the…
- Page: /documents/checkout-redesign/v/2
- What: Quality is a bordered button on the right while Impact and Compare are plain links on the left, though all three open sibling pages of the version.
- Steps: Checkout redesign PRD > v2; look at the row under the tabs.
- Expected: The version pages share one control style and place.

## qa4-docs-38 · minor · The phone Review sheet's filter pills wrap unevenly ("Done 4" alone on a second row
- Page: /documents/checkout-redesign/v/2
- What: The phone Review sheet's filter pills wrap unevenly ("Done 4" alone on a second row; "Discussion" and the kind select on a third).
- Steps: Phone: Checkout redesign PRD > v2 > Review.
- Expected: A single scrollable row or a filter menu.

## qa4-docs-43 · minor · Every advisory row repeats "No model review · Not rated · No comparison", three columns of…
- Page: /documents/checkout-redesign/v/2/quality
- What: Every advisory row repeats "No model review · Not rated · No comparison", three columns of empty state.
- Steps: Checkout redesign PRD > v2 > Quality.
- Expected: One line ("No model or people ratings yet") or hide empty columns until there is data.

## qa4-docs-45 · minor · Three side-by-side actions (Mark reviewed, Accept regeneration, Reconcile…) have no line…
- Page: /documents/checkout-redesign/v/2/impact
- What: Three side-by-side actions (Mark reviewed, Accept regeneration, Reconcile…) have no line saying how they differ.
- Steps: Checkout redesign PRD > v2 > Impact > Regeneration plan.
- Expected: A short hint under each, or one primary action.

## qa4-docs-51 · minor · While the preview is open, both "Preview recommendation" (header) and "Close preview" (banner)…
- Page: /documents/checkout-redesign/composition
- What: While the preview is open, both "Preview recommendation" (header) and "Close preview" (banner) are shown, plus a Confirmed/Recommendation toggle: three controls for one state.
- Steps: Checkout redesign PRD > Composition > Preview recommendation.
- Expected: One toggle.

## qa4-docs-57 · minor · On a phone the presenter controls (Previous/Next, Presenter view, Full screen, Exit, key…
- Page: /documents/checkout-redesign/v/2/present
- What: On a phone the presenter controls (Previous/Next, Presenter view, Full screen, Exit, key hints) are small plain text crowded into one strip.
- Steps: Phone: Saved carts PRD > v2 > Present.
- Expected: Larger tap targets; hide keyboard hints on touch devices.
