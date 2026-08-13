import { useEffect, useRef, type RefObject } from "react";
import { claimModalEscape } from "./modalKeyboardContract";

interface ModalDialogFocusOptions {
  open: boolean;
  onClose: () => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
  closeOnEscape?: boolean;
  suspended?: boolean;
}

const FOCUSABLE_SELECTOR = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function useModalDialogFocus<T extends HTMLElement>({
  open,
  onClose,
  initialFocusRef,
  closeOnEscape = true,
  suspended = false,
}: ModalDialogFocusOptions) {
  const dialogRef = useRef<T>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    window.requestAnimationFrame(() => {
      const target = initialFocusRef?.current || dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) || dialogRef.current;
      target?.focus();
    });
    return () => { window.requestAnimationFrame(() => returnFocusRef.current?.focus()); };
  }, [initialFocusRef, open]);

  useEffect(() => {
    if (!open || suspended) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (closeOnEscape && claimModalEscape(event, () => onCloseRef.current())) return;
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (!focusable.length) { event.preventDefault(); dialogRef.current.focus(); return; }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [closeOnEscape, open, suspended]);

  return dialogRef;
}
