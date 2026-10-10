/**
 * A labelled input with its validation message.
 *
 * The error is wired to the input through `aria-describedby` and
 * `aria-invalid`, so assistive technology reads the reason along with the
 * field instead of leaving the user to guess which one failed.
 */
export function Field({
  id,
  label,
  type = "text",
  autoComplete,
  placeholder,
  required = true,
  defaultValue,
  error,
  hint,
}: {
  id: string;
  label: string;
  type?: string;
  autoComplete?: string;
  placeholder?: string;
  required?: boolean;
  defaultValue?: string;
  error?: string;
  hint?: string;
}) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ");

  return (
    <div className="jc-field">
      <label className="jc-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        name={id}
        type={type}
        className="jc-input"
        autoComplete={autoComplete}
        placeholder={placeholder}
        required={required}
        defaultValue={defaultValue}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
      />
      {hint ? (
        <span id={hintId} className="jc-muted">
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
