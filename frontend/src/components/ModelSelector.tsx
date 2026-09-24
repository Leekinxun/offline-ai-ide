import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

interface ModelSelectorProps {
  value: string;
  models: string[];
  automaticLabel: string;
  label: string;
  disabled?: boolean;
  className?: string;
  onChange: (value: string) => void;
}

interface MenuPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

interface ModelOption {
  value: string;
  label: string;
  automatic: boolean;
  badge: string;
}

function getModelBadge(modelName: string): string {
  const trimmed = modelName.trim();
  if (!trimmed) return "LLM";
  const provider = trimmed.includes("/") ? trimmed.split("/")[0] : trimmed.split("-")[0];
  return provider.slice(0, 4).toUpperCase();
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({
  value,
  models,
  automaticLabel,
  label,
  disabled = false,
  className,
  onChange,
}) => {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<MenuPosition | null>(null);

  const options = useMemo<ModelOption[]>(
    () => [
      { value: "", label: automaticLabel, automatic: true, badge: "AUTO" },
      ...models.map((model) => ({
        value: model,
        label: model,
        automatic: false,
        badge: getModelBadge(model),
      })),
    ],
    [automaticLabel, models]
  );
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selectedOption = options[selectedIndex] || options[0];

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const gutter = 8;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.max(260, rect.width);
    const maxMenuHeight = Math.min(320, viewportHeight - gutter * 2);
    const spaceBelow = viewportHeight - rect.bottom - gutter;
    const spaceAbove = rect.top - gutter;
    const opensAbove = spaceBelow < 220 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(160, Math.min(maxMenuHeight, opensAbove ? spaceAbove : spaceBelow));
    const left = Math.min(Math.max(gutter, rect.right - width), viewportWidth - width - gutter);
    const top = opensAbove
      ? Math.max(gutter, rect.top - maxHeight - gutter)
      : Math.min(rect.bottom + gutter, viewportHeight - maxHeight - gutter);
    setPosition({ top, left, width, maxHeight });
  }, []);

  const openMenu = useCallback(() => {
    if (disabled) return;
    setActiveIndex(selectedIndex);
    updatePosition();
    setOpen(true);
  }, [disabled, selectedIndex, updatePosition]);

  const closeMenu = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);

  const chooseOption = useCallback((nextValue: string) => {
    onChange(nextValue);
    closeMenu(true);
  }, [closeMenu, onChange]);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      closeMenu();
    };
    const handleLayoutChange = () => updatePosition();
    document.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("resize", handleLayoutChange);
    window.addEventListener("scroll", handleLayoutChange, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("resize", handleLayoutChange);
      window.removeEventListener("scroll", handleLayoutChange, true);
    };
  }, [closeMenu, open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    window.requestAnimationFrame(() => menuRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const option = document.getElementById(`${id}-option-${activeIndex}`);
    option?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, id, open]);

  const handleTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(event.key === "ArrowDown" ? Math.min(options.length - 1, selectedIndex + 1) : Math.max(0, selectedIndex - 1));
      updatePosition();
      setOpen(true);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open ? closeMenu() : openMenu();
    }
  };

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      closeMenu();
      triggerRef.current?.focus();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(options.length - 1, index + 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(0, index - 1));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(options.length - 1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      chooseOption(options[activeIndex]?.value || "");
    }
  };

  return (
    <div className={["model-selector", className].filter(Boolean).join(" ")}>
      <button
        ref={triggerRef}
        type="button"
        className="model-selector-trigger"
        disabled={disabled}
        aria-label={`${label}: ${selectedOption.label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-menu`}
        title={`${label}: ${selectedOption.label}`}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className={`model-selector-status${selectedOption.automatic ? " automatic" : ""}`} aria-hidden="true" />
        <span className="model-selector-value">{selectedOption.label}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && position && createPortal(
        <div
          ref={menuRef}
          id={`${id}-menu`}
          className="model-selector-menu"
          role="listbox"
          tabIndex={-1}
          aria-label={label}
          aria-activedescendant={`${id}-option-${activeIndex}`}
          style={{
            top: position.top,
            left: position.left,
            width: position.width,
            maxHeight: position.maxHeight,
          }}
          onKeyDown={handleMenuKeyDown}
        >
          <div className="model-selector-menu-head" aria-hidden="true">
            <span>{label}</span>
            <strong>{options.length}</strong>
          </div>
          {options.map((option, index) => (
            <button
              type="button"
              id={`${id}-option-${index}`}
              className={`model-selector-option${option.value === value ? " selected" : ""}${index === activeIndex ? " active" : ""}${option.automatic ? " automatic" : ""}`}
              role="option"
              tabIndex={-1}
              aria-selected={option.value === value}
              key={option.value || "__automatic__"}
              onMouseMove={() => setActiveIndex(index)}
              onClick={() => chooseOption(option.value)}
            >
              <span className={`model-selector-mark${option.automatic ? " automatic" : ""}`} aria-hidden="true" />
              <span className="model-selector-option-copy">
                <strong>{option.label}</strong>
                <small>{option.badge}</small>
              </span>
              <span className="model-selector-check" aria-hidden="true">{option.value === value && <Check size={15} />}</span>
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
};
