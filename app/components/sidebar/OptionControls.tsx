import { RotateCcw } from "lucide-react";
import type { ReactNode } from "react";

/** Icon + uppercase title + optional right-aligned value readout. */
export function OptionHeader({
  icon,
  title,
  value,
}: {
  icon?: ReactNode;
  title: string;
  value?: ReactNode;
}) {
  return (
    <div className="mb-2 flex items-center gap-2">
      {icon && <span className="text-text-muted">{icon}</span>}
      <h2 className="text-text-tertiary text-xs font-medium tracking-wide uppercase">{title}</h2>
      {value !== undefined && (
        <span className="text-text-secondary ml-auto text-xs font-medium tabular-nums">
          {value}
        </span>
      )}
    </div>
  );
}

/** Discrete slider with a leading "Default" stop that maps to `null`. */
export function SteppedSlider({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ value: string; label: string }>;
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const selectedIndex = options.findIndex((option) => option.value === value) + 1;
  const selectedProgress = selectedIndex / options.length;
  const selectedPosition = `calc(${selectedProgress * 100}% + ${1 - selectedProgress * 2}rem)`;
  const valueText = selectedIndex === 0 ? "Default" : options[selectedIndex - 1].label;

  return (
    <div className="relative h-10">
      <input
        type="range"
        min={0}
        max={options.length}
        step={1}
        value={selectedIndex}
        aria-label={label}
        aria-valuetext={valueText}
        onChange={(event) => {
          const index = Number(event.target.value);
          onChange(index === 0 ? null : options[index - 1].value);
        }}
        className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
      />
      <div className="bg-surface-overlay peer-focus-visible:ring-accent absolute inset-x-0 inset-y-1 overflow-hidden rounded-full peer-focus-visible:ring-2 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-(--surface)">
        <div
          className="h-full bg-purple-500 transition-[width] duration-150"
          style={{ width: selectedPosition }}
        />
      </div>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-between">
        {[null, ...options].map((option) => (
          <span
            key={option?.value ?? "default"}
            className="flex h-10 w-8 items-center justify-center rounded-full"
          >
            {option === null ? (
              <RotateCcw className="text-text-primary/25 h-3.5 w-3.5" />
            ) : (
              <span className="bg-text-primary/25 h-1.5 w-1.5 rounded-full" />
            )}
          </span>
        ))}
      </div>
      <span
        className="bg-surface-raised border-c-border pointer-events-none absolute top-1/2 z-1 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border shadow-md transition-[left] duration-150"
        style={{ left: selectedPosition }}
      >
        {selectedIndex === 0 && <RotateCcw className="text-text-tertiary h-3.5 w-3.5" />}
      </span>
    </div>
  );
}

/** Row of mutually exclusive buttons with optional sub-labels. */
export function SegmentedButtons<T extends string>({
  options,
  value,
  onChange,
  disabled = false,
}: {
  options: Array<{ value: T; label: string; hint?: string }>;
  value: T | null;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex gap-2">
      {options.map((option) => {
        const showSelectedStyle = value === option.value && !disabled;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => !disabled && onChange(option.value)}
            disabled={disabled}
            className={`flex-1 rounded-lg px-1 py-2 text-sm font-medium transition-colors ${
              showSelectedStyle
                ? "text-accent border border-purple-500 bg-purple-500/20"
                : !disabled
                  ? "border-c-border bg-surface-overlay text-text-tertiary hover:border-c-border border"
                  : "border-border-subtle bg-surface-overlay/50 text-text-muted cursor-not-allowed border opacity-40"
            }`}
          >
            {option.label}
            {option.hint && <p className="text-text-muted text-[0.6rem]">{option.hint}</p>}
          </button>
        );
      })}
    </div>
  );
}

/** Continuous/numeric slider with min/max labels under it. */
export function RangeSlider({
  label,
  min,
  max,
  step = 1,
  value,
  onChange,
  formatBound = String,
}: {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
  formatBound?: (value: number) => string;
}) {
  const progress = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-full appearance-none rounded-full"
        style={{
          background: `linear-gradient(to right, var(--color-purple-500) 0%, var(--color-purple-500) ${progress}%, var(--color-surface-overlay) ${progress}%, var(--color-surface-overlay) 100%)`,
        }}
      />
      <div className="text-text-muted mt-1 flex justify-between text-[10px] tabular-nums">
        <span>{formatBound(min)}</span>
        <span>{formatBound(max)}</span>
      </div>
    </>
  );
}
