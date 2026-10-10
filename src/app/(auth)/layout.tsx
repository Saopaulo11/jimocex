import Link from "next/link";

import { JimoCexLogo } from "@/components/JimoCexLogo";

/**
 * Shell for every authentication screen. Centred card on a navy field with a
 * single soft gold wash — the brand's only decoration on these pages, because
 * a sign-in form is a place for confidence, not ornament.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="jc-auth">
      <div className="jc-auth-card">
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 28 }}>
          <Link href="/" aria-label="JimoCex home">
            <JimoCexLogo size={30} showTagline />
          </Link>
        </div>
        {children}
      </div>
    </main>
  );
}
