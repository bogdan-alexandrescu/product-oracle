"use client";

import Link from "next/link";
import { useId, useState, type FormEvent } from "react";

import { Field, INPUT, SELECT } from "@/app/settings/_components/fields";
import { normaliseDomain } from "@/app/settings/sources/CompanyDrive";
import { Button, Chip, Icon, InfoTip, Notice, Panel, SegmentedControl } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { errorMessage, useQuery } from "@/lib/use-query";

type Rules = Schemas["SignInRulesOut"];
type Rule = Rules["without_invite"];

const RULES: { value: Rule; label: string; line: string }[] = [
  {
    value: "request",
    label: "Ask an owner",
    line: "Someone from these domains who signs in without an invite waits until an owner approves. Requests appear here and in the Inbox.",
  },
  { value: "join", label: "Join at once", line: "Someone from these domains who signs in without an invite joins at once with the default role." },
  { value: "refuse", label: "Invite only", line: "Only invited people can join. Others are told to ask an owner." },
];
const ROLE_WORD = { owner: "Owner", approver: "Approver", commenter: "Commenter", viewer: "Viewer" } as const;
const DOMAINS_KEY = "company_email_domains";

const writeSetting = (key: string, value: unknown) =>
  unwrap(api.PUT("/v1/settings/{key}", { params: { path: { key } }, body: { value } }));

const H3 = "text-[15px] font-semibold";

/**
 * Settings › Members › Sign-in (A5, 3.10; owners): the company's email domains (a deployment
 * domain is locked: it is set where Oracle is deployed), what happens to a Google sign-in
 * from them without an invite, and the role such a person starts with.
 */
