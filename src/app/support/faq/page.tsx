import type { Metadata } from "next";
import Link from "next/link";

import { PublicShell } from "@/components/layout";
import { Card, CardContent, CardHeader } from "@/components/ui";
import { brand } from "@/config/brand";
import { getViewer } from "@/lib/auth/session";

export const metadata: Metadata = { title: "FAQ" };

const FAQ: { category: string; items: { q: string; a: string }[] }[] = [
  {
    category: "Trading",
    items: [
      { q: "How do I place an order?", a: "Open a market from the Trade screen, choose Buy or Sell, enter a price and amount, review the server-computed fee and reserve, and submit. Limit orders are supported." },
      { q: "Why can't I place a market order?", a: "Market orders need a connected execution venue. None is connected on this deployment, so the engine honestly refuses them and the option is shown as unavailable." },
      { q: "How are fees calculated?", a: "Fees come from the server fee schedule, not the browser. You see the exact fee before you commit." },
    ],
  },
  {
    category: "Deposits",
    items: [
      { q: "How do I deposit crypto?", a: "Choose an asset and network on the Deposit screen to see a deposit address. No custodian is connected on this deployment, so the address shown is a prototype and is not monitored." },
      { q: "When is a deposit credited?", a: "A real deposit is credited after the network's required confirmations. With no custodian connected, deposits are not detected or credited here." },
    ],
  },
  {
    category: "Withdrawals",
    items: [
      { q: "How do I withdraw?", a: "Enter an asset, network, destination and amount on the Withdraw screen. Your request is recorded with status Requested." },
      { q: "Why is my withdrawal still 'Requested'?", a: "No payout provider is connected, so requests are recorded for review and never completed automatically. Nothing is sent." },
    ],
  },
  {
    category: "Security",
    items: [
      { q: "How do I change my password?", a: "Use the password reset flow from Account → Security. You will receive a link by email." },
      { q: "Is two-factor authentication available?", a: "Not in this prototype. The interface is ready for it; an authenticator or SMS provider would be connected first." },
    ],
  },
  {
    category: "Account",
    items: [
      { q: "What are account tiers and limits?", a: "Your tier sets your operation limits, which are checked on the server for every operation. Your limits are shown on the dashboard." },
      { q: "How do I get verified?", a: "Verification is requested when an operation requires it. No KYC/AML provider is connected on this deployment, so verification cannot be started yet." },
    ],
  },
];

export default async function FaqPage() {
  const viewer = await getViewer();

  return (
    <PublicShell signedIn={Boolean(viewer)}>
      <div className="jc-container-text jc-section jc-stack-lg">
        <header>
          <p className="jc-eyebrow">Support</p>
          <h1 className="jc-h1" style={{ marginBlock: "var(--jc-space-3) var(--jc-space-3)" }}>
            Frequently asked questions
          </h1>
          <p className="jc-body">
            Answers reflect how {brand.name} behaves on this deployment. Still stuck?{" "}
            <Link href="/support/contact" className="jc-link">
              Contact support
            </Link>
            .
          </p>
        </header>

        {FAQ.map((section) => (
          <Card key={section.category}>
            <CardHeader title={section.category} />
            <CardContent>
              <div className="jc-stack-lg">
                {section.items.map((item) => (
                  <div key={item.q}>
                    <h3 className="jc-h5" style={{ marginBottom: "var(--jc-space-2)" }}>
                      {item.q}
                    </h3>
                    <p className="jc-sm">{item.a}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </PublicShell>
  );
}
