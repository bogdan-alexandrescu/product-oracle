"use client";

import { INPUT } from "@/app/settings/_components/fields";

/** What the API accepts as a template or theme key (schemas KEY_PATTERN). */
export const KEY_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

export const keyValid = (key: string) => KEY_RE.test(key);

/**
 * The key of a new template or theme: what it may contain is said under the field, and a
 * key that breaks the rule says so there. The pattern escapes its hyphen: browsers check
 * patterns with the /v flag, where a bare "-" at the end of a class is invalid and the
 * whole pattern is then ignored.
 */
export function KeyField({
  id,
  value,
  onChange,
  placeholder,
  error,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  /** What the server said about this key (one that is taken), shown under the field. */
  error?: string | null;
}) {
  const bad = value !== "" && !keyValid(value);
  const flagged = bad || !!error;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2">
        Key
      </label>
      <input
        id={id}
        className={`${INPUT} font-mono ${flagged ? "border-crit ring-1 ring-crit" : ""}`}
        value={value}
        onChange={(e) => onChange(e.target.value.toLowerCase())}
        placeholder={placeholder}
        pattern="[a-z0-9][a-z0-9\-]{1,62}"
        title="Lowercase letters, digits and hyphens"
        aria-invalid={flagged || undefined}
        aria-describedby={`${id}-hint`}
        required
      />
      <p id={`${id}-hint`} data-testid={`${id}-hint`} className={`text-[13px] leading-[18px] ${flagged ? "text-crit" : "text-text2"}`}>
        {error && !bad
          ? error
          : bad
          ? value.length < 2
            ? "A key needs at least 2 characters: lowercase letters, digits and hyphens."
            : value.length > 63
              ? "A key has at most 63 characters."
              : "A key may contain only lowercase letters, digits and hyphens, and starts with a letter or digit."
          : "Lowercase letters, digits and hyphens, starting with a letter or digit. It cannot change later."}
      </p>
    </div>
  );
}
