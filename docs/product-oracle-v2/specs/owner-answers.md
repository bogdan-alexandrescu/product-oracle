# Owner answers to the large v2 specs (2026-10-25)

Each spec in this folder was written to its recommended answers. The owner's answers below
**override the spec wherever they differ**. Items marked *changed* are where the owner picked
something other than the spec's assumption; a build lane follows the answer, not the spec text.
Two specs (S2, I1) contain `********` where the artifact server masked an example credential;
treat those as placeholders.

## O5 Roadmap sharing (spec-O5.md)
- Q1 Approvers and owners create Board, Team and Engineering links; owners only for Public.
- Q2 Two exact path-rule entries on the existing public backend (`/s/*`, `/v1/public/shares/*`).
- Q3 Expiry required, 14 days preselected, 90 days at most.
- Q4 View log counts only, never an IP or identity.
- **Q5 changed: link plus passcode.** Every share link has a passcode the creator sets or Oracle
  generates; the viewer enters it before seeing anything. Store only a slow hash; rate-limit and
  lock out guessing per link; rotating the passcode keeps the link; the passcode is shown once.
- Q6 A link stays on its publication, with "Move to v<n>".
- Q7 Oracle drafts public item texts with a built-in job; a person approves each.
- Q8 A small "Made with Product Oracle" mark on shared pages, switchable by an owner.
- Q9 PDF download on by default, switchable per link.
- Q10 Links of a removed or demoted creator are revoked; owners get an Inbox row to re-share.

## I1 Outbound webhooks (spec-I1.md)
- Q1 Owners and approvers; approvers manage their own, owners all.
- Q2 Owners-and-approvers content only to a webhook an owner opts in, per webhook, with a reason.
- Q3 Payloads: ids, types, states, titles, names and links only.
- **Q4 changed: any write credential** (signed-in browser, API token or MCP client with write
  scope) may create a webhook or rotate its secret and so receive the secret once. Run tokens stay
  refused. Audit every create and rotate with the credential used.
- Q5 Any public https URL through the guarded transport.
- Q6 Delivery logs kept 30 days.

## INT2 Intake analysis on SwarmCloud (spec-INT2.md)
- Q1 Yes, one run-bound route returning exactly the job's payload to that intake's run token.
- Q2 Automatic, with a company switch (Settings › Company), on by default.
- **Q3 changed: fall back to the built-in job.** When the SwarmCloud read cannot start or fails,
  Oracle queues the old pool job for that intake; the intake says which path produced its read.
- Q4 Analyst at quick depth, $1.50.

## S2 Code maps from code (spec-S2.md)
- Q1 One Oracle GitHub App per deployment, installed by each company's owner.
- Q2 Only repos an owner allows (off by default, a reason per repo).
- **Q3 changed: a full file index for search.** Oracle stores file contents of allowed repos for
  search, in addition to the map. This needs its own design: secret scanning and redaction before
  storage, size caps, exclusion of vendored/binary/generated files, per-repo deletion when a repo
  is disallowed or the App uninstalled, and the same per-person visibility as the map (Q4).
- Q4 Unchanged: private to the GitHub source's owner until shared; runs read shared maps only.
- **Q5 changed: at most daily per repo, plus on request** ("Map the code" refreshes now).

## TRK Two-way tracker (spec-TRK.md)
- **Q1 changed: GitHub Projects first, and Notion for tracking as well**, instead of Linear/Jira.
- Q2 One company connection made by an owner.
- **Q3 changed: titles, outcome sentence and a link back, plus requirement bodies as an option**
  an owner switches on or off (off by default).
- Q4 Split by kind; a product-field edit on both sides is a conflict a person resolves.
- Q5 Oracle reads back only linked or Oracle-created items.
- Q6 A push happens only when an approver presses Send, per track.

## VOICE Customer voice (spec-VOICE.md)
- **Q1 changed: no support-platform integrations for now.** Instead, an in-app section where
  company staff enter customer feedback by hand, completed by customer interviews (the existing
  interview links). Intercom, Zendesk and HubSpot lanes are deferred.
- Q2 No CRM for now.
- Q3 Only feature-request tagged conversations are read (applies when integrations return).
- Q4 Customers appear as a company label; personal details are stripped at entry.
- **Q5 changed: Oracle's candidates and tag hints, plus manual filing** of a request by hand.
- Q6 Requests only now; win/loss later.
- Q7 Items kept 12 months, owner-adjustable.

## H5X Experiments and HEART (spec-H5X.md)
- Deferred by the owner. Do not build.
