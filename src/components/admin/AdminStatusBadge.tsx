import { Badge, type BadgeTone } from "@/components/ui";

/**
 * A status pill for the operator tables, keyed by the raw enum string. Keeps
 * the admin reads string-typed while still colouring known statuses. Anything
 * unrecognised shows neutral with its words spaced out.
 */
const TONES: Record<string, BadgeTone> = {
  // success
  ACTIVE: "success",
  FILLED: "success",
  COMPLETED: "success",
  CREDITED: "success",
  VERIFIED: "success",
  APPROVED: "info",
  // info / in-flight
  OPEN: "info",
  PENDING: "info",
  PARTIALLY_FILLED: "info",
  REQUESTED: "info",
  PROCESSING: "info",
  CONFIRMING: "info",
  CONFIRMED: "info",
  DETECTED: "info",
  CREATED: "info",
  IN_REVIEW: "warning",
  PENDING_REVIEW: "warning",
  // warning
  RESTRICTED: "warning",
  HELD: "warning",
  NOT_STARTED: "neutral",
  // danger
  SUSPENDED: "danger",
  FROZEN: "danger",
  REJECTED: "danger",
  FAILED: "danger",
  // neutral
  CANCELLED: "neutral",
  EXPIRED: "neutral",
  CLOSED: "neutral",
};

function humanize(value: string): string {
  return value
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

export function AdminStatusBadge({ value }: { value: string }) {
  return (
    <Badge tone={TONES[value] ?? "neutral"} glyph={null}>
      {humanize(value)}
    </Badge>
  );
}
