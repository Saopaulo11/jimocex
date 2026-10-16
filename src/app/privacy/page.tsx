import type { Metadata } from "next";

import { PublicShell } from "@/components/layout";
import { Card, CardContent, CardHeader } from "@/components/ui";
import { brand } from "@/config/brand";
import { getViewer } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: `Privacy Policy for ${brand.companyName}.`,
};

export default async function PrivacyPage() {
  const viewer = await getViewer();

  return (
    <PublicShell signedIn={Boolean(viewer)}>
      <div className="jc-container-text jc-section jc-stack-lg">
        <header>
          <p className="jc-eyebrow">Legal</p>
          <h1 className="jc-h1" style={{ marginBlock: "var(--jc-space-3) var(--jc-space-3)" }}>
            Privacy Policy
          </h1>
          <p className="jc-body">
            This policy explains what information {brand.companyName} handles and how it is used.
          </p>
        </header>

        <Card>
          <CardHeader title="Prototype notice" />
          <CardContent>
            <p className="jc-sm">
              This is a prototype and demonstration deployment. Please do not enter real, sensitive
              or personally important information. Data you provide may be reset or removed at any
              time, and no real financial activity takes place.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="What we collect" />
          <CardContent>
            <p className="jc-sm">
              To run the product we store the account details you provide, such as your email
              address, and a record of the actions you take in the interface — for example orders
              placed and withdrawal requests recorded. We do not collect more than is needed to
              demonstrate how the product behaves.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="How we use it" />
          <CardContent>
            <p className="jc-sm">
              Information is used only to operate your account and the demonstration: signing you in,
              enforcing limits, and showing your balances and history. It is not sold, and no
              advertising or third-party analytics providers are connected on this deployment.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="Data retention" />
          <CardContent>
            <p className="jc-sm">
              Because this is a prototype, data may be cleared periodically and is not guaranteed to
              persist. You should not treat anything stored here as a durable record.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="Contact" />
          <CardContent>
            <p className="jc-sm">
              Questions about this policy can be sent to {brand.supportEmail}.
            </p>
          </CardContent>
        </Card>
      </div>
    </PublicShell>
  );
}
