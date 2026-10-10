import type { ReactNode } from "react";

/**
 * Card (spec §22).
 *
 * Used to group related information, not to decorate it. A page where every
 * element is a card has no hierarchy — the border stops meaning "these things
 * belong together" and starts meaning nothing.
 */

type CardVariant = "default" | "elevated" | "outlined" | "interactive";

export function Card({
  variant = "default",
  className,
  children,
  as: Tag = "section",
  ...rest
}: {
  variant?: CardVariant;
  className?: string;
  children: ReactNode;
  as?: "section" | "div" | "article";
} & React.HTMLAttributes<HTMLElement>) {
  const cls = [
    "jc-card",
    variant !== "default" ? `jc-card--${variant}` : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Tag className={cls} {...rest}>
      {children}
    </Tag>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
  as: Heading = "h2",
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  as?: "h2" | "h3";
}) {
  return (
    <div className="jc-card-header">
      <div>
        <Heading className="jc-card-title">{title}</Heading>
        {subtitle ? <p className="jc-card-subtitle">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function CardContent({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={["jc-card-content", className].filter(Boolean).join(" ")}>{children}</div>;
}

export function CardFooter({ children }: { children: ReactNode }) {
  return <div className="jc-card-footer">{children}</div>;
}
