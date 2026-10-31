## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec

## Feature loop

For every new or existing feature:
1. Design and implement.
2. Deploy the feature and its configs.
3. Test it through the UI, as a person would. Never test it by calling the API or by
   changing data or settings by hand.
4. Repeat until the feature is done.

SwarmCloud lanes cannot deploy: they prove the feature with a Playwright test that drives
the built app's UI.

SwarmCloud lanes follow docs/agents/lane-rules.md and .claude/rules/oracle-product.md.
