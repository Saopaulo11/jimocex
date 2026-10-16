import Link from "next/link";

/** A truncated monospace id with the full value on hover; optionally a link. */
export function MonoId({ id, href }: { id: string; href?: string }) {
  const short = id.length > 12 ? `${id.slice(0, 8)}…` : id;
  const inner = (
    <span className="jc-numeric jc-caption" title={id}>
      {short}
    </span>
  );
  return href ? (
    <Link href={href} className="jc-link">
      {inner}
    </Link>
  ) : (
    inner
  );
}
