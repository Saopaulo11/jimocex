"use client";

import { useEffect, useState } from "react";

import { Alert, Button, LinkButton, Segmented, Select } from "@/components/ui";

/**
 * Settings (prototype).
 *
 * Preferences persist to `localStorage` — a per-viewer convenience on this
 * device, never authoritative state, and it says so. There is no settings table
 * and no notification provider on this deployment, so these choices are stored
 * for when one is connected rather than taking effect server-side. Security and
 * API settings link to where they actually live.
 */

type Tab = "general" | "notifications" | "preferences" | "security" | "api";

type Settings = {
  language: string;
  timezone: string;
  notifyEmailSecurity: boolean;
  notifyEmailProduct: boolean;
  groupThousands: boolean;
  compactTables: boolean;
};

const DEFAULTS: Settings = {
  language: "en",
  timezone: "UTC",
  notifyEmailSecurity: true,
  notifyEmailProduct: false,
  groupThousands: true,
  compactTables: false,
};

const KEY = "jimocex.settings";

export function SettingsPanel() {
  const [tab, setTab] = useState<Tab>("general");
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [saved, setSaved] = useState(false);

  // Deferred out of the synchronous effect body (lint + no hydration mismatch).
  useEffect(() => {
    let active = true;
    const id = setTimeout(() => {
      if (!active) return;
      try {
        const raw = window.localStorage.getItem(KEY);
        if (raw) setSettings({ ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) });
      } catch {
        /* ignore */
      }
    }, 0);
    return () => {
      active = false;
      clearTimeout(id);
    };
  }, []);

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const save = () => {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(settings));
      setSaved(true);
    } catch {
      setSaved(false);
    }
  };

  return (
    <div className="jc-stack-lg">
      <Segmented<Tab>
        label="Settings section"
        options={[
          { value: "general", label: "General" },
          { value: "notifications", label: "Notifications" },
          { value: "preferences", label: "Preferences" },
          { value: "security", label: "Security" },
          { value: "api", label: "API" },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "general" ? (
        <div className="jc-stack-lg" style={{ maxWidth: 420 }}>
          <Select id="set-language" label="Language" value={settings.language} onChange={(e) => update("language", e.target.value)}>
            <option value="en">English</option>
            <option value="pt">Português</option>
            <option value="ru">Русский</option>
            <option value="es">Español</option>
          </Select>
          <Select id="set-timezone" label="Timezone" value={settings.timezone} onChange={(e) => update("timezone", e.target.value)}>
            <option value="UTC">UTC</option>
            <option value="America/Sao_Paulo">America/São Paulo</option>
            <option value="Europe/Moscow">Europe/Moscow</option>
            <option value="Europe/London">Europe/London</option>
          </Select>
          <p className="jc-caption">
            Timestamps are shown in UTC in this prototype regardless of this choice; full localization is not enabled.
          </p>
          <SaveRow onSave={save} saved={saved} />
        </div>
      ) : null}

      {tab === "notifications" ? (
        <div className="jc-stack-lg" style={{ maxWidth: 480 }}>
          <Toggle label="Security emails" hint="Sign-ins, password changes and withdrawals." checked={settings.notifyEmailSecurity} onChange={(v) => update("notifyEmailSecurity", v)} />
          <Toggle label="Product updates" hint="Occasional news about new features." checked={settings.notifyEmailProduct} onChange={(v) => update("notifyEmailProduct", v)} />
          <Alert tone="info" title="No notification provider is connected">
            These preferences are stored on this device for when an email or push provider is connected. Nothing is
            dispatched in this prototype.
          </Alert>
          <SaveRow onSave={save} saved={saved} />
        </div>
      ) : null}

      {tab === "preferences" ? (
        <div className="jc-stack-lg" style={{ maxWidth: 480 }}>
          <Toggle label="Group thousands" hint="Show 1,000,000 rather than 1000000." checked={settings.groupThousands} onChange={(v) => update("groupThousands", v)} />
          <Toggle label="Compact tables" hint="Denser rows in long tables." checked={settings.compactTables} onChange={(v) => update("compactTables", v)} />
          <p className="jc-caption">Display preferences are saved on this device.</p>
          <SaveRow onSave={save} saved={saved} />
        </div>
      ) : null}

      {tab === "security" ? (
        <div className="jc-stack">
          <p className="jc-sm">Password, two-factor and sessions are managed in your account.</p>
          <div>
            <LinkButton href="/account/security" variant="secondary" size="sm">
              Open security settings
            </LinkButton>
          </div>
        </div>
      ) : null}

      {tab === "api" ? (
        <div className="jc-stack">
          <p className="jc-sm">Programmatic access keys are managed in your account.</p>
          <div>
            <LinkButton href="/account/api-keys" variant="secondary" size="sm">
              Open API keys
            </LinkButton>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SaveRow({ onSave, saved }: { onSave: () => void; saved: boolean }) {
  return (
    <div className="jc-row" style={{ gap: "var(--jc-space-4)", alignItems: "center" }}>
      <Button variant="primary" size="sm" onClick={onSave}>
        Save
      </Button>
      {saved ? <span className="jc-sm" style={{ color: "var(--jc-success)" }}>Saved on this device</span> : null}
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="jc-row-between" style={{ gap: "var(--jc-space-4)", cursor: "pointer" }}>
      <span>
        <span style={{ display: "block", fontWeight: 500, fontSize: "var(--jc-text-sm)" }}>{label}</span>
        {hint ? <span className="jc-caption">{hint}</span> : null}
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ width: 18, height: 18, accentColor: "var(--jc-gold)" }} />
    </label>
  );
}
