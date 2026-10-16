import type { Metadata } from "next";

import { Card, CardContent } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";

import { SettingsPanel } from "./SettingsPanel";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  await requireUser();

  return (
    <div className="jc-container jc-stack-lg">
      <header>
        <p className="jc-eyebrow">Settings</p>
        <h1 className="jc-h2" style={{ marginTop: "var(--jc-space-3)" }}>
          Preferences
        </h1>
      </header>

      <Card>
        <CardContent>
          <SettingsPanel />
        </CardContent>
      </Card>
    </div>
  );
}
