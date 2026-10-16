import type { Metadata } from "next";
import Link from "next/link";

import { PublicShell } from "@/components/layout";
import { Card, CardContent, CardHeader } from "@/components/ui";
import { brand } from "@/config/brand";
import { getViewer } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: `Terms of Service for ${brand.companyName}.`,
};

export default async function TermsPage() {
  const viewer = await getViewer();

  return (
    <PublicShell signedIn={Boolean(viewer)}>
      <div className="jc-container-text jc-section jc-stack-lg">
        <header>
          <p className="jc-eyebrow">Legal</p>
          <h1 className="jc-h1" style={{ marginBlock: "var(--jc-space-3) var(--jc-space-3)" }}>
            Terms of Service
          </h1>
          <p className="jc-body">
            These terms describe the use of the {brand.companyName} product. Please read them
            alongside the{" "}
            <Link href="/privacy" className="jc-link">
              Privacy Policy
            </Link>{" "}
            and{" "}
            <Link href="/risk" className="jc-link">
              Risk Disclosure
            </Link>
            .
          </p>
        </header>

        <Card>
          <CardHeader title="Prototype notice" />
          <CardContent>
            <p className="jc-sm">
              This is a prototype and demonstration deployment. It is not a real contract, not an
              offer of services, and creates no legal or financial obligation. No live trading,
              custody or fiat providers are connected, and no real funds are involved. Do not rely on
              this product for any actual transaction.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="Use of the service" />
          <CardContent>
            <p className="jc-sm">
              You agree to use {brand.companyName} only for lawful, demonstration purposes and not to
              attempt to disrupt, probe or misuse the system. You are responsible for keeping your
              account credentials confidential and for activity under your account.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="No warranty" />
          <CardContent>
            <p className="jc-sm">
              The product is provided &ldquo;as is&rdquo;, without warranties of any kind. It may be
              incomplete, change without notice, or be taken offline at any time. Data entered may be
              reset or removed.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="Limitation of liability" />
          <CardContent>
            <p className="jc-sm">
              To the extent permitted by law, {brand.companyName} is not liable for any loss arising
              from use of this prototype. Because no real transactions occur, no financial loss can
              result from using the product as intended.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader title="Changes" />
          <CardContent>
            <p className="jc-sm">
              These terms may change as the prototype evolves. Continued use after a change means you
              accept the updated terms.
            </p>
          </CardContent>
        </Card>
      </div>
    </PublicShell>
  );
}
