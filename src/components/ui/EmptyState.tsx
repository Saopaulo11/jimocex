import type { ReactNode } from "react";

/**
 * Empty and error states (spec §28, §29).
 *
 * A professional product explains an empty screen; it does not decorate it. No
 * illustrations, no mascots — a small geometric mark, a plain sentence, and
 * where applicable the action that would fill it.
 *
 * The distinction worth keeping: "you have nothing here yet" and "we cannot
 * show you this right now" are different messages, and conflating them leaves
 * the customer unable to tell whether to wait or to act.
 */

type Kind = "empty" | "unavailable" | "error";

const MARK: Record<Kind, ReactNode> = {
  empty: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="2.5" y="4" width="13" height="10" rx="1.5" />
      <path d="M2.5 7.5h13" />
    </svg>
  ),
  unavailable: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="9" cy="9" r="6.5" />
      <path d="M4.5 4.5l9 9" strokeLinecap="round" />
    </svg>
  ),
  error: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M9 2.5 16 15H2L9 2.5Z" strokeLinejoin="round" />
      <path d="M9 7v3.5M9 12.5v.01" strokeLinecap="round" />
    </svg>
  ),
};

export function EmptyState({
  kind = "empty",
  title,
  description,
  action,
}: {
  kind?: Kind;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="jc-empty">
      <span className="jc-empty-mark" aria-hidden="true">
        {MARK[kind]}
      </span>
      <p className="jc-empty-title">{title}</p>
      {description ? <p className="jc-empty-body">{description}</p> : null}
      {action ? <div style={{ marginTop: "var(--jc-space-2)" }}>{action}</div> : null}
    </div>
  );
}

/**
 * The state shown wherever a provider would supply data but none is connected.
 *
 * Used in place of prices, charts, order books and deposit addresses. Saying so
 * plainly is the whole point: a fabricated figure is indistinguishable from a
 * real one on screen, and a customer would make decisions against it.
 */
export function ProviderUnavailable({
  what,
  description,
}: {
  what: string;
  description?: string;
}) {
  return (
    <EmptyState
      kind="unavailable"
      title={`${what} is currently unavailable`}
      description={
        description ?? "No provider is connected for this on this deployment. Nothing is being estimated in its place."
      }
    />
  );
}
