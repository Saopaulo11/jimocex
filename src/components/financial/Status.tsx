import { Badge, type BadgeTone } from "@/components/ui/Badge";
import type { Database } from "@/lib/db/database";

/**
 * Status presentation (spec §24, §37).
 *
 * The mapping from a database enum to a tone and a human label lives here and
 * only here, so a withdrawal shows the same word in the dashboard, the admin
 * queue and a notification.
 *
 * The labels are written for a customer, not lifted from the enum: "PENDING_REVIEW"
 * is a column value, "Under review" is a sentence a person can act on.
 */

type Enums = Database["public"]["Enums"];

function describe<T extends string>(
  map: Record<T, { label: string; tone: BadgeTone; glyph?: string | null }>,
  value: T,
) {
  return map[value] ?? { label: String(value).replaceAll("_", " "), tone: "neutral" as BadgeTone };
}

const WITHDRAWAL: Record<Enums["withdrawal_status"], { label: string; tone: BadgeTone }> = {
  REQUESTED: { label: "Requested", tone: "info" },
  PENDING_REVIEW: { label: "Under review", tone: "warning" },
  APPROVED: { label: "Approved", tone: "info" },
  PROCESSING: { label: "Processing", tone: "info" },
  COMPLETED: { label: "Completed", tone: "success" },
  FAILED: { label: "Failed", tone: "danger" },
  REJECTED: { label: "Rejected", tone: "danger" },
  HELD: { label: "On hold", tone: "warning" },
};

const DEPOSIT: Record<Enums["deposit_status"], { label: string; tone: BadgeTone }> = {
  DETECTED: { label: "Detected", tone: "info" },
  CONFIRMING: { label: "Confirming", tone: "info" },
  CONFIRMED: { label: "Confirmed", tone: "info" },
  CREDITED: { label: "Credited", tone: "success" },
  REJECTED: { label: "Rejected", tone: "danger" },
};

const ORDER: Record<Enums["order_status"], { label: string; tone: BadgeTone }> = {
  PENDING: { label: "Pending", tone: "info" },
  OPEN: { label: "Open", tone: "info" },
  PARTIALLY_FILLED: { label: "Partially filled", tone: "info" },
  FILLED: { label: "Filled", tone: "success" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
  REJECTED: { label: "Rejected", tone: "danger" },
  EXPIRED: { label: "Expired", tone: "neutral" },
};

const SWAP: Record<Enums["swap_order_status"], { label: string; tone: BadgeTone }> = {
  CREATED: { label: "Created", tone: "info" },
  CONFIRMED: { label: "Confirmed", tone: "info" },
  PROCESSING: { label: "Processing", tone: "info" },
  COMPLETED: { label: "Completed", tone: "success" },
  FAILED: { label: "Failed", tone: "danger" },
  EXPIRED: { label: "Expired", tone: "neutral" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

const KYC: Record<Enums["kyc_status"], { label: string; tone: BadgeTone }> = {
  NOT_STARTED: { label: "Not started", tone: "neutral" },
  PENDING: { label: "Pending", tone: "info" },
  IN_REVIEW: { label: "In review", tone: "warning" },
  VERIFIED: { label: "Verified", tone: "success" },
  REJECTED: { label: "Rejected", tone: "danger" },
  EXPIRED: { label: "Expired", tone: "warning" },
};

const ACCOUNT: Record<Enums["account_status"], { label: string; tone: BadgeTone }> = {
  ACTIVE: { label: "Active", tone: "success" },
  RESTRICTED: { label: "Restricted", tone: "warning" },
  SUSPENDED: { label: "Suspended", tone: "danger" },
  FROZEN: { label: "Frozen", tone: "danger" },
  CLOSED: { label: "Closed", tone: "neutral" },
};

export function WithdrawalStatus({ status }: { status: Enums["withdrawal_status"] }) {
  const { label, tone } = describe(WITHDRAWAL, status);
  return <Badge tone={tone}>{label}</Badge>;
}

export function DepositStatus({ status }: { status: Enums["deposit_status"] }) {
  const { label, tone } = describe(DEPOSIT, status);
  return <Badge tone={tone}>{label}</Badge>;
}

export function OrderStatus({ status }: { status: Enums["order_status"] }) {
  const { label, tone } = describe(ORDER, status);
  return <Badge tone={tone}>{label}</Badge>;
}

export function SwapStatus({ status }: { status: Enums["swap_order_status"] }) {
  const { label, tone } = describe(SWAP, status);
  return <Badge tone={tone}>{label}</Badge>;
}

export function KycStatus({ status }: { status: Enums["kyc_status"] }) {
  const { label, tone } = describe(KYC, status);
  return <Badge tone={tone}>{label}</Badge>;
}

export function AccountStatus({ status }: { status: Enums["account_status"] }) {
  const { label, tone } = describe(ACCOUNT, status);
  return <Badge tone={tone}>{label}</Badge>;
}

/**
 * Account tier (spec §37).
 *
 * The wording here is load-bearing. "Email registration" describes what the
 * tier is; "Anonymous" or "No KYC required" would describe it as a way around
 * verification, which it is not — risk and compliance can require verification
 * at any point regardless of tier.
 */
export function AccountTier({ code, name }: { code: string; name?: string }) {
  const display = name ?? code.replace("_", " ");
  return (
    <Badge tone="gold" glyph={null}>
      <span className="jc-sr-only">Account tier: </span>
      {display}
    </Badge>
  );
}

export function EmailVerification({ verified }: { verified: boolean }) {
  return verified ? (
    <Badge tone="success">Email verified</Badge>
  ) : (
    <Badge tone="warning">Email not confirmed</Badge>
  );
}
