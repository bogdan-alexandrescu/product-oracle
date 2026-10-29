"use client";

import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";

import { TEXTAREA } from "@/app/settings/_components/fields";

/**
 * A text box that grows with its text, so a long description is read whole instead of
 * being cut off in a single-line input. Starts one line tall.
 */
export function GrowingTextarea({
  value,
  className = "",
  ...rest
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "rows"> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.height = "auto";
      // Hidden (not laid out): keep the natural height rather than a height of 0.
      if (!el.scrollHeight) return;
      el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
    };
    fit();
    // A narrower box wraps the text onto more lines: fit again when the width changes.
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [value]);
  return <textarea ref={ref} rows={1} value={value} className={`${TEXTAREA} resize-none overflow-hidden ${className}`} {...rest} />;
}
