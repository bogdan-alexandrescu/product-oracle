'use client';

import { useEffect, useRef, useState, type ComponentProps, type KeyboardEvent } from 'react';

import { Button, InfoTip } from '@/components/ds';
import { dmy } from '@/components/simple/PrdTimeline';

/** de-prd (PR2 a "Click to type"): the one-pager's fields that turn into their input on a click. */

const FIELD = 'rounded border border-[var(--simple-rule)] bg-transparent px-1.5 py-0.5 text-base';
const TYPE = 'cursor-text rounded text-left decoration-dotted underline-offset-4 hover:underline';

/** A small mark on a proposal that waits for who decides (its words behind the tip). */
export function Pending() {
  return (
    <span data-testid="op-pending" className="inline-flex items-center gap-1 text-sm text-warn">
      Pending
      <InfoTip label="Pending">It changes when who decides accepts it.</InfoTip>
    </span>
  );
}

export function SavedMark({ onUndo }: { onUndo?: () => void }) {
  return (
    <span data-testid="op-saved" className="inline-flex items-center gap-1.5 text-sm text-pass">
      Saved
      {onUndo && (
        <Plain
          data-testid="op-undo"
          onClick={onUndo}
          className="!text-sm !font-semibold !text-accent-ink hover:underline"
        >
          Undo
        </Plain>
      )}
    </span>
  );
}

/** Enter and a click away keep the value; Esc puts it back. */
function keys(e: KeyboardEvent, keep: () => void, cancel: () => void) {
  if (e.key === 'Enter') {
    e.preventDefault();
    keep();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    cancel();
  }
}

/** A text value that turns into its field on a click (or Enter when focused); Delete removes the row. */
export function Typed({
  label,
  testId,
  value,
  may,
  save,
  className = '',
  onOpen,
  onDelete,
  multiline,
}: {
  label: string;
  testId: string;
  value: string;
  may: boolean;
  save: (v: string) => void | Promise<void>;
  className?: string;
  onOpen?: () => void;
  onDelete?: () => void;
  multiline?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  const done = useRef(false);
  const start = () => {
    done.current = false;
    setText(value);
    setEditing(true);
  };
  const keep = () => {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    const v = text.trim();
    if (v && v !== value) void save(v);
  };
  const cancel = () => {
    done.current = true;
    setEditing(false);
  };
  if (!may)
    return onOpen ? (
      <Plain
        data-testid={testId}
        onClick={onOpen}
        className={`!text-base !text-text hover:underline ${className}`}
      >
        {value}
      </Plain>
    ) : (
      <span data-testid={testId} className={className}>
        {value}
      </span>
    );
  if (editing) {
    const common = {
      'aria-label': label,
      autoFocus: true,
      value: text,
      onBlur: keep,
      className: `${FIELD} ${className} ${multiline ? 'w-full' : 'min-w-[12rem] max-w-full'}`,
    };
    return multiline ? (
      <textarea
        {...common}
        rows={2}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // A new line with Shift+Enter; Enter keeps it.
          if (e.key === 'Enter' && e.shiftKey) return;
          keys(e, keep, cancel);
        }}
      />
    ) : (
      <input
        {...common}
        maxLength={200}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => keys(e, keep, cancel)}
      />
    );
  }
  return (
    <Plain
      data-testid={testId}
      aria-label={label}
      onClick={start}
      onKeyDown={(e) => {
        if ((e.key === 'Delete' || e.key === 'Backspace') && onDelete) {
          e.preventDefault();
          onDelete();
        }
      }}
      className={`${TYPE} !text-base !text-text ${className}`}
    >
      {value}
    </Plain>
  );
}

