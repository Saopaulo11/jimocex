"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

/**
 * Account menu in the header.
 *
 * A details/summary disclosure would be simpler, but it cannot be dismissed by
 * clicking away or by Escape, which is what people expect from a menu. This is
 * small enough to do properly.
 *
 * Sign-out is a form posting to a Server Action, not a link: signing out is a
 * state change, and a GET that mutates state can be triggered by a prefetch.
 */
export function AccountMenu({
  email,
  tierLabel,
  signOutAction,
}: {
  email: string;
  tierLabel: string;
  signOutAction: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={container} style={{ position: "relative" }}>
      <button
        type="button"
        className="jc-btn jc-btn--tertiary jc-btn--sm"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span
          aria-hidden="true"
          style={{
            width: 20,
            height: 20,
            display: "grid",
            placeItems: "center",
            borderRadius: "50%",
            background: "var(--jc-gold-soft)",
            color: "var(--jc-gold)",
            fontSize: 10,
            fontWeight: 600,
          }}
        >
          {email.slice(0, 1).toUpperCase()}
        </span>
        <span className="jc-sr-only">Account menu for {email}</span>
        <span aria-hidden="true">▾</span>
      </button>

      {open ? (
        <div
          role="menu"
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 8px)",
            zIndex: "var(--jc-z-dropdown)" as unknown as number,
            minWidth: 240,
            background: "var(--jc-surface-elevated)",
            border: "1px solid var(--jc-border-strong)",
            borderRadius: "var(--jc-radius-lg)",
            boxShadow: "var(--jc-shadow-lg)",
            overflow: "hidden",
          }}
        >
          <div style={{ padding: "var(--jc-space-4)", borderBottom: "1px solid var(--jc-border)" }}>
            <p style={{ fontSize: "var(--jc-text-sm)", wordBreak: "break-all" }}>{email}</p>
            <p className="jc-caption" style={{ marginTop: 4 }}>
              {tierLabel}
            </p>
          </div>

          <div style={{ padding: "var(--jc-space-2)" }}>
            <Link
              href="/dashboard"
              role="menuitem"
              className="jc-navlink"
              style={{ display: "block" }}
              onClick={() => setOpen(false)}
            >
              Overview
            </Link>
            <span className="jc-navlink" role="menuitem" aria-disabled="true" style={{ display: "block" }}>
              Account settings
            </span>
          </div>

          <form action={signOutAction} style={{ padding: "var(--jc-space-2)", borderTop: "1px solid var(--jc-border)" }}>
            <button type="submit" role="menuitem" className="jc-navlink" style={{ width: "100%", textAlign: "left", background: "none", border: 0, cursor: "pointer" }}>
              Sign out
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
