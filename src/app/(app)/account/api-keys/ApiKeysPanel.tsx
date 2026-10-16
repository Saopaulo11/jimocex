"use client";

import { useState } from "react";

import { Alert, Button } from "@/components/ui";

/**
 * API keys (prototype).
 *
 * A generated key is shown once and is NEVER stored — not in the database, not
 * in the browser. There is no API-key backend in this prototype, so the key is
 * a demonstration of the flow (generate → copy once → warning), not a working
 * credential. This is deliberate: storing a real secret needs a schema and
 * hashing that this deployment does not have, and the brief forbids inventing
 * one.
 */
function randomKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `jcx_demo_${hex}`;
}

export function ApiKeysPanel() {
  const [key, setKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const create = () => {
    setKey(randomKey());
    setCopied(false);
  };

  const copy = async () => {
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="jc-stack-lg">
      <div className="jc-row-between jc-row-wrap">
        <p className="jc-sm" style={{ maxWidth: "52ch" }}>
          Create a prototype API key to see the flow. The key is shown once and is not stored anywhere.
        </p>
        <Button variant="primary" size="sm" onClick={create}>
          Create prototype key
        </Button>
      </div>

      {key ? (
        <div className="jc-stack">
          <span className="jc-label">Your new key (shown once)</span>
          <div className="jc-address">
            <code className="jc-address-value">{key}</code>
            <Button type="button" variant="tertiary" size="sm" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <Alert tone="warning" title="Prototype key — not a working credential">
            This key is generated in your browser for demonstration and is stored nowhere. It will not authenticate
            against any API, and it cannot be recovered once you leave this page.
          </Alert>
          <div>
            <Button type="button" variant="ghost" size="sm" onClick={() => setKey(null)}>
              Done
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
