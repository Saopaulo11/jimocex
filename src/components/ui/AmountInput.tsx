import type { InputHTMLAttributes, ReactNode } from "react";

/**
 * Amount input (spec §20).
 *
 * The primary control of the exchange and trade forms, so it is built as one
 * block rather than a label plus a box: the label, the figure, the asset and
 * the available balance belong together and are read together.
 *
 * `inputMode="decimal"` brings up a numeric keypad with a decimal separator on
 * a phone. `type="text"` rather than `type="number"`, deliberately: a number
 * input silently discards what it considers invalid while the user is still
 * typing, and loses trailing separators — both unacceptable when the value is
 * an amount of money. Parsing and validation happen on the server regardless.
 */
export function AmountInput({
  id,
  label,
  assetSlot,
  balance,
  onMax,
  error,
  secondary,
  disabled,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  id: string;
  label: ReactNode;
  /** Asset selector or a static symbol. */
  assetSlot: ReactNode;
  /** Available balance line. Omit when there is nothing truthful to show. */
  balance?: ReactNode;
  onMax?: ReactNode;
  error?: string;
  /** Converted value or a rate note, shown under the figure. */
  secondary?: ReactNode;
}) {
  const errorId = error ? `${id}-error` : undefined;

  return (
    <div className="jc-amount" data-invalid={error ? true : undefined}>
      <div className="jc-amount-head">
        <label className="jc-field-label" htmlFor={id}>
          {label}
        </label>
        {balance ? <span className="jc-amount-foot">{balance}</span> : null}
      </div>

      <div className="jc-amount-body">
        <input
          {...rest}
          id={id}
          name={rest.name ?? id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          disabled={disabled}
          className="jc-amount-input"
          aria-invalid={error ? true : undefined}
          aria-describedby={errorId}
        />
        {assetSlot}
      </div>

      {secondary || onMax ? (
        <div className="jc-amount-foot">
          <span>{secondary}</span>
          {onMax}
        </div>
      ) : null}

      {error ? (
        <span id={errorId} className="jc-field-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}
