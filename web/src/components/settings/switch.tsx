import { Switch as UISwitch } from '@parallelworks/ui';
import { useId } from 'react';
import { cn } from '@/lib/cn';

const focus = 'shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/** A switch with no visible label of its own, for a table cell: the column names it. */
export function Switch({
  value,
  onChange,
  label,
  disabled,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  /** What the switch turns on, for assistive technology. */
  label: string;
  disabled?: boolean;
}) {
  return (
    <UISwitch
      size="sm"
      checked={value}
      disabled={disabled}
      aria-label={label}
      className={focus}
      onCheckedChange={onChange}
    />
  );
}

/** A setting that is on or off: its label, what it does, and the switch. */
export function SwitchRow({
  label,
  hint,
  value,
  onChange,
  className,
}: {
  label: string;
  /** The consequence, in one line. */
  hint: string;
  value: boolean;
  onChange: (value: boolean) => void;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div className="min-w-0 text-sm">
        <label htmlFor={id} className="block cursor-pointer font-medium">
          {label}
        </label>
        <p id={`${id}-hint`} className="mt-0.5 text-xs text-muted-foreground">
          {hint}
        </p>
      </div>
      <UISwitch
        size="sm"
        // A sibling label names the switch through the button it points at.
        nativeButton
        render={<button type="button" />}
        id={id}
        checked={value}
        aria-describedby={`${id}-hint`}
        className={focus}
        onCheckedChange={onChange}
      />
    </div>
  );
}
