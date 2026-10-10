import type { ReactNode } from "react";

/**
 * Alert (spec §25).
 *
 * For conditions the customer has to act on or account for: verification
 * required, a limit reached, a provider unavailable, a withdrawal under review.
 *
 * `danger` and `warning` announce themselves with role="alert"; `info` and
 * `success` use role="status", which is polite and waits for a pause rather
 * than interrupting what the screen reader is already saying.
 */

export type AlertTone = "info" | "success" | "warning" | "danger";

const GLYPH: Record<AlertTone, string> = {
  info: "•",
  success: "✓",
  warning: "!",
  danger: "×",
};

export function Alert({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: AlertTone;
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const assertive = tone === "danger" || tone === "warning";

  return (
    <div
      className={["jc-alert", `jc-alert--${tone}`, className].filter(Boolean).join(" ")}
      role={assertive ? "alert" : "status"}
    >
      <span className="jc-alert-icon" aria-hidden="true">
        {GLYPH[tone]}
      </span>
      <div>
        {title ? <p className="jc-alert-title">{title}</p> : null}
        <div className="jc-alert-body">{children}</div>
      </div>
    </div>
  );
}
