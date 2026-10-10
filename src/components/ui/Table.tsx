import type { ReactNode } from "react";

/**
 * Financial table (spec §23).
 *
 * One rule carries most of the value: numeric columns are right-aligned with
 * tabular figures, so decimal points stack and magnitudes can be compared by
 * eye. A left-aligned price column is the fastest way to make a market table
 * unreadable.
 *
 * The wrapper scrolls horizontally rather than the page, so a wide table stays
 * usable on a phone without the whole layout shifting sideways.
 */

export function Table({
  caption,
  children,
  className,
}: {
  /** Describes the table for screen readers; visually hidden. */
  caption: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="jc-table-wrap">
      <table className={["jc-table", className].filter(Boolean).join(" ")}>
        <caption className="jc-sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}

export type SortDirection = "ascending" | "descending";

export function Th({
  children,
  numeric = false,
  sortable = false,
  sortDirection,
  onSort,
  scope = "col",
}: {
  children: ReactNode;
  numeric?: boolean;
  sortable?: boolean;
  /** Present only on the column currently sorted. */
  sortDirection?: SortDirection;
  onSort?: () => void;
  scope?: "col" | "row";
}) {
  return (
    <th
      scope={scope}
      className={numeric ? "jc-th--num" : undefined}
      // aria-sort belongs on the header cell, and only on the sorted one.
      aria-sort={sortable ? (sortDirection ?? "none") : undefined}
    >
      {sortable ? (
        <button type="button" className="jc-th-sort" onClick={onSort}>
          {children}
          <span aria-hidden="true">
            {sortDirection === "ascending" ? "▲" : sortDirection === "descending" ? "▼" : "⇅"}
          </span>
        </button>
      ) : (
        children
      )}
    </th>
  );
}

export function Td({
  children,
  numeric = false,
  className,
}: {
  children: ReactNode;
  numeric?: boolean;
  className?: string;
}) {
  return (
    <td className={[numeric ? "jc-num" : null, className].filter(Boolean).join(" ") || undefined}>
      {children}
    </td>
  );
}

/**
 * A full-width row for an empty, loading or error state, so the table keeps its
 * header and its shape instead of collapsing when there is nothing to show.
 */
export function TableStateRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} style={{ padding: 0 }}>
        {children}
      </td>
    </tr>
  );
}
