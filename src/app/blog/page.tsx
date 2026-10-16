import type { Metadata } from "next";

import { PublicShell } from "@/components/layout";
import { Card, CardContent, EmptyState } from "@/components/ui";
import { brand } from "@/config/brand";
import { getViewer } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: "Newsroom",
  description: `Announcements and updates from ${brand.name}.`,
};

export default async function BlogPage() {
  const viewer = await getViewer();

  return (
    <PublicShell signedIn={Boolean(viewer)}>
      <div className="jc-container-text jc-section jc-stack-lg">
        <header>
          <p className="jc-eyebrow">Newsroom</p>
          <h1 className="jc-h1" style={{ marginBlock: "var(--jc-space-3) var(--jc-space-3)" }}>
            {brand.name} newsroom
          </h1>
          <p className="jc-body">
            Product announcements, release notes and updates will appear here as they are published.
          </p>
        </header>

        <Card>
          <CardContent>
            <EmptyState
              title="No posts yet"
              description="There is nothing to read here yet. This is a prototype deployment, and we have not published any articles. Check back later."
            />
          </CardContent>
        </Card>
      </div>
    </PublicShell>
  );
}
