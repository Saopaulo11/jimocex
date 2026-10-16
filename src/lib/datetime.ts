/**
 * Timestamp formatting for display.
 *
 * Rendered in UTC on purpose: a server component and a reader in another time
 * zone must agree on the text, and "2026-03-15 12:00 UTC" is unambiguous where a
 * locale-formatted string would drift between the two. A missing or invalid
 * timestamp becomes a dash, never "Invalid Date".
 */

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().slice(0, 10);
}
