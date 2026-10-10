import type { ButtonHTMLAttributes, AnchorHTMLAttributes } from "react";
import Link from "next/link";

/**
 * Button (spec §19).
 *
 * Six variants, one of which — primary — is gold. A screen should carry at most
 * one: the accent means "this is the action", and three of them mean nothing.
 *
 * `loading` keeps the label in place and fades it rather than swapping in a
 * spinner, so the button does not change width under the cursor mid-click. It
 * also sets `aria-busy` and blocks pointer events, which is what stops a
 * double-submitted withdrawal.
 */

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "tertiary"
  | "ghost"
  | "danger"
  | "link";

export type ButtonSize = "sm" | "md" | "lg";

type Shared = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  className?: string;
};

function classes({ variant = "secondary", size = "md", block, className }: Shared) {
  return [
    "jc-btn",
    `jc-btn--${variant}`,
    size !== "md" ? `jc-btn--${size}` : null,
    block ? "jc-btn--block" : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");
}

type ButtonProps = Shared &
  ButtonHTMLAttributes<HTMLButtonElement> & {
    loading?: boolean;
    /** Announced while `loading`; the visible label is hidden during that time. */
    loadingLabel?: string;
  };

export function Button({
  variant,
  size,
  block,
  className,
  loading = false,
  loadingLabel = "Working…",
  disabled,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      className={classes({ variant, size, block, className })}
      data-loading={loading || undefined}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
    >
      {children}
      {loading ? <span className="jc-sr-only">{loadingLabel}</span> : null}
    </button>
  );
}

type LinkButtonProps = Shared &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
    href: string;
    /** Renders as a non-navigating element that still looks disabled. */
    disabled?: boolean;
  };

/**
 * A link styled as a button. Separate from `Button` on purpose: a thing that
 * navigates must be an anchor, so it opens in a new tab on middle-click and is
 * announced as a link rather than a control.
 */
export function LinkButton({
  variant,
  size,
  block,
  className,
  href,
  disabled,
  children,
  ...rest
}: LinkButtonProps) {
  if (disabled) {
    return (
      <span className={classes({ variant, size, block, className })} aria-disabled="true">
        {children}
      </span>
    );
  }

  return (
    <Link {...rest} href={href} className={classes({ variant, size, block, className })}>
      {children}
    </Link>
  );
}
