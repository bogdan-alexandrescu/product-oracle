# Share links (O5): the two public path-rule entries

A share link (spec-O5 §3) shows one published roadmap, in one audience, to someone
outside the company who has the link **and its passcode** (owner answer O5-Q5). Link
holders have no IAP identity, so their two paths go to the **public backend** of the
existing load balancer, as `/mcp`, the OAuth endpoints, the Slack events endpoint
(`docs/ops-slack-bridge.md` §3) and the scheduler tick (`docs/ops-run-ticker.md` §3) do
(owner answer O5-Q2). Every other route stays behind IAP.

An owner applies this runbook after the share-links change (lane 3, migration
`0057_share_links`) is deployed. The lane that wrote it applied nothing.

| Path | What it serves | Code |
|---|---|---|
| `/v1/public/shares/*` | The link holder's API: the passcode form and the page (`GET`, `POST /v1/public/shares/<token>`), the PDF (`…/pdf`) and the state (`…/status`) | `api/oracle/shares/public.py` |
| `/s/*` | The address a link holder is sent: `https://$HOST/s/<token>` | the web page `web/app/s/[token]` (spec-O5 lane 5; see "Before you start") |

Both entries are prefix wildcards on purpose: the token is part of the path. Nothing else
under `/v1/public/` and nothing else at the root may be added: `/v1/public/interviews/*`
is not part of this change.

## Before you start

- **Which service answers `/s/*`.** The public backend is the API service. The address a
  creator copies is `/s/<token>`; lane 5 builds that page in the web app. Until the
  owner settles where `/s/*` is served (questions.json, "O5 share: which service answers
  /s/*"), add only the `/v1/public/shares/*` entry and share links as
  `https://$HOST/v1/public/shares/<token>`, which works on its own: the API serves the
  passcode form and the page there, with no script.
- **The cookie.** After the right passcode the API sets `po_share` (HttpOnly, Secure,
  SameSite=Strict) on the path `/v1/public/shares/<token>` for 8 hours at most. The path
  rule must send `/v1/public/shares/<token>` and its sub-paths to the same backend, or the
  cookie is never sent back.
- **Country in the view log (optional, O5-Q4).** The view log records a country only when
  the load balancer gives one. To give it, add a custom request header on the public
  backend service: `X-Client-Region: {client_region}`. Without it the column stays empty.
  The client's address is never stored; the API reads it from `X-Forwarded-For` only for
  the in-memory rate limit (`ORACLE_TRUSTED_PROXY_HOPS`, as `/mcp` does).

## 1. Back up the URL map

```sh
gcloud compute url-maps export <URL_MAP> --project="$PROJECT" --destination=url-map.yaml
cp url-map.yaml url-map.backup.yaml
```

Keep `url-map.backup.yaml` until the check in section 3 passes.

## 2. Add the two entries and import

In the path matcher for `$HOST`, add the two paths to the pathRule whose service is the
public (no-IAP) backend, beside `/mcp`, `/integrations/slack/events` and
`/internal/scheduler/tick`:

```yaml
# url-map.yaml, pathMatchers[<the one for $HOST>].pathRules[<the public backend's>]
paths:
- /mcp
# ... the existing entries stay as they are ...
- /v1/public/shares/*
- /s/*
```

```sh
gcloud compute url-maps validate --project="$PROJECT" --source=url-map.yaml
gcloud compute url-maps import <URL_MAP> --project="$PROJECT" --source=url-map.yaml
```

The load balancer takes a few minutes to apply it everywhere.

## 3. Check

From a machine with no IAP session (a private browser window, or `curl`):

```sh
# Any token gets the passcode form, with 401, never IAP's sign-in page:
curl -s -o /dev/null -w '%{http_code}\n' "https://$HOST/v1/public/shares/not-a-real-token"
# 401
curl -sI "https://$HOST/v1/public/shares/not-a-real-token" | grep -i -E \
  'content-security-policy|x-robots-tag|referrer-policy|cache-control'
# default-src 'none'; ... / noindex, nofollow / no-referrer / no-store

# A wrong passcode is 404 with the form, the same for every token:
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -d passcode=not-the-passcode "https://$HOST/v1/public/shares/not-a-real-token"
# 404

# Everything else is still behind IAP:
curl -s -o /dev/null -w '%{http_code}\n' "https://$HOST/v1/documents"
# 302 (to IAP's sign-in) or 401/403 from IAP, never 200
curl -s -o /dev/null -w '%{http_code}\n' "https://$HOST/v1/public/interviews/x"
# the same as before this change
```

Then, signed in as an owner: publish a roadmap, make a Board link with a passcode
(`POST /v1/documents/<doc>/share-links`, or the Share sheet once lane 5 ships), open its
address in a private window, enter the passcode, and see the page. Revoke it; the next
reload says "This link has ended. Ask the person who sent it for a new one."

| What you see | Cause |
|---|---|
| IAP's sign-in page or an IAP 403 | The entry is missing or on the wrong pathRule: the request went to the IAP backend. |
| 404 from the load balancer itself (not Oracle's form) | The public backend does not serve that path (see "Before you start" for `/s/*`). |
| The passcode is accepted but the page asks again | The cookie's path `/v1/public/shares/<token>` is not routed to the same backend. |
| 429 on every request | Every client shares one address: `ORACLE_TRUSTED_PROXY_HOPS` does not match the proxies in front of the API. |

## Rollback

1. Restore the URL map: `gcloud compute url-maps import <URL_MAP> --project="$PROJECT"
   --source=url-map.backup.yaml` (or remove the two entries). Every link stops working at
   once, which is the safe failure: `/s/*` and `/v1/public/shares/*` fall back to IAP.
2. Only then revert the share-links change. Its down-migration (`0057_share_links`)
   drops `share_link_views` and `share_links`: every link and its view log are gone, and
   a revert cannot bring them back. Revoke links you want to end for good before it.

PDFs that link holders already downloaded stay with them; the creation dialog says so.