export function SignInRules() {
  const q = useQuery("sign-in-rules", () => unwrap(api.GET("/v1/sign-in-rules")));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const inputId = useId();
  const rules = q.data;
  const off = !!rules && (!rules.google_sign_in || rules.new_sign_ins_off);

  async function save(key: string, value: unknown) {
    setBusy(true);
    setError(null);
    try {
      await writeSetting(key, value);
      await q.reload();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    const domain = normaliseDomain(text);
    if (!domain) return;
    if (rules?.domains.some((d) => d.domain === domain)) return setError(`${domain} is already on the list.`);
    // The stored list keeps the deployment's domains too, as Settings › Sources saves it.
    const all = rules?.domains.map((d) => d.domain) ?? [];
    if (await save(DOMAINS_KEY, [...all, domain])) setText("");
  }

  return (
    <Panel
      testId="sign-in-rules"
      title={
        <span className="inline-flex items-center gap-1.5">
          Sign-in
          <InfoTip label="sign-in" align="start">
            Google sign-in in front of Oracle decides who can reach it at all. These rules decide who becomes a member.
          </InfoTip>
        </span>
      }
    >
      <div className="flex flex-col gap-4 p-4 max-[600px]:p-3">
        {q.error && <Notice tone="error">{q.error}</Notice>}
        {!rules && !q.error && <span aria-busy className="block h-3 w-1/2 animate-pulse rounded bg-surface2" />}
        {rules && !rules.google_sign_in && (
          <Notice>Google sign-in is off for this Oracle, so these rules don&apos;t apply: people sign in with a password.</Notice>
        )}
        {rules?.google_sign_in && rules.new_sign_ins_off && <Notice>New sign-ins are turned off where Oracle is deployed.</Notice>}
        {rules && (
          <>
            <section aria-label="Company domains" className="flex flex-col gap-2">
              <h3 className={H3}>Company domains</h3>
              {/* qa-settings-17: Sources › Google Drive shows the same list as "Company email domains". */}
              <p data-testid="sign-in-domains-hint" className="text-sm text-text2">
                Who may sign in from Google. It is the same list as Company email domains in{" "}
                <Link href="/settings/sources#company-domains" className="font-semibold text-accent-ink hover:underline">
                  Settings › Sources
                </Link>
                , where it also decides which Google Drive docs Oracle reads.
              </p>
              <ul aria-label="Company domains" className="flex flex-wrap gap-1.5">
                {rules.domains.map((d) => (
                  <li key={d.domain} aria-label={d.domain} data-testid="sign-in-domain" data-from={d.from}>
                    {d.from === "deployment" ? (
                      <Chip kind="line" className="font-mono" title="Set where Oracle is deployed; change it there">
                        <Icon name="lock" size={16} />
                        {d.domain}
                      </Chip>
                    ) : (
                      <Chip kind="line" className="pr-0.5 font-mono">
                        {d.domain}
                        {editing && (
                          <button
                            type="button"
                            aria-label={`Remove ${d.domain}`}
                            disabled={busy || off}
                            onClick={() => void save(DOMAINS_KEY, rules.domains.filter((x) => x.domain !== d.domain).map((x) => x.domain))}
                            className="grid size-6 place-items-center rounded-full text-text2 hover:bg-surface2 hover:text-text disabled:opacity-70"
                          >
                            <Icon name="x" size={16} />
                          </button>
                        )}
                      </Chip>
                    )}
                  </li>
                ))}
              </ul>
              {!editing ? (
                <div>
                  <Button disabled={off} onClick={() => setEditing(true)}>
                    Edit domains
                  </Button>
                </div>
              ) : (
                <form onSubmit={add} aria-label="Add a company domain" className="flex flex-wrap items-end gap-1.5">
                  <Field label="Add a domain" htmlFor={inputId} className="max-w-72 flex-1">
                    <input
                      id={inputId}
                      value={text}
                      onChange={(e) => {
                        setText(e.target.value);
                        setError(null);
                      }}
                      placeholder="example.com"
                      autoComplete="off"
                      spellCheck={false}
                      inputMode="url"
                      aria-invalid={!!error}
                      className={`${INPUT} font-mono`}
                    />
                  </Field>
                  <Button type="submit" variant="solid" icon="plus" className="h-9" disabled={busy || off || !text.trim()}>
                    Add
                  </Button>
                  <Button variant="ghost" className="h-9" onClick={() => setEditing(false)}>
                    Done
                  </Button>
                  <p className="basis-full text-sm text-text2">
                    Docs in picked Drive folders owned outside these domains are skipped (Settings › Sources).
                  </p>
                </form>
              )}
            </section>
            {error && (
              <p role="alert" className="text-[13px] font-medium text-crit">
                {error}
              </p>
            )}
            <section aria-label="Without an invite" className="flex flex-col gap-2">
              <h3 className={H3}>Without an invite</h3>
              {/* On a phone the three choices wrap onto rows of their own. */}
              <div className="max-[600px]:[&_[role=group]]:flex-col max-[600px]:[&_[role=group]]:items-stretch">
                <SegmentedControl
                  label="Without an invite"
                  items={RULES.map((r) => ({ value: r.value, label: r.label, disabled: off || busy }))}
                  value={rules.without_invite}
                  onChange={(v) => void save("sign_in_without_invite", v)}
                />
              </div>
              <p data-testid="sign-in-rule-line" className="text-sm text-text2">
                {RULES.find((r) => r.value === rules.without_invite)?.line}
              </p>
            </section>
            <section className="flex flex-col gap-2">
              <Field label="Default role" className="max-w-56">
                <select
                  aria-label="Default role"
                  value={rules.default_role === "viewer" || rules.default_role === "commenter" ? rules.default_role : ""}
                  disabled={off || busy}
                  onChange={(e) => void save("iap_default_role", e.target.value)}
                  className={SELECT}
                >
                  {rules.default_role !== "viewer" && rules.default_role !== "commenter" && <option value="">{ROLE_WORD[rules.default_role]}</option>}
                  <option value="viewer">Viewer</option>
                  <option value="commenter">Commenter</option>
                </select>
              </Field>
              <p className="text-sm text-text2">The role an approved request starts with, and the role of anyone who joins at once.</p>
              {(rules.default_role === "approver" || rules.default_role === "owner") && (
                <Notice tone="warn">
                  Anyone from these domains starts as {rules.default_role}. Choose Viewer or Commenter.
                </Notice>
              )}
            </section>
          </>
        )}
      </div>
    </Panel>
  );
}
