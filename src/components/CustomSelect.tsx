import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface SelectOption {
  value: string;
  label: string;
}

interface CustomSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  disabled?: boolean;
  size?: "small" | "medium";
  placeholder?: string;
  className?: string;
}

export default function CustomSelect({
  value,
  onChange,
  options,
  disabled = false,
  size = "medium",
  placeholder = "请选择",
  className = "",
}: CustomSelectProps) {
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  const selectedLabel = options.find((o) => o.value === value)?.label || placeholder;

  useEffect(() => {
    if (!open) return;
    const idx = options.findIndex((o) => o.value === value);
    setHighlightedIndex(idx >= 0 ? idx : 0);
  }, [open, options, value]);

  // Close when clicking outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node) && !listRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const availableBelow = window.innerHeight - rect.bottom - 12;
      const openAbove = availableBelow < 160 && rect.top > availableBelow;
      setDropdownStyle({
        position: "fixed",
        left: rect.left,
        top: openAbove ? undefined : rect.bottom + 4,
        bottom: openAbove ? window.innerHeight - rect.top + 4 : undefined,
        width: rect.width,
        maxHeight: Math.max(120, Math.min(280, openAbove ? rect.top - 12 : availableBelow)),
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  // Scroll highlighted into view
  useEffect(() => {
    if (!open || !listRef.current) return;
    const items = listRef.current.querySelectorAll("li");
    if (items[highlightedIndex]) {
      items[highlightedIndex].scrollIntoView({ block: "nearest" });
    }
  }, [highlightedIndex, open]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    switch (e.key) {
      case "Enter":
      case " ":
        e.preventDefault();
        if (open && options[highlightedIndex]) {
          onChange(options[highlightedIndex].value);
          setOpen(false);
        } else {
          setOpen(true);
        }
        break;
      case "ArrowDown":
        e.preventDefault();
        if (!open) {
          setOpen(true);
          break;
        }
        setHighlightedIndex((h) => Math.min(h + 1, options.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        if (!open) {
          setOpen(true);
          break;
        }
        setHighlightedIndex((h) => Math.max(h - 1, 0));
        break;
      case "Escape":
        setOpen(false);
        break;
      case "Tab":
        if (open) setOpen(false);
        break;
    }
  };

  const height = size === "small" ? "34px" : "36px";
  const fontSize = size === "small" ? "12px" : "13px";

  return (
    <div
      ref={containerRef}
      className={`custom-select-container ${className}`}
      style={{ position: "relative", width: "100%" }}
    >
      {/* Trigger */}
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={handleKeyDown}
        className="custom-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          width: "100%",
          height,
          padding: "0 28px 0 12px",
          fontSize,
          borderRadius: "8px",
          border: "1px solid #d1d5db",
          background: "#ffffff",
          color: value ? "#1e293b" : "#94a3b8",
          textAlign: "left",
          cursor: disabled ? "default" : "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "6px",
          outline: "none",
          transition: "all .15s ease",
          opacity: disabled ? 0.5 : 1,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          userSelect: "none",
        }}
        onMouseEnter={(e) => {
          if (!disabled) (e.currentTarget.style.borderColor = "#2563eb");
        }}
        onMouseLeave={(e) => {
          if (!open) (e.currentTarget.style.borderColor = "#d1d5db");
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selectedLabel}
        </span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#64748b"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            flexShrink: 0,
            transition: "transform .2s ease",
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
          }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {/* Dropdown */}
      {open && createPortal(
        <ul
          ref={listRef}
          className="custom-select-dropdown"
          role="listbox"
          style={{
            ...dropdownStyle,
            zIndex: 1000,
            margin: 0,
            padding: "4px",
            listStyle: "none",
            background: "#ffffff",
            border: "1px solid #d1d5db",
            borderRadius: "8px",
            boxShadow: "0 10px 15px -3px rgba(0,0,0,.1), 0 4px 6px -4px rgba(0,0,0,.1)",
            overflowY: "auto",
          }}
        >
          {options.map((opt, idx) => {
            const isSelected = opt.value === value;
            const isHighlighted = idx === highlightedIndex;
            return (
              <li
                key={opt.value}
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                onMouseEnter={() => setHighlightedIndex(idx)}
                style={{
                  padding: "8px 12px",
                  fontSize: "13px",
                  borderRadius: "6px",
                  cursor: "pointer",
                  color: isSelected ? "#2563eb" : "#334155",
                  background: isSelected ? "#dbeafe" : isHighlighted ? "#eff6ff" : "transparent",
                  fontWeight: isSelected ? 600 : 400,
                  margin: "2px",
                  transition: "all .1s ease",
                }}
              >
                {opt.label}
              </li>
            );
          })}
        </ul>,
        document.body,
      )}
    </div>
  );
}

