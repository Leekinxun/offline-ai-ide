export interface ModalEscapeEvent {
  key: string;
  preventDefault: () => void;
  stopPropagation: () => void;
  stopImmediatePropagation: () => void;
}

export function claimModalEscape(event: ModalEscapeEvent, onClose: () => void): boolean {
  if (event.key !== "Escape") return false;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  onClose();
  return true;
}
