# 07. Release and dogfood checklist

Wave 3 of [waves.md](waves.md): the checks a merged wave passes before it deploys, and the
steps the company follows to use Oracle on its own next product version. It is written
from what is built. Owner decisions are named by their id in
[docs/questions.md](../questions.md). Nothing here names a company, customer or account.

## 1. Before a release: the suite

Run these on the merged branch, in order. Each one must pass, or its failure must be named
in the release note with the reason.

- [ ] `make lint`: ruff check and format on `api/`.
- [ ] `make test`: the full API suite on Postgres 16.
- [ ] `make openapi`, with no diff left: the committed OpenAPI and web client match the API.
- [ ] `alembic upgrade head` on a copy of the last release's database. Then
      `alembic downgrade -1` and upgrade again for each new migration.
- [ ] Web: `npx next typegen && npx tsc --noEmit -p .`, `npm run lint`, `npm run build`.
- [ ] `make e2e-mock`: every UI spec against the in-browser mock API.
- [ ] `make e2e`: the real-stack specs in `web/e2e/real` (API on a fresh `oracle_e2e`
      database with `ORACLE_RUNTIME=fake`, and a production web build). Includes
      **the vertical slice**, `slice.spec.ts`, described in section 2.
- [ ] Smoke check after the deploy: `/healthz`, sign in, Home loads. `GET /v1/runtime/status`
      reports SwarmCloud reachable. The run ticker's last tick is under two minutes old
      ([docs/ops-run-ticker.md](../ops-run-ticker.md)).

Deploys follow the owner's cadence (V2a): one per wave, after the merged wave passes this
list.

## 2. The vertical slice (what `slice.spec.ts` proves)

One person, the company's owner, drives every step in the browser on synthetic data. The
agents are the API's `FakeRuntime`.

| Step | What the person does | What must follow |
|---|---|---|
| Brief | PRDs › New PRD: a title and the problem | An intake opens at `/intakes/<id>` |
| Gaps and questions | Opens the Gaps tab; answers Oracle's first question | Gaps are listed; the answer shows in the thread; a critical blocker gap still open holds Draft with Oracle until it is decided with a rationale |
| Composition | (no screen yet: through `/v1`) | The intake's recommendation names modules; a revision is confirmed on the drafted PRD |
| PRD draft | Draft with Oracle, every stop off but PRD review; Estimate; Start drafting; Check agents now | The run rebuilds the baseline (none approved yet) and imports the PRD as v1 |
| Review | Open review from the run | The version opens with the run's review bar |
| Publish | Publish, then Publish v1 in the dialog | Published v1; the run's review is settled and the run Succeeded; the composition revision is pinned to v1 |
| Roadmap | Build roadmap; Estimate; Start run; Check agents now; Review items, Approve | The roadmap draft is imported as `<prd>-roadmap` v1 and waits for its review |

Not proved by the slice:

- the agents' writing (the fake's fixed files);
- the real Claude or SwarmCloud;
- an engineering spec. No screen starts one: `POST /v1/spec-requests` needs a requirement
  id and an approved PRD.
- the composition inspector. It has no screen yet; `v2-ui` lists it.

## 3. Dogfood: the company's own next version

Use Oracle for the company's next product version (F5). Keep its specifics in `private/`
or in the deployed instance, never in the repository (R0: the repository is public).

1. **Set up** (owner)
   - [ ] Settings › Company: the Company time zone. Settings › Members: the members and
         their roles (an approver decides checkpoints; an owner approves runs over $50, P3).
   - [ ] Settings › Claude accounts: at least one pool account, or a fallback credential,
         for discussions, interviews and the built-in model jobs.
   - [ ] Each member connects their own sources (S5) and picks what Oracle reads (S3:
         visible per person).
2. **Baseline**
   - [ ] Confirm the company's goals and the current features. A PRD's goal question is
         asked until a confirmed goal exists.
3. **The slice, for real**
   - [ ] Write one short brief through New PRD.
   - [ ] Answer or decide its critical questions; ask the next batch of named people.
   - [ ] Draft with Oracle, with the stops on the first time.
   - [ ] Review section by section, then publish.
   - [ ] Build the roadmap from the published PRD.
   - [ ] Where engineering asks, request a spec.
4. **Watch** for a week
   - [ ] The Inbox: checkpoints, questions, cost approvals and overruns (P3d: cost shows
         only there and as one line on a run).
   - [ ] Plan › Reports: the weekly alignment report.
   - [ ] Runs that fail or pause: record the run id and the reason in an issue, never the
         document's content.
5. **Feed back**
   - [ ] Each problem becomes a GitHub issue in plain words, with synthetic examples only.

## 4. Gated: not part of a release until the owner says so

| Item | Waits for | State |
|---|---|---|
| Live SwarmCloud end-to-end check ([swarmcloud-interface.md](../swarmcloud-interface.md), section 3) | SwarmCloud reports person-wait and answering on in development, and the owner authorizes the run | not run |
| Caller MCP and await-input steps (adapter v2) | the same switches | built behind them; the fallback flow runs meanwhile ([04](04-swarmcloud-integration.md)) |
| Figma authoring | O6 | disabled |
| SwarmCloud bundled when Oracle is sold | X3 | not decided |
| Enterprise privacy and compliance | T1 | not decided |
