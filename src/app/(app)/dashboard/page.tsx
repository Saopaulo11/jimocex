import type { Metadata } from "next";

import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Dashboard" };

const WINDOW_LABEL: Record<string, string> = {
  SINGLE: "Per transaction",
  DAILY: "Per day",
  MONTHLY: "Per month",
};

const OPERATION_LABEL: Record<string, string> = {
  SWAP: "Exchange",
  TRADE: "Trade",
  CRYPTO_DEPOSIT: "Crypto deposit",
  CRYPTO_WITHDRAWAL: "Crypto withdrawal",
  FIAT_DEPOSIT: "Fiat deposit",
  FIAT_WITHDRAWAL: "Fiat withdrawal",
};

export default async function DashboardPage() {
  const viewer = await requireUser();
  const supabase = await createClient();

  // Read through the user-scoped client: RLS confirms these rows are theirs,
  // rather than this page trusting the id it was handed.
  const [{ data: tier }, { data: limits }, { data: wallets }] = await Promise.all([
    supabase
      .from("account_tiers")
      .select("code, name, description, requires_kyc")
      .eq("code", viewer.profile.tier_code)
      .single(),
    supabase
      .from("tier_limits")
      .select("operation, window_kind, quote_currency, max_amount, min_amount")
      .eq("tier_code", viewer.profile.tier_code)
      .eq("is_active", true),
    supabase.from("wallets").select("id, available_balance, locked_balance"),
  ]);

  const hasBalances = (wallets ?? []).some(
    (w) => Number(w.available_balance) !== 0 || Number(w.locked_balance) !== 0,
  );

  return (
    <div className="jc-container jc-stack" style={{ gap: 24 }}>
      <div>
        <p className="jc-eyebrow">Overview</p>
        <h1 style={{ fontSize: "1.75rem", marginTop: 8 }}>
          {viewer.profile.display_name ?? viewer.email}
        </h1>
      </div>

      {!viewer.emailVerified ? (
        <div className="jc-alert jc-alert-info" role="status">
          <span>
            Your email address is not confirmed yet. Operations that require a verified address
            will ask for it first.
          </span>
        </div>
      ) : null}

      {viewer.profile.status !== "ACTIVE" ? (
        <div className="jc-alert jc-alert-error" role="alert">
          <span>
            This account is <strong>{viewer.profile.status}</strong>. Financial operations are
            restricted. Please contact support.
          </span>
        </div>
      ) : null}

      <section className="jc-card">
        <div className="jc-row-between" style={{ marginBottom: 12 }}>
          <h2 style={{ fontSize: "1.125rem" }}>Account tier</h2>
          <span className="jc-badge jc-badge-gold">{tier?.name ?? viewer.profile.tier_code}</span>
        </div>
        {tier?.description ? (
          <p style={{ color: "var(--jc-text-secondary)", fontSize: "0.9375rem" }}>
            {tier.description}
          </p>
        ) : null}
        <p className="jc-muted" style={{ marginTop: 12 }}>
          Verification status: {viewer.profile.kyc_status.replaceAll("_", " ").toLowerCase()}
        </p>
      </section>

      <section className="jc-card">
        <h2 style={{ fontSize: "1.125rem", marginBottom: 4 }}>Balances</h2>
        {/* No wallet row means no funds, and that is said plainly rather than
            shown as a fabricated zero portfolio with a currency symbol. */}
        <p style={{ color: "var(--jc-text-secondary)", fontSize: "0.9375rem" }}>
          {hasBalances
            ? "Your balances are shown in Wallets."
            : "No funds yet. Deposits are not available on this deployment — no crypto or fiat provider is connected."}
        </p>
      </section>

      <section className="jc-card">
        <h2 style={{ fontSize: "1.125rem", marginBottom: 12 }}>Your limits</h2>
        {limits && limits.length > 0 ? (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
              <caption className="jc-sr-only">
                Limits for your account tier, by operation and window
              </caption>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--jc-text-muted)" }}>
                  <th scope="col" style={{ padding: "8px 12px 8px 0", fontWeight: 500 }}>
                    Operation
                  </th>
                  <th scope="col" style={{ padding: "8px 12px", fontWeight: 500 }}>
                    Window
                  </th>
                  <th scope="col" style={{ padding: "8px 0 8px 12px", fontWeight: 500, textAlign: "right" }}>
                    Maximum
                  </th>
                </tr>
              </thead>
              <tbody>
                {limits.map((limit, index) => (
                  <tr
                    key={`${limit.operation}-${limit.window_kind}`}
                    style={{ borderTop: index === 0 ? "none" : "1px solid var(--jc-border)" }}
                  >
                    <td style={{ padding: "10px 12px 10px 0" }}>
                      {OPERATION_LABEL[limit.operation] ?? limit.operation}
                    </td>
                    <td style={{ padding: "10px 12px", color: "var(--jc-text-secondary)" }}>
                      {WINDOW_LABEL[limit.window_kind] ?? limit.window_kind}
                    </td>
                    <td className="jc-numeric" style={{ padding: "10px 0 10px 12px", textAlign: "right" }}>
                      {limit.max_amount === null
                        ? "By arrangement"
                        : `${formatAmount(limit.max_amount)} ${limit.quote_currency}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="jc-muted">No limits are configured for this tier.</p>
        )}
        <p className="jc-muted" style={{ marginTop: 14 }}>
          Limits are checked on the server for every operation. Risk and compliance rules may
          require verification before these figures are reached.
        </p>
      </section>
    </div>
  );
}

/** Thousands separators without the float round-trip `toLocaleString` implies. */
function formatAmount(value: string | number): string {
  const [whole = "0"] = String(value).split(".");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