/** A value picked from a list (an owner): its list on a click, kept as it is picked; Esc closes it. */
export function Picked({
  label,
  testId,
  value,
  shown,
  may,
  options,
  save,
}: {
  label: string;
  testId: string;
  value: string;
  shown: string;
  may: boolean;
  options: { value: string; label: string }[];
  save: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const words = <span className={value ? 'text-text2' : 'text-warn'}>{shown}</span>;
  if (!may) return <span data-testid={testId}>{words}</span>;
  if (editing)
    return (
      <select
        aria-label={label}
        autoFocus
        value={value}
        className={FIELD}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) =>
          keys(
            e,
            () => setEditing(false),
            () => setEditing(false),
          )
        }
        onChange={(e) => {
          setEditing(false);
          if (e.target.value !== value) save(e.target.value);
        }}
      >
        {/* The current owner stays listed while the people are read. */}
        {!options.some((o) => o.value === value) && <option value={value}>{shown}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  return (
    <Plain
      data-testid={testId}
      aria-label={label}
      onClick={() => setEditing(true)}
      className={`${TYPE} !text-base !font-normal`}
    >
      {words}
    </Plain>
  );
}

/** A feature's dates, month first; on a click its two day fields, kept on Enter or a click away. */
export function Dates({
  label,
  start,
  end,
  may,
  save,
}: {
  label: string;
  start: string;
  end: string;
  may: boolean;
  save: (start: string, end: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [a, setA] = useState(start);
  const [b, setB] = useState(end);
  const box = useRef<HTMLSpanElement>(null);
  const done = useRef(false);
  const words = `${dmy(start)} – ${dmy(end)}`;
  if (!may)
    return (
      <span data-testid="op-feature-dates" className="text-sm text-text2 tabular-nums">
        {words}
      </span>
    );
  const keep = () => {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    if (a && b && b >= a && (a !== start || b !== end)) save(a, b);
  };
  const cancel = () => {
    done.current = true;
    setEditing(false);
  };
  if (editing)
    return (
      <span
        ref={box}
        className="inline-flex flex-wrap items-center gap-1"
        onBlur={(e) => {
          // A click away from both fields keeps them.
          if (!box.current?.contains(e.relatedTarget)) keep();
        }}
      >
        <input
          type="date"
          aria-label={`Start of ${label}`}
          autoFocus
          value={a}
          onChange={(e) => setA(e.target.value)}
          onKeyDown={(e) => keys(e, keep, cancel)}
          className={FIELD}
        />
        <span aria-hidden>–</span>
        <input
          type="date"
          aria-label={`End of ${label}`}
          value={b}
          min={a}
          onChange={(e) => setB(e.target.value)}
          onKeyDown={(e) => keys(e, keep, cancel)}
          className={FIELD}
        />
      </span>
    );
  return (
    <Plain
      data-testid="op-feature-dates"
      aria-label={`Dates of ${label}`}
      onClick={() => {
        done.current = false;
        setA(start);
        setB(end);
        setEditing(true);
      }}
      className={`${TYPE} !text-sm !font-normal !text-text2 tabular-nums`}
    >
      {words}
    </Plain>
  );
}

/** A goal's last row: type a name, Enter adds it and the field stays for the next; Esc clears it. */
export function AddRow({ goal, onAdd }: { goal: string; onAdd: (title: string) => void }) {
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');
  if (!typing)
    return (
      <li className="border-t border-[var(--simple-rule)] py-1.5 first:border-t-0">
        <Plain
          data-testid="op-add-feature"
          aria-label={`Add a feature to ${goal}`}
          onClick={() => setTyping(true)}
          className="!text-base !font-semibold !text-accent-ink hover:underline"
        >
          + Add a feature
        </Plain>
      </li>
    );
  return (
    <li className="border-t border-[var(--simple-rule)] py-1.5 first:border-t-0">
      <input
        aria-label={`New feature in ${goal}`}
        autoFocus
        maxLength={200}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (!text.trim()) setTyping(false);
        }}
        onKeyDown={(e) =>
          keys(
            e,
            () => {
              const t = text.trim();
              if (!t) return;
              onAdd(t);
              setText('');
            },
            () => {
              setText('');
              setTyping(false);
            },
          )
        }
        className={`${FIELD} w-full max-w-[28rem]`}
      />
    </li>
  );
}

/** A row's ⋯ menu: Move to Trash at once (Undo in the note). Esc or a click away closes it. */
export function RowMenu({ title, onRemove }: { title: string; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  return (
    <span ref={box} className="relative ml-auto">
      <Plain
        data-testid="op-feature-menu"
        aria-label={`More for ${title}`}
        aria-expanded={open}
        onClick={() => setOpen((x) => !x)}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        className="!px-2 !text-base !text-text2 hover:!bg-surface2"
      >
        ⋯
      </Plain>
      {open && (
        <span
          role="menu"
          className="absolute right-0 z-10 mt-1 flex min-w-40 flex-col rounded-md border border-line bg-surface p-1 shadow-md"
        >
          <Plain
            role="menuitem"
            data-testid="op-feature-remove"
            autoFocus
            onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
            onClick={() => {
              setOpen(false);
              onRemove();
            }}
            className="!rounded-md !px-3 !py-1.5 !text-base !font-normal !text-warn hover:!bg-surface2"
          >
            Move to Trash
          </Plain>
        </span>
      )}
    </span>
  );
}

/** A value or a small action as plain text: the design system's Button, drawn as the text it shows. */
function Plain({ className = '', ...props }: ComponentProps<typeof Button>) {
  return (
    <Button
      variant="ghost"
      {...props}
      className={`!h-auto !justify-start !whitespace-normal !rounded !px-0 !text-left hover:!bg-transparent ${className}`}
    />
  );
}
