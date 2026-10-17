# SwarmCloud feature requests from Product Oracle (drafts)

Source decisions: X1 Knowledge access (agents read Oracle's data through Oracle's MCP
with a run-scoped token), X2 SwarmCloud gaps (extend SwarmCloud broadly), X4 Filing
timing (file now), X4b Public filing (generic wording), X2b Model choice (model-tier
profiles). Target repo: `bogdan-alexandrescu/SwarmCloud` (**public**).

**Filed 2026-10-16:** 1 -> #1433, 2 -> #1434, 3 -> #1435, 4 -> #1436.

Written in the repo's feature-form sections and order, label `enhancement`, titles
stating the gap as a fact (SwarmCloud CLAUDE.md, "Issues"). Drafts are generic: they
describe "an orchestrating client application" and carry no product or company
product strategy, because the repo is public.

Related existing issues: #1347 workspace secrets store (open), #226 pinned model per
profile (closed; invariant 10: a caller never chooses the model).

---

## 1. Per-task MCP server and short-lived credential

**Title:** [feat] A task cannot reach its caller's MCP server, because a dispatch can attach neither an MCP server nor a short-lived credential for it

### What are you trying to do?

Run SwarmCloud workflows from an application that holds the knowledge its agents need
(an indexed graph of documents, conversations and decisions) behind its own MCP
server. Each agent must query that server during its run and write its results back
through it, with a credential that is valid for that one run only and expires with it.
Today a task's only inputs are its prompt, the one repository it clones, and the
inputs its profile declares (`issue` for claude-code). There is no way to give a task
an MCP server or a credential for one, so the application must paste context into the
prompt and lose everything the agent would have looked up on its own.

### What would you like to see?

- A dispatch (and a workflow step) may name **MCP servers** by URL, from a list the
  tenant has registered in advance (so a caller cannot point an agent at an arbitrary
  host).
- A dispatch may carry an **ephemeral credential** per named server: supplied by the
  caller at dispatch time, delivered to the worker only, injected as the server's auth
  header, never logged, never written to artifacts, and destroyed when the attempt
  ends. Redaction treats it like every other secret.
- The worker writes the MCP configuration for Claude Code before the agent starts, so
  the agent sees the server's tools like any local MCP server.
- Builds on #1347 (workspace secrets store): long-lived secrets come from the store,
  per-run credentials from the dispatch.

### Where would this live?

API — /v1 (apps/swarm-api); Scheduler — admission and dispatch (apps/scheduler);
Worker on GKE (apps/agent-worker); Claude Code plugin or MCP bridge (swarm_dispatch,
swarm_workflow gain the fields).

### How do you do it today?

Context is retrieved by the caller and pasted into each step's prompt; results come
back only as artifact files. The agent cannot ask a follow-up question of the
knowledge it was given.

### How would you know it worked?

- A claude-code task dispatched with a registered MCP server and a credential calls a
  tool on that server, and the server sees the credential.
- The same dispatch naming an unregistered URL is refused before admission.
- The credential appears in no log route, artifact, checkpoint or event; a test
  searches all of them for it.
- After the attempt ends, the worker holds no copy of it.

### Constraint check

- [x] A change to the frozen contract in `apps/common/swarm_common/`: new dispatch
      fields (`mcp_servers`, ephemeral credentials). Needs an entry in
      `docs/contract-change-requests.md`.
- Invariant 10 holds: the caller names registered servers, never an image, command or
  resource spec.

---

## 2. Additional read-only repositories per step

**Title:** [feat] A workflow step can read only the one repository its workflow clones, so a step that must understand a product spread across several repositories cannot

### What are you trying to do?

Have one step reason over a product whose code lives in several repositories (API,
web app, infrastructure, SDK). The repository is workflow-level, so every step clones
the same one; the only way to read the others is one task per repository plus a
merge step that sees summaries, not code.

### What would you like to see?

- A step may list **additional repositories**, each with a ref, checked out
  read-only beside the primary one (e.g. `./repos/<name>`), from repositories the
  tenant has registered.
- The primary repository stays the only one whose changes are carried back
  (`collect`, `direct-pr`, `integrate` unchanged).
- Pinning works as for the primary: each additional checkout is pinned to the commit
  its ref resolved to at submission.

