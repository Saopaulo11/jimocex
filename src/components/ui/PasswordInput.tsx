"use client";

import { useId, useState } from "react";
import type { InputHTMLAttributes, ReactNode } from "react";

import { Field } from "./Input";

/**
 * Password field with a reveal toggle (spec §20).
 *
 * The toggle matters on a platform people sign into from a phone: a mistyped
 * password on a 12-character minimum is otherwise invisible. It is a real
 * button, so it is reachable by keyboard and announces its state.
 */
export function PasswordInput({
  id,
  label,
  hint,
  error,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
}) {
  const [visible, setVisible] = useState(false);
  const describedById = useId();

  return (
    <Field id={id} label={label} hint={hint} error={error}>
      {(aria) => (
        <span className="jc-input-wrap">
          <input
            {...rest}
            {...aria}
            name={rest.name ?? id}
            type={visible ? "text" : "password"}
            className="jc-input"
            style={{ paddingRight: 72 }}
          />
          <button
            type="button"
            className="jc-input-action"
            onClick={() => setVisible((v) => !v)}
            aria-pressed={visible}
            aria-controls={id}
            aria-describedby={describedById}
          >
            {visible ? "Hide" : "Show"}
          </button>
          <span id={describedById} className="jc-sr-only">
            {visible ? "Password is visible" : "Password is hidden"}
          </span>
        </span>
      )}
    </Field>
  );
}
