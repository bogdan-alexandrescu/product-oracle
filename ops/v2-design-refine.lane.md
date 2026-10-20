# Lanes: v2 design, round 2, refining the shortlist (I3)

One SwarmCloud `claude-code` task per shortlisted proposal (2 or 3), strategy `collect`,
run in parallel after the owner shortlists from the ten (I3: shortlist, then refine). The
orchestrator reviews every rendered frame before the owner sees any.

## Prompt (per proposal)

ROUND 2 OF PROPOSAL `<ID>` for Product Oracle v2's visual design. Read first:
- ops/v2-design-proposals.lane.md: the round 1 brief. Its hard rules 1-7 still apply unchanged;
- docs/questions.md I3, including how the owner chose;
- round 1's `<ID>` files in docs/product-oracle-v2/design/proposals/round1/`<ID>`/ (HTML, sources, tokens.json, README.md, report.md). Render them first and look at them: that is the look to keep;
- the owner's notes on `<ID>`, below. They win over anything in round 1.

Facts every proposal draws the same way (owner decisions in docs/questions.md, data in quillfield.json):
- Goal progress is **distance to go** in the goal's own unit: "5 pts to go", "1.6 min to go", "164 to go", "0.4 to go" (I3 round 2). Not % of target, not share of gap closed. A ring, where one is kept, shows confidence.
- Online deposits at booking is a PRD in review, not a product track: label any shared block "In flight" or "Tracks and PRDs", and on the roadmap it "joins after publish", never inside Now.
- Roadmap: Now / Next / Later only (O4); no quarterly or outcome views, no dates beyond the priority snapshot's own label, no manual moving of milestones (the roadmap is derived; its action is a roadmap run).
- Runs: segments and roles exactly as `runs` in quillfield.json (Baseline proposal: researcher, analyst; Feature set, dependencies and design: analyst, architect; Priority order: prioritizer; PRD draft: writer, critic); one checkpoint waiting; cost one small figure (P3d).
- Publish: blocks, the four hard checks and the ten advisory criteria (T2; names from docs/product-oracle-v2/build-prompt.md, counts from quillfield.json); risk acceptance is owners only (B4) and an approver sees "Only an owner can accept this risk".
- Idea interview: a live chat with Oracle, the quick replies "I don't know", "Defer", "Ask someone", "Research this"; Oracle never shows "typing" while it waits for the person.
- Costs appear only on the cost approval and the overrun, on every size, including the phone.
- Decisions that are still open never carry a "done" checkmark.

Owner's notes on `<ID>`: `<NOTES>`

Keep `<ID>`'s identity: its type, colour, layout idea and its Home. Apply the notes, then
extend it to all nine screens of V2b's loop, with the same data
(docs/product-oracle-v2/design/proposals/quillfield.json):
1. `home`, 2. `requests`, 3. `baseline` (goals and the features serving them, the feature × goal view, flagged/conflicts/proposals as counts), 4. `idea-interview` (a new idea's questions asked as a live interview with Oracle, with "I don't know", defer, ask someone and research as quick replies), 5. `prd-review`, 6. `priorities` (ordered features with goal fit, confidence, effort and milestone, drag handles), 7. `roadmap`, 8. `runs` (segments and roles as Oracle's flows define them, one checkpoint waiting, cost as one small figure), 9. `publish` (what blocks, the hard checks, the ten advisory readiness criteria).

Frames: every screen in light and dark at 1440×900, and phone (390 wide, light) for home, idea-interview, prd-review and roadmap. Name them `<screen>-<light|dark>-<desktop|mobile>.png`.
Write tokens.json (light and dark), README.md (at most fifteen lines, in labels), and report.md (contrast table, rule check per frame, the notes and how each was applied).

Before finishing, open every PNG and check it against rules 1-7, and check that nothing is drawn twice, no text is clipped or overlapping, dark is a real theme, phone frames have no horizontal scroll, and every count agrees with the data file. Fix, re-render, look again.
Put everything under `$SWARM_ARTIFACTS_DIR/<ID>/`. Never use real company data. Do not open a pull request.
