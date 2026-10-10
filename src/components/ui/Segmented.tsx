"use client";

import type { ReactNode } from "react";

/**
 * Segmented control — buy/sell, order type, market category.
 *
 * A row of buttons with `aria-pressed`, not a radio group: these switch what is
 * displayed rather than collect a value for submission, and `aria-pressed`
 * reads correctly for that. Where a segmented control really does pick a form
 * value, use radios instead.
 */

export type SegmentedOption<T extends string> = {
  value: T;
  label: ReactNode;
  /** Tints the active state for buy/sell. */
  side?: "buy" | "sell";
};

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  block = false,
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Names the group for assistive technology. */
  label: string;
  block?: boolean;
}) {
  return (
    <div
      className={["jc-segmented", block ? "jc-segmented--block" : null].filter(Boolean).join(" ")}
      role="group"
      aria-label={label}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="jc-segmented-item"
          data-side={option.side}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