### Where would this live?

API — /v1 (apps/swarm-api); Worker on GKE (apps/agent-worker); Claude Code plugin or
MCP bridge.

### How do you do it today?

One indexer task per repository, each writing a summary artifact, then a step that
stages all the summaries. Cross-repository questions ("which service owns this
endpoint the web app calls?") get answered from summaries, not code.

### How would you know it worked?

- A step with two additional repositories sees all three checkouts at their pinned
  commits.
- A change made inside an additional checkout is not in the collected patch.
- A repository the tenant has not registered is refused at submission.

### Constraint check

- [x] Frozen contract: new step field. Needs an entry in
      `docs/contract-change-requests.md`.
- Workspace size: 4 GiB today for claude-code; several checkouts may need a larger
  named resource class.

---

## 3. Choosing a cheaper model tier per step (within invariant 10)

**Title:** [feat] Every claude-code step runs the pinned Opus model, so a summarizing or classifying step costs as much as a deep-reasoning one

### What are you trying to do?

Run pipelines in which most steps are deep reasoning (Opus) and some are mechanical:
classify feedback, summarize a source, reformat a document. Since #226 every
claude-code step runs the pinned `claude-opus-5-5`, and invariant 10 rightly forbids
a caller from naming a model.

### What would you like to see?

Model tiers as **profiles**, keeping invariant 10 intact: the caller still picks a
profile by name and the profile fixes the model.

- `claude-code` (unchanged): `claude-opus-5-5`
- `claude-code-sonnet`: `claude-sonnet-5-5`
- `claude-code-haiku`: `claude-haiku-5-5`

Each is a catalogue entry with its own `MODEL` in Terraform, visible in
`swarm_profiles`.

### Where would this live?

Runner profile catalogue; Terraform (job env per profile); Worker (apps/agent-worker,
`--model` already passed since #226).

### How do you do it today?

Every step runs Opus, including steps that only reformat text.

### How would you know it worked?

- `swarm_profiles` lists the two new profiles with their models.
- An attempt on `claude-code-sonnet` records `claude-sonnet-5-5`.
- `input.model` from a caller is still refused (the #226 test still passes).

### Constraint check

- Invariant 10 holds: the model comes from the profile, never from the caller.
- [x] Frozen contract: the profile catalogue gains entries; if it must carry the
      model, that is a contract change request.

---

## 4. A step that waits for a person

**Title:** [feat] A workflow cannot wait for a person, so a review loop has to be split into one workflow per round with every artifact re-staged by the caller

### What are you trying to do?

Run a draft -> human review -> revision loop as one workflow: an agent writes a
draft, a person reviews it (minutes to days later), and the next agent revises it
using the review. Today a workflow cannot pause for anyone, so each round is a new
workflow. The earlier round's artifacts cannot be staged with `input_from` across
workflows, so the caller downloads and re-sends them in the next prompt.

### What would you like to see?

- An **`await_input` step type** that holds no lease and no capacity while it waits
  (invariant 1: waiting costs nothing).
- It completes when the caller posts a payload to an API endpoint for that step; the
  payload is written as the step's artifact (e.g. `review.json`) so dependants stage
  it with `input_from` like any other artifact.
- A timeout (`expires_after`) after which the step fails or takes a declared default
  branch.
- `swarm_workflow_status` and the console show the step as waiting on a person, with
  who it is waiting on.

### Where would this live?

API — /v1 (apps/swarm-api: new endpoint to complete the step); Scheduler (new step
state); Web UI · Work › Workflows (/workflows); Claude Code plugin or MCP bridge (a
tool to post the input).

### How do you do it today?

One workflow per round. The caller collects the draft, gathers the review in its own
UI, and dispatches a new workflow whose prompt contains both.

### How would you know it worked?

- A three-step workflow (draft -> await_input -> revise) parks at the second step with
  zero leases held, then resumes within one scheduler drain of the payload arriving.
- The revise step's workspace contains the posted payload under the declared name.
- A step left past `expires_after` ends as declared.

### Constraint check

- [x] Frozen contract: new step type and state. Needs an entry in
      `docs/contract-change-requests.md`.
- Invariant 1 holds: a waiting step holds no lease, pod or capacity.
