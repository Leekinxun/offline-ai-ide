import React, { forwardRef, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import "./WorkbenchSelect.css";

export interface WorkbenchSelectOption {
  value: string;
  label: string;
  meta?: string;
  disabled?: boolean;
  icon?: React.ReactNode;
}

export interface WorkbenchSelectProps {
  value: string;
  options: WorkbenchSelectOption[];
  onChange: (value: string) => void;
  label: string;
  disabled?: boolean;
  className?: string;
  title?: string;
  placeholder?: string;
  showStatusMark?: boolean;
  showHead?: boolean;
  icon?: React.ReactNode;
  active?: boolean;
}

interface MenuPosition {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  maxHeight: number;
  opensAbove: boolean;
}

function mergeRefs<T>(...refs: Array<React.ForwardedRef<T> | React.Ref<T> | undefined>) {
  return (value: T) => {
    refs.forEach((ref) => {
      if (!ref) return;
      if (typeof ref === "function") {
        ref(value);
      } else {
        (ref as React.MutableRefObject<T | null>).current = value;
      }
    });
  };
}

function firstEnabledIndex(options: WorkbenchSelectOption[], startIndex = 0, direction: 1 | -1 = 1): number {
  if (!options.length) return -1;
  let index = Math.min(Math.max(startIndex, 0), options.length - 1);
  for (let seen = 0; seen < options.length; seen += 1) {
    if (!options[index]?.disabled) return index;
    index += direction;
    if (index < 0) index = options.length - 1;
    if (index >= options.length) index = 0;
  }
  return -1;
}

export const WorkbenchSelect = forwardRef<HTMLButtonElement, WorkbenchSelectProps>(({
  value,
  options,
  onChange,
  label,
  disabled = false,
  className,
  title,
  placeholder,
  showStatusMark = false,
  showHead = false,
  icon,
  active = false,
}, forwardedRef) => {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<MenuPosition | null>(null);

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : options[0];
  const enabledOptions = useMemo(() => options.filter((option) => !option.disabled), [options]);
  const isDisabled = disabled || enabledOptions.length === 0;

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const gutter = 8;
    const verticalGap = 4;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const availableWidth = Math.max(160, viewportWidth - gutter * 2);
    // Menu width seamlessly matches trigger width, with a minimum of 200px (or trigger width)
    const width = Math.min(Math.max(rect.width, 200), availableWidth);
    const maxMenuHeight = Math.min(320, Math.max(120, viewportHeight - gutter * 2));
    const spaceBelow = viewportHeight - rect.bottom - verticalGap - gutter;
    const spaceAbove = rect.top - verticalGap - gutter;
    const opensAbove = spaceBelow < 180 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(100, Math.min(maxMenuHeight, opensAbove ? spaceAbove : spaceBelow));
    // Naturally align with the trigger's left edge
    let left = rect.left;
    if (left + width > viewportWidth - gutter) {
      left = Math.max(gutter, viewportWidth - width - gutter);
    }
    const top = opensAbove ? undefined : Math.round(rect.bottom + verticalGap);
    const bottom = opensAbove ? Math.round(viewportHeight - rect.top + verticalGap) : undefined;
    setPosition({ top, bottom, left: Math.round(left), width: Math.round(width), maxHeight: Math.round(maxHeight), opensAbove });
  }, []);

  const closeMenu = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);

  const openMenu = useCallback(() => {
    if (isDisabled) return;
    setActiveIndex(firstEnabledIndex(options, Math.max(selectedIndex, 0)));
    updatePosition();
    setOpen(true);
  }, [isDisabled, options, selectedIndex, updatePosition]);

  const chooseOption = useCallback((option: WorkbenchSelectOption | undefined) => {
    if (!option || option.disabled) return;
    if (option.value === value) {
      closeMenu(true);
      return;
    }
    onChange(option.value);
    closeMenu(true);
  }, [closeMenu, onChange, value]);

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
    if (isDisabled) {
      if (open) closeMenu();
      return;
    }
    setActiveIndex((index) => {
      if (options[index] && !options[index].disabled) return index;
      return firstEnabledIndex(options, Math.max(selectedIndex, 0));
    });
  }, [closeMenu, isDisabled, open, options, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const option = document.getElementById(`${id}-option-${activeIndex}`);
    option?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, id, open]);

  const moveActive = (direction: 1 | -1) => {
    setActiveIndex((index) => firstEnabledIndex(options, index + direction, direction));
  };

  const handleTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (isDisabled) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(firstEnabledIndex(options, Math.max(selectedIndex, 0) + (event.key === "ArrowDown" ? 1 : -1), event.key === "ArrowDown" ? 1 : -1));
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
      event.stopPropagation();
      closeMenu(true);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(firstEnabledIndex(options, 0, 1));
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(firstEnabledIndex(options, options.length - 1, -1));
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      chooseOption(options[activeIndex]);
    }
  };

  const selectedLabel = selectedOption?.label || "";
  const displayLabel = value ? selectedLabel : (placeholder || selectedLabel);

  return (
    <div className={["workbench-select", className].filter(Boolean).join(" ")}>
      <button
        ref={mergeRefs(triggerRef, forwardedRef)}
        type="button"
        className={`workbench-select-trigger${active ? " active" : ""}`}
        disabled={isDisabled}
        aria-label={`${label}: ${displayLabel}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-menu`}
        title={title || `${label}: ${displayLabel}`}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={handleTriggerKeyDown}
      >
        {icon ? (
          <span className="workbench-select-icon">{icon}</span>
        ) : showStatusMark ? (
          <span className={`workbench-select-status${selectedOption?.meta === "AUTO" ? " automatic" : ""}`} aria-hidden="true" />
        ) : null}
        <span className="workbench-select-value">{displayLabel}</span>
        <ChevronDown size={13} className="workbench-select-arrow" aria-hidden="true" />
      </button>
      {open && position && createPortal(
        <div
          ref={menuRef}
          id={`${id}-menu`}
          data-workbench-select-menu
          className={`workbench-select-menu ${position.opensAbove ? "opens-above" : "opens-below"}`}
          role="listbox"
          tabIndex={-1}
          aria-label={label}
          aria-activedescendant={activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
          style={{
            top: position.top,
            bottom: position.bottom,
            left: position.left,
            width: position.width,
            maxHeight: position.maxHeight,
          }}
          onKeyDown={handleMenuKeyDown}
        >
          {showHead && (
            <div className="workbench-select-menu-head" aria-hidden="true">
              <span>{label}</span>
              <strong>{options.length}</strong>
            </div>
          )}
          {options.map((option, index) => (
            <button
              type="button"
              id={`${id}-option-${index}`}
              className={`workbench-select-option${option.value === value ? " selected" : ""}${index === activeIndex ? " active" : ""}${option.disabled ? " disabled" : ""}`}
              role="option"
              tabIndex={-1}
              aria-selected={option.value === value}
              aria-disabled={option.disabled || undefined}
              key={`${option.value || "__empty__"}-${index}`}
              disabled={option.disabled}
              onMouseMove={() => !option.disabled && setActiveIndex(index)}
              onClick={() => chooseOption(option)}
            >
              {option.icon ? (
                <span className="workbench-select-option-icon" aria-hidden="true">{option.icon}</span>
              ) : showStatusMark ? (
                <span className={`workbench-select-mark${option.meta === "AUTO" ? " automatic" : ""}`} aria-hidden="true" />
              ) : null}
              <span className="workbench-select-option-copy">
                <strong>{option.label}</strong>
                {option.meta && <small>{option.meta}</small>}
              </span>
              <span className="workbench-select-check" aria-hidden="true">{option.value === value && <Check size={14} />}</span>
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
});

WorkbenchSelect.displayName = "WorkbenchSelect";
