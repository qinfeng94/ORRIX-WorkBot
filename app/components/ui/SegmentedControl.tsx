"use client";

/**
 * macOS 分段药丸控件（Segmented Control · Apple Keynote 浅色系）
 * 通用受控组件：部门筛选 / 对话引擎选择 / 侧栏页签等处复用。
 */

export interface SegmentedOption {
  readonly value: string;
  readonly label: string;
}

interface SegmentedControlProps {
  readonly options: readonly SegmentedOption[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** 无障碍标签（必填） */
  readonly ariaLabel: string;
  /** 尺寸：sm 紧凑（页签）/ md 标准（筛选器） */
  readonly size?: "sm" | "md";
  readonly disabled?: boolean;
  /** 占满整行（等宽分段） */
  readonly fullWidth?: boolean;
}

export default function SegmentedControl({
  options,
  value,
  onChange,
  ariaLabel,
  size = "md",
  disabled = false,
  fullWidth = false,
}: SegmentedControlProps) {
  const pad = size === "sm" ? "px-3 py-1 text-[12px]" : "px-4 py-1.5 text-[13px]";
  return (
    <div
      className={`segmented ${disabled ? "opacity-50" : ""} ${fullWidth ? "flex w-full" : ""}`}
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={`rounded-full font-medium transition-all duration-200 ${pad} ${fullWidth ? "flex-1" : ""} ${
              active
                ? "bg-white text-ink shadow-[0_1px_2px_rgba(0,0,0,0.08),0_0_0_1px_rgba(0,0,0,0.04)]"
                : "text-ink-2 hover:text-ink"
            } ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
