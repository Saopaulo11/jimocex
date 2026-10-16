import type { Metadata } from "next";
import Link from "next/link";

import { PublicShell } from "@/components/layout";
import { Card, CardContent, LinkButton } from "@/components/ui";
import { brand } from "@/config/brand";
import { getViewer } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: "Support",
  description: `Help and support for ${brand.name}.`,
};

const TOPICS = [
  { title: "Trading", body: "Placing and cancelling orders, limits and fees." },
  { title: "Deposits", body: "Receiving crypto and deposit addresses." },
  { title: "Withdrawals", body: "Sending crypto and request status." },
  { title: "Security", body: "Passwords, two-factor and sessions." },
  { title: "Account", body: "Verification, tiers and settings." },
];

export default async function SupportPage() {
  const viewer = await getViewer();

  return (
    <PublicShell signedIn={Boolean(viewer)}>
      <div className="jc-container jc-section jc-stack-lg">
        <header style={{ maxWidth: "60ch" }}>
          <p className="jc-eyebrow">Support</p>
          <h1 className="jc-h1" style={{ marginBlock: "var(--jc-space-3) var(--jc-space-4)" }}>
            How can we help?
          </h1>
          <p className="jc-body-lg">
            Browse common questions, or send us a message and we will get back to you.
          </p>
        </header>

        <div className="jc-row jc-row-wrap" style={{ gap: "var(--jc-space-3)" }}>
          <LinkButton href="/support/faq" variant="primary" size="md">
            Browse FAQ
          </LinkButton>
          <LinkButton href="/support/contact" variant="secondary" size="md">
            Contact support
          </LinkButton>
        </div>

        <div className="jc-grid jc-grid-3">
          {TOPICS.map((topic) => (
            <Card key={topic.title}>
              <CardContent>
                <h2 className="jc-h4">{topic.title}</h2>
                <p className="jc-caption" style={{ marginTop: "var(--jc-space-2)" }}>
                  {topic.body}
                </p>
                <p style={{ marginTop: "var(--jc-space-4)" }}>
                  <Link href="/support/faq" className="jc-link jc-sm">
                    Read more →
                  </Link>
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </PublicShell>
  );
}
