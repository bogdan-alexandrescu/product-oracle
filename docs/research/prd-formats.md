# PRD formats: what practitioners use and rate highly (research, October 2026)

Research lane for Product Oracle's PRD templates (O1: multiple versioned templates,
O1b: Oracle is the source of truth, O1c: no citations in the body, all sources, data
points and evidence in a final `Sources and data points` section, O3: goal-weighted
prioritization by default, F3b: every feature traces to a company goal).

Method: web search and page fetches on 2026-10-17. Each claim below links the page it
came from; dates are the page's own publication date where one was shown. Structures
are described in my own words; no published template text is reproduced. Skeletons
for the recommended templates are in [`templates/prd/`](templates/prd/).

Note on O1c: the row is not yet in `docs/questions.md`; its definition here is taken
from the research brief (body carries no citations or evidence; a final section holds
sources, data points and evidence by section).

## 1. Summary

- **There is no single winning format.** Practitioner collections in 2024-2026 present a
  small set of named formats side by side and tell PMs to pick by situation: a
  one-pager to start, a fuller PRD for cross-functional builds, PR/FAQ for big new
  bets, Shape Up pitches for fixed-time cycles, RFC/design docs where engineering
  decides the how ([prodmgmt.world, Dec 2025, updated Aug 2026][pmw];
  [Lenny Rachitsky's template list][lenny-templates]; [ChatPRD template library,
  updated Oct 2026][chatprd-tpl]).
