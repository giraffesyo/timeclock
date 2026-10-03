import { inputClasses } from '@parallelworks/ui';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * The class names of a one-line text input or select. Spelled out rather
 * than built on the library's inputClasses, whose vertical padding leaves a
 * 32px control too little room for its text.
 */
export const controlClass =
  'h-8 w-full rounded-md border border-border bg-(--theme-input-bg) px-2.5 py-0 text-sm leading-none text-foreground outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60';

/** The same, for a textarea, which sets its own height. */
export const textareaClass = cn(inputClasses, 'min-h-16 disabled:cursor-not-allowed disabled:opacity-60');

/** A labelled form control. The label wraps the control, so clicking it focuses it. */
export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is the children
    <label className={cn('block text-sm', className)}>
      <span className="mb-1 block font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}
