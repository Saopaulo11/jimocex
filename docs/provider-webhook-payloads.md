# Provider webhooks: storing the raw payload

Status: requirements and proposed design. No provider is connected; nothing here is implemented.

## The problem with the current table

`provider_events` keeps `payload_hash` ("SHA-256 of the raw body") and `payload jsonb`. Neither holds
the body that was signed:

- `jsonb` normalises its input — key order, duplicate keys and whitespace are gone — so the stored
  document cannot be re-hashed to `payload_hash`, and a signature cannot be re-verified later;
- if the handler builds `payload` from `await request.json()`, every amount in it has already been
  through a JavaScript double (`1234567890123456.123456789012345678` becomes `1234567890123456`).

## Requirements

1. **Verify before parsing.** Read the body as bytes (`await request.arrayBuffer()`), verify the
   provider's signature over exactly those bytes, then parse. Never `request.json()`.
2. **Parse exactly.** Decode with `parseJsonExact()` (src/lib/money.ts): every number arrives as a
   `DecimalString` with its exact digits. Check each figure with `asDecimalString()`.
3. **Store the bytes.** Keep the raw body so the signature and hash can be re-checked by an auditor,
   and derive everything else from it in the database, not in JavaScript.
4. **Replay protection.** `(provider, event_id)` is already unique; also reject a delivery whose
   signed timestamp is outside the provider's tolerance window (typically 5 minutes).
5. **Bounded size.** Refuse bodies over a fixed limit (e.g. 256 KiB) before reading them fully.
6. **Sensitive data.** Payloads can carry names, addresses, IBANs, card fragments and KYC results.
   - The raw body is readable by no client role: RLS on, no policy for `anon`/`authenticated`,
     no grant beyond `service_role`, read only by the handler and an audited operator path.
   - Extract into normalised columns only what processing needs; nothing else is copied around.
   - Never log the raw body or its parsed form; log `provider`, `event_id`, `payload_sha256`.
7. **Retention.** Keep the raw body for the dispute/chargeback window (proposed: 180 days, configurable
   per provider), then purge it, keeping `payload_sha256`, the signature result, the normalised fields
   and the ledger entries it produced. Financial records themselves (ledger, deposits, withdrawals)
   are retained under the platform's record-keeping policy, independently of the raw payload.

## Proposed schema change (for the phase that connects the first provider)

```sql
alter table public.provider_events
  add column payload_raw    bytea,            -- the signed bytes, exactly as received
  add column payload_purged_at timestamptz,   -- set when the retention window expires
  add constraint provider_events_raw_or_purged check ((payload_raw is null) = (payload_purged_at is not null)),
  -- The stored bytes are the hashed bytes.
  add constraint provider_events_hash_matches check (
    payload_raw is null or payload_hash = encode(sha256(payload_raw), 'hex')
  );
-- payload jsonb stays, filled in SQL from the bytes (convert_from(payload_raw, 'UTF8')::jsonb),
-- which keeps every digit; it is read back as text (JSON_COLUMNS) and parsed with parseJsonExact().
```

Plus: a service-role-only RPC that inserts an event from `(provider, event_id, event_type, raw bytes,
signature_valid)` and derives `payload_hash` and `payload` itself, so the handler never sends a parsed
document at all; and a scheduled purge (`payload_raw = null, payload_purged_at = now()` past the
window), itself recorded in `audit_logs`.
