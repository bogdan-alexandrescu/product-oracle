import Link from "next/link";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";

import { Icon, type IconName } from "./Icon";

export type ButtonVariant = "primary" | "secondary" | "solid" | "ghost" | "danger" | "hero";

const BASE =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap font-semibold transition-colors disabled:cursor-not-allowed aria-disabled:cursor-not-allowed";

const VARIANT: Record<ButtonVariant, string> = {
  // One per screen, top-right (I3 rule 3).
  primary:
    "h-10 rounded-button px-4 text-[15px] bg-accent text-on-accent hover:brightness-110 disabled:bg-surface2 disabled:text-text2 disabled:border disabled:border-line-strong",
  secondary:
    "h-8 rounded-lg px-3 text-sm border border-line-strong bg-surface text-text hover:bg-surface2 disabled:text-text2 disabled:opacity-70",
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
    <button type={type} {...props} className={`${BASE} ${VARIANT[variant]} ${className}`}>
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
    <Link href={href} {...props} className={`${BASE} ${VARIANT[variant]} ${className}`}>
      {icon && <Icon name={icon} size={variant === "primary" ? 20 : 16} />}
      {children}
    </Link>
  );
}
