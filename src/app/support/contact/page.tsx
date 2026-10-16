import type { Metadata } from "next";
import Link from "next/link";

import { PublicShell } from "@/components/layout";
import { Card, CardContent, CardHeader } from "@/components/ui";
import { brand } from "@/config/brand";
import { getViewer } from "@/lib/auth/session";

import { ContactForm } from "./ContactForm";

export const metadata: Metadata = { title: "Contact support" };

export default async function ContactPage() {
  const viewer = await getViewer();

  return (
    <PublicShell signedIn={Boolean(viewer)}>
      <div className="jc-container-text jc-section jc-stack-lg">
        <header>
          <Link href="/support" className="jc-link jc-sm">
            ← Support
          </Link>
          <h1 className="jc-h1" style={{ marginBlock: "var(--jc-space-4) var(--jc-space-3)" }}>
            Contact support
          </h1>
          <p className="jc-body">
            Send us a message and we will get back to you. You can also email{" "}
            <a href={`mailto:${brand.supportEmail}`} className="jc-link">
              {brand.supportEmail}
            </a>
            .
          </p>
        </header>

        <Card>
          <CardHeader title="Send a message" />
          <CardContent>
            <ContactForm />
          </CardContent>
        </Card>
      </div>
    </PublicShell>
  );
}
