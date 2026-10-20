import Link from "next/link";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";

import { Icon, type IconName } from "./Icon";

export type ButtonVariant = "primary" | "secondary" | "solid" | "ghost" | "danger" | "hero";

const BASE =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap font-semibold transition-colors disabled:cursor-not-allowed aria-disabled:cursor-not-allowed";

const VARIANT: Record<ButtonVariant, string> = {
  // One per screen, top-right (I3 rule 3). Filled even while disabled (a muted fill, still
  // 4.5:1), so the page's primary action never reads as an outline button.
  primary:
    "h-10 rounded-button px-4 text-[15px] bg-accent text-on-accent hover:brightness-110 disabled:bg-accent-mid disabled:text-accent-ink disabled:hover:brightness-100 aria-disabled:bg-accent-mid aria-disabled:text-accent-ink",
  // Row actions everywhere (Decide, Approve, Resolve) are outline.
  secondary:
    "h-8 rounded-lg px-3 text-sm border border-line-strong bg-surface text-text hover:bg-surface2 disabled:text-text2 disabled:opacity-70",
  // A soft tint for a form's submit inside a panel; never a row action.
  solid: "h-8 rounded-lg px-3 text-sm bg-accent-soft text-accent-ink hover:brightness-95 disabled:opacity-70",
  ghost: "h-8 rounded-lg px-2.5 text-sm font-medium text-text2 hover:bg-surface2 hover:text-text disabled:opacity-70",
  danger: "h-8 rounded-lg px-3 text-sm border border-crit bg-surface text-crit hover:bg-crit-bg disabled:opacity-70",
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