- **The two-stage "problem, then solution" shape is the most copied structure.** Square
  (Kevin Yien), Figma (Yuhki Yamashita), Miro's PAD, HashiCorp's PRD-then-RFC and
  Asana's brief-then-proposal all separate agreeing the problem from agreeing the
  solution, with a sign-off between ([Mutiny/Square PRD on Slab][slab-mutiny];
  [Figma's PRD approach][figma-coda]; [Miro, Apr 2021][miro-blog];
  [HashiCorp PRD][hc-prd]).
- **Short wins by default.** Lenny's 1-pager (six questions) is shipped as a built-in by
  Atlassian Confluence and Miro and is a community template in ChatPRD and Notion's
  top-10 PRD list ([Atlassian][atl-lenny]; [Miro][miro-lenny]; [Notion top 10][notion-top10]).
  Linear's method says short specs get read and force scoping ([Linear Method][linear]).
  Intercom starts every project with a one-page "Intermission" ([Intercom blog][intercom-ps]).
- **Non-goals are the most praised single section.** Called out as the notable feature
  of Kevin Yien's template, of Google design docs and of Shape Up's no-gos
  ([Lenny][lenny-templates]; [Design docs at Google][google-dd]; [Shape Up ch. 6][shapeup]).
- **AI changed the PRD twice in 2025-2026.** (a) AI features need new sections:
  behaviour matrix, eval set with ship threshold, fallbacks, prompt ownership
  ([Tian Pan, May 2026][tianpan]; [Miqdad Jaffer's AI PRD, Mar 2025][jaffer];
  ["Evals are the new PRD", Braintrust, Mar 2026][braintrust]). (b) Specs became the
  input to coding agents: GitHub's Spec Kit (Sep 2025) made "specify the what and why,
  then plan, then tasks" a mainstream workflow, with numbered requirements and
  Given/When/Then scenarios ([GitHub blog, 2 Sep 2025][speckit-blog]).
- **Counterpoint worth keeping:** Marty Cagan has argued since 2006 that prototypes, not
  long specs, should carry the "what", with the document as a supplement
  ([SVPG, Oct 2006][cagan]); Aakash Gupta (Aug 2025) argues prototypes lack the
  strategic context a spec carries, so both are needed ([Aakash Gupta][aakash-ai-prd]).

## 2. Formats

Each entry: origin, who uses it, fit, structure (paraphrased), strengths, weaknesses,
evidence, and the mapping to Oracle (F3b goal trace, O3 prioritization, per-section
feedback C1, O1c sources at the end).

### 2.1 Classic long-form PRD

- **Origin:** waterfall-era requirements documents; today's versions are the Atlassian
  Confluence blueprint, ProductPlan's glossary outline, and most Notion PRD templates.
- **Who uses it:** larger orgs, regulated domains, agencies, teams with many
  stakeholders or external contractors.
- **Fits:** growth stage and up; multi-team builds; compliance or contractual needs.
- **Structure:** header table (owner, status, release, team); objectives and success
  metrics; assumptions; requirements table (user story, importance, notes); design
  links; open questions; out of scope ([Atlassian template][atl-prd]). ProductPlan adds
  per-feature description/goal/use case, UX flow notes, system and environment
  requirements, and constraints/dependencies ([ProductPlan][productplan]).
- **Strengths:** complete, auditable, maps cleanly to tracker epics (Confluence links
  stories to Jira issues).
- **Weaknesses:** slow to write, seldom read end to end (Cagan's critique), invites
  solution detail before the problem is agreed.
- **Evidence:** default blueprint in Confluence; most "PRD" templates in Notion's
  gallery follow it ([Notion top 10][notion-top10]).
- **Oracle mapping:** good for traceability (requirements table can carry a goal
  column); per-section feedback is natural because sections are independent; O1c fits
  well since the body is already bullet/table based.

### 2.2 Problem/Solution alignment PRD (Square, Figma, Mutiny)

- **Origin:** Kevin Yien's template from Square (later used at Mutiny); Figma's version
  published by Yuhki Yamashita in May 2020 on Coda.
- **Who uses it:** growth-stage product orgs; widely copied by startups.
- **Fits:** a cross-functional feature where PM, design and eng must agree in stages.
- **Structure:** three stages with a reviewer sign-off between them. Problem alignment:
  the problem, why it matters, evidence, high-level approach, goals and non-goals.
  Solution alignment: key features in priority order, key flows, key logic and edge
  cases. Launch: phased rollout (pilot, beta, GA) with exit criteria and an operational
  checklist; appendix with changelog, open questions, FAQ and an impact checklist
  ([Slab: Mutiny PRD][slab-mutiny]). Figma's version names the stages problem
  alignment, solution alignment and launch readiness, embeds design files, and stresses
  choosing the right "altitude" ([Figma's PRD approach][figma-coda]).
- **Strengths:** stage gates stop teams building before the problem is agreed; the
  document grows with the project; priority-ordered features.
- **Weaknesses:** long by the end; launch section duplicates launch-plan tools.
- **Evidence:** both are in Lenny's 1-pager/PRD list ([Lenny][lenny-templates]) and are the
  most detailed entries in prodmgmt.world's 2025-26 guide ([pmw]).
- **Oracle mapping:** the closest public shape to Oracle's flow. Stage sign-offs map
  onto W2 checkpoints and per-section approve/reject (C1). Priority-ordered features
  are where O3's ranking lands. This is the basis of `oracle-default`.

### 2.3 One-pager / lean PRD

- **Origin:** Lenny Rachitsky's personal 1-pager (published Aug 2020, "how I start every
  project"); Intercom's Intermission; Steve Morin's (Asana) and Adam Thomas's
  one-page templates; Asana's project brief ([Lenny][lenny-templates]).
- **Who uses it:** seed to Series B startups; any team at the start of a project.
- **Fits:** small teams, a single feature, early alignment before investing in a full
  spec; also as the first stage of a longer doc.
- **Structure (Lenny):** six questions: what it is, what problem it solves, why we know
  the problem is real, how we will know it is solved, who it is for, what it looks
  like in the product ([Atlassian: Lenny's template][atl-lenny]). Intercom's
  Intermission: the problem, how success is measured, and scope, on one page
  ([Intercom][intercom-ps]).
- **Strengths:** fast, read in full, forces a problem statement and a success measure.
- **Weaknesses:** too thin for engineering hand-off; no room for flows or edge cases.
- **Evidence:** shipped as a named template by Atlassian and Miro, community template
  in ChatPRD, listed first in Notion's top-10 free PRD templates ([atl-lenny];
  [miro-lenny]; [chatprd-tpl]; [notion-top10]).
- **Oracle mapping:** goal trace must be one explicit line, otherwise lean docs drift
  away from goals; prioritization is usually a single "why now" line, so the score
  summary should be one line too; O1c helps here because the evidence would otherwise
  break the one-page limit.

### 2.4 Amazon Working Backwards PR/FAQ

- **Origin:** Amazon; popularised by Colin Bryar and Bill Carr's book *Working
  Backwards* (2021) and their public template on Coda (now Superhuman Docs).
- **Who uses it:** Amazon and AWS; ex-Amazon founders; teams deciding whether to make
  a big new bet.
- **Fits:** new products or major features where the question is "should we build this
  at all", reviewed by leadership.
- **Structure:** a one-page press release dated in the future (headline, subheading
  naming customer and benefit, the customer's problem, the solution, a leader quote,
  how it works, a customer quote, how to start), then external (customer) FAQs and
  internal (stakeholder) FAQs on market size, economics, risks and cost to build. About
  six pages total, press release under one page, plain language
  ([Koji guide][koji-prfaq]; [Coda: Colin Bryar][bryar-coda]).
- **Strengths:** forces customer-first framing; kills weak ideas before engineering
  starts; FAQs surface the hard questions.
- **Weaknesses:** little help with requirements or flows; a strong press release can
  hide thin feasibility thinking; unusual for small iterative features.
- **Evidence:** prodmgmt.world lists it first for major bets ([pmw]); ChatPRD ships a
  PR/FAQ template ([chatprd-tpl]); Lenny lists Amazon's PR template ([lenny-templates]).
- **Oracle mapping:** goal trace sits in the internal FAQ ("which company goal does this
  serve"); prioritization appears as a "why now / why this over alternatives" FAQ; the
  press release must stay free of citations, which matches O1c exactly.

### 2.5 Amazon six-page narrative memo

- **Origin:** Jeff Bezos's June 2004 email replacing slide decks in senior meetings with
  narrative memos read silently at the start of the meeting ([Management Today][mt-ppt];
  [CMI][cmi-amazon]).
- **Who uses it:** Amazon; companies that copied its writing culture (Stripe-style
  memo cultures, many ex-Amazon founders).
- **Fits:** strategic decisions, annual plans, choosing between options; reviewed in a
  meeting.
- **Structure:** prose, no bullets, about six pages plus appendices. A common reading of
  its arc: how things were, what changed, what we should do now, what the future looks
  like if we do ([Anecdote][anecdote]).
- **Strengths:** forces causal reasoning and relative importance; Bezos's argument is
  that slides let authors skip how ideas connect.
- **Weaknesses:** slow to write; hard to diff and comment on by section if the prose
  is one block; not an engineering hand-off.
- **Evidence:** the 2004 policy is widely reported; still the reference point for memo
  cultures.
- **Oracle mapping:** works if the narrative is split into headed sections so per-section
  feedback and stable ids still work. O1c is a real tension: narratives normally weave
  numbers into the argument. Oracle's version keeps conclusions in the prose and moves
  numbers and evidence to the final section (see owner question below).

### 2.6 Shape Up pitch

- **Origin:** Basecamp (37signals), Ryan Singer's *Shape Up* (2019), chapter "Write the
  Pitch".
- **Who uses it:** Basecamp/37signals and many small product teams running fixed
  six-week cycles; tool support in Fibery and others.
- **Fits:** small teams, fixed time budgets, decisions taken at a betting table.
- **Structure:** five parts: problem, appetite (how much time it is worth), solution
  (rough, "fat marker" sketches and breadboards, not wireframes), rabbit holes
  (risks called out in advance), no-gos (explicit exclusions) ([Shape Up ch. 6][shapeup]).
- **Strengths:** scope is fixed by time, not estimates; no-gos and rabbit holes are the
  most-cited ideas; leaves design detail to the builders.
- **Weaknesses:** assumes the Shape Up cadence and a betting table; thin on metrics and
  launch.
- **Evidence:** listed as a primary lean template in [pmw]; 37signals podcast episode on
  writing pitches ([37signals][37s-pitch]).
- **Oracle mapping:** appetite is effort in O3's formula (goal-weighted value / effort);
  goal trace is missing from the original and must be added as a line under Problem;
  sketches map to O2's low-fi wireframes and SVG flows.

### 2.7 Job stories (Intercom / JTBD)

- **Origin:** Alan Klement on Intercom's blog, Dec 2013; adopted by Intercom under Paul
  Adams.
- **Who uses it:** JTBD-oriented teams; Intercom; often inside another template.
- **Fits:** describing needs without personas or premature solutions.
- **Structure:** a sentence with situation, motivation and expected outcome ("when …,
  I want to …, so I can …"), focused on the triggering situation rather than a
  persona ([Intercom: job stories][klement]).
- **Strengths:** separates the need from the solution, so failures can be diagnosed.
- **Weaknesses:** a requirements style, not a document format.
- **Oracle mapping:** offer as a requirements-style option inside any template (job
  stories vs user stories), not as its own template.

### 2.8 Miro Product Alignment Document (PAD)

- **Origin:** Miro, Farbod Saraf, Apr 2021.
- **Structure:** opportunity/problem framing (problem, audience, why, metrics,
  competition, possible directions), solution framing (chosen and rejected solutions,
  out of scope, risks, GTM), post-launch recap (did it work, learnings), reviewed in a
  weekly alignment meeting with four possible outcomes ([Miro blog][miro-blog]).
- **Oracle mapping:** the post-launch recap is rare and valuable for the F3b replay test
  (did this feature serve its goal). Folded into `oracle-default` as an optional
  section rather than its own template.

### 2.9 Platform-published templates

| Publisher | What they ship | Notes |
|-----------|----------------|-------|
| Figma | Figma's PRD on Coda (2020); a FigJam PRD board at figma.com/templates | Board version mixes purpose, personas and flows on a canvas ([Figma template][figma-tpl]) |
| Notion | Gallery of community PRD templates; top-10 list led by Lenny's | Flexible, property-driven; no single canonical structure ([notion-top10]) |
| Linear | No long template; the Linear Method asks for short project specs with a named owner covering why, what and how ([linear]) | Brevity as a principle |
| Atlassian | Confluence product requirements blueprint; Lenny's template as a partner template | Requirements table linked to Jira ([atl-prd]; [atl-lenny]) |
| Coda (now Superhuman Docs) | Figma PRD, Colin Bryar's PR/FAQ, Miro PAD, a PRD gallery template | Coda was renamed Superhuman Docs after Grammarly's Oct 2025 rebrand ([Wikipedia][coda-wiki]) |
| ProductPlan | Glossary outline, not a downloadable PRD template | Objective, features, UX flow, system requirements, assumptions ([productplan]) |
| ChatPRD | 30+ templates incl. PRD, PR/FAQ, AI-build specs; community Lenny, Aakash, Peter Yang | The best signal of what AI-PRD users ask for ([chatprd-tpl]) |

### 2.10 RFC / design-doc hybrids

- **Origin:** IETF RFCs; Google design docs; HashiCorp's PRD → RFC pair; Oxide's RFDs;
  Uber, Stripe, Sourcegraph and many others ([Pragmatic Engineer, 2022, updated Feb 2024][pe-rfc]).
- **Fits:** engineering-heavy startups, infra and platform products, decisions where
  the "how" is the risky part.
- **Structure:** Google: context and scope, goals and non-goals, the design and its
  trade-offs, cross-cutting concerns, alternatives considered ([google-dd]).
  HashiCorp: a *problem* requirements document (background, problem by persona,
  phased requirements, research, approvals) that must be approved before RFCs are
  written; the RFC has overview, background, proposal, abandoned ideas, then freeform
  implementation/UX/UI ([hc-prd]; [hc-rfc]). Oxide's RFDs favour timely over polished
  and are discussed as pull requests ([Oxide RFD 1][oxide]).
- **Strengths:** alternatives and trade-offs are explicit; engineering trusts it; good
  for E1 (tech brief per feature).
- **Weaknesses:** can drift into pure engineering; the customer problem gets thin.
- **Oracle mapping:** the HashiCorp split matches Oracle's E1 hand-off: Oracle writes
  the product half and the requirements with stable ids; engineering's RFC answers
  them. Alternatives considered is where Oracle shows why lower-ranked options lost
  (O3).

### 2.11 AI-era PRDs

Two distinct trends.

**(a) PRDs for AI features.** Sections that classic templates lack:
- a behaviour matrix (input classes → acceptable outputs, acceptable failures,
  forbidden outputs), a named, versioned eval set with a ship threshold, fallback
  behaviour for refusal/timeout/tool failure, and prompt ownership and versioning
  ([Tian Pan, 2 May 2026][tianpan]);
- strategic context plus AI-specific non-functional requirements (quality, latency,
  cost) in Miqdad Jaffer's (OpenAI) template, published on The Product Compass,
  26 Mar 2025 ([jaffer]);
- evals as the spec itself: rubric, thresholds, run on every change
  ([Braintrust, 27 Mar 2026][braintrust]). Kevin Weil (OpenAI CPO) on Lenny's Podcast,
  Apr 2025: writing evals is becoming a core PM skill ([Lenny: Kevin Weil][weil]).
- Public model behaviour specs (OpenAI's Model Spec, versioned since May 2024) show
  the "objectives, rules, defaults" shape for describing model behaviour
  ([OpenAI Model Spec][modelspec]).

**(b) PRDs as input to coding agents.** GitHub's Spec Kit (2 Sep 2025) separates the
spec (user journeys, outcomes, what and why) from the plan (stack, architecture) and
the task list, uses numbered functional requirements, Given/When/Then acceptance
scenarios, and explicit clarification markers for open questions ([speckit-blog];
[Visual Studio Magazine, Sep 2025][vsm-speckit]). ChatPRD now ships "spec for AI
agents" and "AI prototyping" templates ([chatprd-tpl]). A 2026 claim that Spec Kit
reached 115k GitHub stars was not verified.

**Oracle mapping:** Oracle's own requirements should carry stable ids and testable
acceptance criteria in every template so E1 can hand them to engineering or agents.
An AI-feature template is needed because behaviour/evals/fallbacks have no home in the
others.

## 3. Comparison

| Format | Length | Style | Best stage / team | Decision type | Goal trace (F3b) | Prioritization (O3) | Per-section feedback | O1c fit |
|--------|--------|-------|-------------------|---------------|------------------|---------------------|----------------------|---------|
| Classic long-form | 5-20 pages | bullets, tables | growth+ / many teams | build spec | easy (goal column) | feature table | excellent | excellent |
| Problem/solution alignment | 3-10, grows | mixed, staged | Series A+ / squad | stage-gated build | explicit section | priority-ordered features | excellent (stages) | excellent |
| One-pager | 1 page | short answers | seed-B / small | start or not | one line | one line | good | helps (keeps 1 page) |
| PR/FAQ | ~6 (PR ≤1) | prose + Q&A | any / leadership | bet or kill | internal FAQ | internal FAQ | good per FAQ | good |
| Six-page narrative | ~6 + appendix | prose | any / exec review | strategic choice | woven in prose | woven in prose | fair (needs headings) | tension |
| Shape Up pitch | 1-3 | prose + sketches | small / fixed cycles | bet a cycle | must be added | appetite = effort | good | good |
| RFC / design doc hybrid | 3-15 | prose + diagrams | eng-heavy | how to build | goals/non-goals | alternatives | good | good |
| AI feature PRD | 4-10 | tables + matrices | AI products | ship quality bar | explicit | eval threshold gates | good | good |
| Agent-ready spec (Spec Kit) | 2-6 | numbered reqs | AI-coded builds | what to implement | not native | priority per story | good | good |

## 4. Recommendation: built-in templates for Oracle

Seven built-ins. All share: a goal trace (F3b, explicit even when one line), a
prioritization block in the shape of O3's method, stable section ids for per-section
feedback, no citations in the body, and the closing `Sources and data points`
section (O1c). Skeletons: [`templates/prd/`](templates/prd/).

| Key | Name | Purpose | Suggest when |
|-----|------|---------|--------------|
| `oracle-default` | Goal-traced PRD | Oracle's standard: goal trace, problem alignment, prioritized solution, requirements with ids, launch, recap | Default for any cross-functional feature or product version; the founder has no strong preference |
| `one-pager` | One-pager | Agree the problem, audience and success measure fast | Early idea, small team, single feature, or "should we spend more time on this" |
| `pr-faq` | Working Backwards PR/FAQ | Test a big new bet from the customer's view before building | New product, new market, major bet; reviewers are leadership or investors |
| `narrative-memo` | Decision narrative | Argue one strategic choice in prose | Choosing between options, a strategy shift, a board or exec review |
| `shape-up-pitch` | Shape Up pitch | Bet a fixed time budget on a shaped solution | Team works in fixed cycles; effort cap matters more than estimates |
| `prd-rfc` | Product spec + RFC | Product requirements plus engineering's design, alternatives and trade-offs | Engineering-heavy, infra/API/platform work, or the "how" is the main risk; E1 tech brief |
| `ai-feature` | AI feature PRD | Specify model behaviour, evals, fallbacks, cost and prompt ownership | Any feature whose output comes from a model or agent |

Considered and not made separate templates: job stories (a requirements-style toggle
inside any template), Miro PAD (its post-launch recap is an optional section in
`oracle-default`), classic long-form (covered by `oracle-default` with all optional
sections on), Spec Kit-style agent spec (its numbered requirements and Given/When/Then
criteria are built into `oracle-default`, `prd-rfc` and `ai-feature`; an export to the
Spec Kit file layout is a better fit than a template).

### Template picker: what to ask

Ask at most four questions, pre-filled from the baseline where possible, then show the
recommended template with a one-line reason and let the user override.

1. **What decision should this document get?** Start-or-not / commit a build / bet a
   fixed time / choose between options / approve a technical design. (Strongest
   signal: start-or-not → `one-pager`; bet → `shape-up-pitch` or `pr-faq`; choose →
   `narrative-memo`; technical design → `prd-rfc`.)
2. **How big and how new is it?** Small change to an existing feature / new feature /
   new product or market. (New product → `pr-faq`.)
3. **Who reads and approves it?** Founder only / product + eng team / leadership or
   board / external engineers or coding agents. (Board → `narrative-memo` or `pr-faq`;
   agents → templates with numbered requirements.)
4. **Does model output drive the feature?** Yes → `ai-feature` (or add its behaviour
   and eval sections to the chosen template).

Optional knobs shown after the choice: requirements style (user stories vs job
stories), include launch plan, include post-launch recap, visuals (SVG flow,
wireframes; O2), prioritization method (O3: goal-weighted, RICE, MoSCoW, WSJF).
Remember the last choice per document type, and let the user set a workspace default.

## 5. Presentation conventions (input to visual themes)

| Format | Page model | Text style | Visuals expected | Theme implications |
|--------|-----------|------------|------------------|--------------------|
| One-pager | must fit one printed page / one screen | short answers under question headings | none or one small sketch | dense, compact type; page-fit check in PDF export |
| Goal-traced / classic PRD | long scrolling doc with TOC | bullets, tables, requirement ids | flows, wireframes, design embeds, status header table | sticky TOC, status/owner header block, table styling, requirement id badges |
| PR/FAQ | press release page, then Q&A | journalistic prose, then bold questions | rarely any; none in the press release | newspaper-like first page (dateline, headline, subhead), Q&A styling |
| Narrative memo | about six printed pages, appendix after | full prose, no bullets | appendix charts and tables only | serif, generous line height, print-first margins, appendix break |
| Shape Up pitch | short web page / message | conversational prose | hand-drawn "fat marker" sketches, breadboards | sketch-style SVG, low-fidelity frames, informal tone |
| PRD + RFC | long technical doc | prose + code + diagrams | architecture/sequence diagrams, API tables, code blocks | monospace blocks, diagram width, numbered headings |
| AI feature PRD | long doc | tables and matrices | behaviour matrix, eval threshold table, cost table | wide tables, pass/fail colouring, threshold callouts |

Common to all: the `Sources and data points` section should render as an appendix
(smaller type, grouped by section, each item linkable back to its section), and the
body should render without citation markers.

## 6. Owner questions raised

Written to the artifacts `questions.json`:
- May the final `Sources and data points` section use `[c:id]` markers (so the import
  can validate them), or must it list citation ids as plain text?
- In narrative formats (PR/FAQ, memo), may the body state headline numbers, with their
  source in the final section, or must all data points move to the final section?

## 7. Not verified

- Section headings of Lenny's original Google Doc (taken from Atlassian's partner
  version of the same template).
- Kevin Yien's original Square version (taken from the Mutiny version on Slab).
- Intercom's Intermission page itself (described from Intercom blog search excerpts and
  secondary pages; the article fetch did not return its text).
- Paywalled detail of Aakash Gupta's AI PRD template; Peter Yang's PRD template sections.
- Popularity is shown by inclusion in tools and curated lists, not by survey data; no
  2024-2026 survey of PRD format usage was found.
- Spec Kit star counts quoted by secondary blogs.

## Sources

[pmw]: https://www.prodmgmt.world/blog/prd-template-guide
[lenny-templates]: https://www.lennysnewsletter.com/p/my-favorite-templates-issue-37
[chatprd-tpl]: https://www.chatprd.ai/docs/included-templates
[slab-mutiny]: https://slab.com/library/templates/mutiny-prd/
[figma-coda]: https://docs.superhuman.com/@yuhki/figmas-approach-to-product-requirement-docs
[miro-blog]: https://miro.com/blog/product-management-at-miro/
[hc-prd]: https://www.hashicorp.com/how-hashicorp-works/articles/prd-template
[hc-rfc]: https://www.hashicorp.com/how-hashicorp-works/articles/rfc-template
[atl-lenny]: https://www.atlassian.com/software/confluence/templates/lennys-product-requirements
[atl-prd]: https://www.atlassian.com/software/confluence/templates/product-requirements
[miro-lenny]: https://miro.com/templates/one-pager-by-lenny-rachitsky/
[notion-top10]: https://www.notion.com/templates/collections/top-10-free-prd-product-requirements-doc-templates-in-notion
[linear]: https://linear.app/method
[intercom-ps]: https://www.intercom.com/blog/?p=25178
[google-dd]: https://www.industrialempathy.com/posts/design-docs-at-google/
[shapeup]: https://basecamp.com/shapeup/1.5-chapter-06
[37s-pitch]: https://37signals.com/podcast/writing-a-pitch/
[tianpan]: https://tianpan.co/blog/2026/05/02/prd-ai-feature-old-template-misses-cliff
[jaffer]: https://www.productcompass.pm/ai-prd-template
[braintrust]: https://braintrust.dev/blog/evals-are-the-new-prd
[weil]: https://www.lennysnewsletter.com/p/kevin-weil-open-ai
[modelspec]: https://openai.com/index/our-approach-to-the-model-spec
[speckit-blog]: https://github.blog/ai-and-ml/generative-ai/spec-driven-development-with-ai-get-started-with-a-new-open-source-toolkit
[vsm-speckit]: https://visualstudiomagazine.com/Articles/2025/09/03/GitHub-Open-Sources-Kit-for-Spec-Driven-AI-Development.aspx
[cagan]: https://svpg.com/revisiting-the-product-spec/
[aakash-ai-prd]: https://www.news.aakashg.com/p/ai-prd
[koji-prfaq]: https://www.koji.so/docs/working-backwards-pr-faq-guide
[bryar-coda]: https://coda.io/@colin-bryar/working-backwards-how-write-an-amazon-pr-faq
[mt-ppt]: https://www.managementtoday.co.uk/why-amazon-banned-powerpoint/leadership-lessons/article/1689543
[cmi-amazon]: https://www.managers.org.uk/insights/news/2018/may/four-ways-amazon-optimises-meetings
[anecdote]: https://www.anecdote.com/2018/05/amazons-six-page-narrative-structure/
[klement]: https://www.intercom.com/blog/using-job-stories-design-features-ui-ux/
[productplan]: https://www.productplan.com/glossary/product-requirements-document/
[figma-tpl]: https://www.figma.com/templates/prd-template/
[coda-wiki]: https://en.wikipedia.org/wiki/Coda_(document_editor)
[pe-rfc]: https://blog.pragmaticengineer.com/rfcs-and-design-docs/
[oxide]: https://oxide.computer/blog/rfd-1-requests-for-discussion

- prodmgmt.world, "The Complete PRD Template Guide" (Dec 2025, updated Aug 2026): <https://www.prodmgmt.world/blog/prd-template-guide>
- Lenny Rachitsky, "My favorite templates" (Aug 2020): <https://www.lennysnewsletter.com/p/my-favorite-templates-issue-37>
- ChatPRD included templates (updated Oct 2026): <https://www.chatprd.ai/docs/included-templates>
- Mutiny / Kevin Yien PRD on Slab: <https://slab.com/library/templates/mutiny-prd/>
- Yuhki Yamashita, Figma's approach to PRDs (May 2020): <https://docs.superhuman.com/@yuhki/figmas-approach-to-product-requirement-docs>
- Farbod Saraf, product management at Miro (Apr 2021): <https://miro.com/blog/product-management-at-miro/>
- HashiCorp PRD template: <https://www.hashicorp.com/how-hashicorp-works/articles/prd-template>
- HashiCorp RFC template: <https://www.hashicorp.com/how-hashicorp-works/articles/rfc-template>
- Atlassian, Lenny's product requirements template: <https://www.atlassian.com/software/confluence/templates/lennys-product-requirements>
- Atlassian, product requirements template: <https://www.atlassian.com/software/confluence/templates/product-requirements>
- Miro, one-pager by Lenny Rachitsky: <https://miro.com/templates/one-pager-by-lenny-rachitsky/>
- Notion, top 10 free PRD templates: <https://www.notion.com/templates/collections/top-10-free-prd-product-requirements-doc-templates-in-notion>
- Linear Method: <https://linear.app/method>
- Intercom blog, problem statements / Intermission: <https://www.intercom.com/blog/?p=25178>
- Malte Ubl, Design docs at Google: <https://www.industrialempathy.com/posts/design-docs-at-google/>
- Ryan Singer, Shape Up, "Write the Pitch": <https://basecamp.com/shapeup/1.5-chapter-06>
- 37signals podcast, Writing a pitch: <https://37signals.com/podcast/writing-a-pitch/>
- Tian Pan, The PRD for an AI feature (May 2026): <https://tianpan.co/blog/2026/05/02/prd-ai-feature-old-template-misses-cliff>
- Miqdad Jaffer, AI PRD template, The Product Compass (Mar 2025): <https://www.productcompass.pm/ai-prd-template>
- Ameya Bhatawdekar, Evals are the new PRD, Braintrust (Mar 2026): <https://braintrust.dev/blog/evals-are-the-new-prd>
- Lenny's Podcast with Kevin Weil (Apr 2025): <https://www.lennysnewsletter.com/p/kevin-weil-open-ai>
- OpenAI, our approach to the Model Spec: <https://openai.com/index/our-approach-to-the-model-spec>
- Den Delimarsky, Spec-driven development with AI, GitHub blog (Sep 2025): <https://github.blog/ai-and-ml/generative-ai/spec-driven-development-with-ai-get-started-with-a-new-open-source-toolkit>
- Visual Studio Magazine on Spec Kit (Sep 2025): <https://visualstudiomagazine.com/Articles/2025/09/03/GitHub-Open-Sources-Kit-for-Spec-Driven-AI-Development.aspx>
- Marty Cagan, Revisiting the product spec (Oct 2006): <https://svpg.com/revisiting-the-product-spec/>
- Aakash Gupta, AI PRDs (Aug 2025): <https://www.news.aakashg.com/p/ai-prd>
- Koji, Working Backwards PR/FAQ guide: <https://www.koji.so/docs/working-backwards-pr-faq-guide>
- Colin Bryar, Working Backwards PR/FAQ on Coda: <https://coda.io/@colin-bryar/working-backwards-how-write-an-amazon-pr-faq>
- Management Today, Why Amazon banned PowerPoint: <https://www.managementtoday.co.uk/why-amazon-banned-powerpoint/leadership-lessons/article/1689543>
- CMI, Four ways Amazon optimises meetings (May 2018): <https://www.managers.org.uk/insights/news/2018/may/four-ways-amazon-optimises-meetings>
- Anecdote, Amazon's six-page narrative structure (May 2018): <https://www.anecdote.com/2018/05/amazons-six-page-narrative-structure/>
- Alan Klement, Job stories, Intercom (Dec 2013): <https://www.intercom.com/blog/using-job-stories-design-features-ui-ux/>
- ProductPlan, PRD glossary: <https://www.productplan.com/glossary/product-requirements-document/>
- Figma, PRD template: <https://www.figma.com/templates/prd-template/>
- Wikipedia, Coda (document editor): <https://en.wikipedia.org/wiki/Coda_(document_editor)>
- Gergely Orosz, RFCs and design docs (2022, updated Feb 2024): <https://blog.pragmaticengineer.com/rfcs-and-design-docs/>
- Oxide, RFD 1 (Jul 2020): <https://oxide.computer/blog/rfd-1-requests-for-discussion>
