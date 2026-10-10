"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

import { Button } from "./Button";

/**
 * Modal (spec §26), built on the native <dialog>.
 *
 * `showModal()` gives focus trapping, inertness of the page behind, Escape to
 * close and a real ::backdrop from the platform. Reimplementing those in React
 * is a well-known source of accessibility bugs, and a dialog that traps focus
 * incorrectly on a withdrawal confirmation is worse than no dialog.
 *
 * `destructive` is for confirmations that move money or cannot be undone: it
 * makes the confirm button danger-toned and leaves the cancel action first in
 * the DOM, so the safe choice is the one focus reaches first.
 */

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  confirmLabel,
  onConfirm,
  cancelLabel = "Cancel",
  destructive = false,
  loading = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  onConfirm?: () => void;
  cancelLabel?: string;
  destructive?: boolean;
  loading?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    // Escape and the backdrop both fire `close`, so the parent's state is kept
    // in step with the element's rather than drifting out of it.
    const handleClose = () => onClose();
    dialog.addEventListener("close", handleClose);
    return () => dialog.removeEventListener("close", handleClose);
  }, [onClose]);

  const titleId = "jc-modal-title";
  const descId = description ? "jc-modal-desc" : undefined;

  return (
    <dialog
      ref={ref}
      className="jc-modal"
      aria-labelledby={titleId}
      aria-describedby={descId}
      // A click on the backdrop lands on the dialog element itself, never on a
      // child, so this closes on backdrop clicks without a wrapper div.
      onClick={(event) => {
        if (event.target === ref.current && !loading) ref.current?.close();
      }}
    >
      <div className="jc-modal-header">
        <h2 id={titleId} className="jc-modal-title">
          {title}
        </h2>
        <button
          type="button"
          className="jc-btn jc-btn--ghost jc-btn--sm"
          onClick={() => ref.current?.close()}
          aria-label="Close"
          disabled={loading}
        >
          ✕
        </button>
      </div>

      <div className="jc-modal-content">
        {description ? (
          <p id={descId} className="jc-sm" style={{ marginBottom: children ? "var(--jc-space-4)" : 0 }}>
            {description}
          </p>
        ) : null}
        {children}
      </div>

      {onConfirm || confirmLabel ? (
        <div className="jc-modal-footer">
          <Button variant="tertiary" onClick={() => ref.current?.close()} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            onClick={onConfirm}
            loading={loading}
          >
            {confirmLabel ?? "Confirm"}
          </Button>
        </div>
      ) : null}
    </dialog>
  );
}
