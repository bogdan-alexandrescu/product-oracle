import Link from "next/link";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";

import { Icon, type IconName } from "./Icon";

export type ButtonVariant = "primary" | "secondary" | "solid" | "ghost" | "danger" | "hero";

const BASE =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap font-semibold transition-colors disabled:cursor-not-allowed aria-disabled:cursor-not-allowed";

/*
 * Disabled reads as disabled (qa-settings-6): a filled button turns to a muted neutral fill,
 * an outline button keeps its outline in the line colour; the text stays text2 (4.5:1 or
 * better on both, light and dark), and hover changes nothing. The focus ring is not set
 * here: every button takes the page's one ring (globals.css :focus-visible, 2px accent
 * outline 2px off the button), visible on an accent fill and on the page alike. A ghost has
 * no fill or outline to change, and its resting text is already text2: disabled, it is dimmed.
 * qa-docs-5: a disabled filled button also takes an outline in the strong line colour, so on a
 * surface2 panel (the same fill) it still reads as a button, not as plain text.
 */
const DISABLED_FILL =
  "disabled:border disabled:border-line-strong aria-disabled:border aria-disabled:border-line-strong disabled:bg-surface2 disabled:text-text2 disabled:brightness-100 disabled:hover:bg-surface2 disabled:hover:brightness-100 aria-disabled:bg-surface2 aria-disabled:text-text2 aria-disabled:hover:brightness-100";
const DISABLED_OUTLINE =
  "disabled:border-line disabled:text-text2 disabled:hover:bg-surface aria-disabled:border-line aria-disabled:text-text2 aria-disabled:hover:bg-surface";

const VARIANT: Record<ButtonVariant, string> = {
  // One per screen, top-right (I3 rule 3).
  primary: `h-10 rounded-button px-4 text-[15px] bg-accent text-on-accent hover:brightness-110 ${DISABLED_FILL}`,
  // Row actions everywhere (Decide, Approve, Resolve) are outline.
  secondary: `h-8 rounded-lg px-3 text-sm border border-line-strong bg-surface text-text hover:bg-surface2 ${DISABLED_OUTLINE}`,
  // A form's submit inside a panel: filled like primary, at row size; never a row action.
  solid: `h-8 rounded-lg px-3 text-sm bg-accent text-on-accent hover:brightness-110 ${DISABLED_FILL}`,
  ghost:
    "h-8 rounded-lg px-2.5 text-sm font-medium text-text2 hover:bg-surface2 hover:text-text disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-text2 aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-text2",
  danger: `h-8 rounded-lg px-3 text-sm border border-crit bg-surface text-crit hover:bg-crit-bg ${DISABLED_OUTLINE}`,
  // Secondary action in an Inspector head ("Open").
  hero: "h-8 rounded-lg px-3 text-sm border border-hero-text2 bg-transparent text-hero-text hover:bg-hero-2",
};

type Common = { variant?: ButtonVariant; icon?: IconName; children?: ReactNode; className?: string };

export function Button({
  variant = "secondary",
  icon,
  className = "",
  children,
  type = "button",
  ...props
}: Common & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type={type} data-variant={variant} {...props} className={`${BASE} ${VARIANT[variant]} ${className}`}>
      {icon && <Icon name={icon} size={variant === "primary" ? 20 : 16} />}
      {children}
    </button>
  );
}

export function LinkButton({
  variant = "secondary",
  icon,
  className = "",
  children,
  href,
  ...props
}: Common & { href: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  return (
    <Link href={href} data-variant={variant} {...props} className={`${BASE} ${VARIANT[variant]} ${className}`}>
      {icon && <Icon name={icon} size={variant === "primary" ? 20 : 16} />}
      {children}
    </Link>
  );
}
