import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

/**
 * Form controls (spec §20).
 *
 * Every field wires its hint and its error to the control through
 * `aria-describedby` and `aria-invalid`. A red border tells a sighted user which
 * field failed; without this a screen reader user gets an error message floating
 * with no indication of what it belongs to.
 */

export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  children: (aria: { id: string; "aria-invalid"?: true; "aria-describedby"?: string }) => ReactNode;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;

  return (
    <div className="jc-field">
      <label className="jc-field-label" htmlFor={id}>
        {label}
      </label>

      {children({
        id,
        "aria-invalid": error ? true : undefined,
        "aria-describedby": describedBy,
      })}

      {hint ? (
        <span id={hintId} className="jc-field-hint">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} className="jc-field-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label: ReactNode;
  id: string;
  hint?: ReactNode;
  error?: string;
  icon?: ReactNode;
};

export function Input({ label, id, hint, error, icon, className, ...rest }: InputProps) {
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      {(aria) =>
        icon ? (
          <span className="jc-input-wrap">
            <span className="jc-input-icon" aria-hidden="true">
              {icon}
            </span>
            <input
              {...rest}
              {...aria}
              name={rest.name ?? id}
              className={["jc-input", "jc-input--with-icon", className].filter(Boolean).join(" ")}
            />
          </span>
        ) : (
          <input
            {...rest}
            {...aria}
            name={rest.name ?? id}
            className={["jc-input", className].filter(Boolean).join(" ")}
          />
        )
      }
    </Field>
  );
}

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  label: ReactNode;
  id: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
};

/**
 * The native select, restyled.
 *
 * A custom listbox would have to reimplement keyboard navigation, typeahead and
 * the mobile picker; the platform control already has all three, and does them
 * better than most replacements.
 */
export function Select({ label, id, hint, error, className, children, ...rest }: SelectProps) {
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      {(aria) => (
        <select
          {...rest}
          {...aria}
          name={rest.name ?? id}
          className={["jc-input", "jc-select", className].filter(Boolean).join(" ")}
        >
          {children}
        </select>
      )}
    </Field>
  );
}

export function SearchInput({
  id,
  label,
  placeholder = "Search",
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { id: string; label: string }) {
  return (
    <span className="jc-input-wrap">
      <span className="jc-input-icon" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="7" cy="7" r="4.5" />
          <path d="m10.5 10.5 3 3" strokeLinecap="round" />
        </svg>
      </span>
      <label className="jc-sr-only" htmlFor={id}>
        {label}
      </label>
      <input
        {...rest}
        id={id}
        type="search"
        placeholder={placeholder}
        className="jc-input jc-input--with-icon"
      />
    </span>
  );
}
