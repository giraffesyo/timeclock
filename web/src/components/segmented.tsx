import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** A choice between a few views, as buttons side by side. */
export function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  /** What is being chosen, for assistive tech. */
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string; icon?: ReactNode }[];
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a legend the toolbar has no room for
    <div role="group" aria-label={label} className="inline-flex rounded-md border border-border bg-card p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          className={cn(
            'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded px-2.5 text-xs font-medium transition-colors [&_svg]:size-3.5',
            o.value === value ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
          onClick={() => onChange(o.value)}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}
