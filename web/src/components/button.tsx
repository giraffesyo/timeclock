import { LoaderIcon } from '@parallelworks/ui/icons';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'outline' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

const base =
  'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0';

const sizes: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-xs',
  md: 'h-8 px-3 text-sm',
};

const variants: Record<Variant, string> = {
  primary: 'bg-primary text-primary-foreground hover:enabled:opacity-90',
  outline: 'border border-border bg-card text-foreground hover:enabled:bg-muted',
  ghost: 'text-muted-foreground hover:enabled:bg-muted hover:enabled:text-foreground',
  danger: 'border border-border bg-card text-danger hover:enabled:bg-danger-subtle',
};

/** The class names of a button, for a link that should look like one. */
export function buttonClass(variant: Variant = 'outline', size: Size = 'md', className?: string) {
  return cn(base, sizes[size], variants[variant], className);
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Shows a spinner and disables the button while work is under way. */
  loading?: boolean;
  icon?: ReactNode;
}

/** The app's button: dense, on the theme's tokens. */
export function Button({
  variant = 'outline',
  size = 'md',
  loading,
  icon,
  className,
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <button type="button" className={buttonClass(variant, size, className)} disabled={disabled || loading} {...props}>
      {loading ? <LoaderIcon aria-hidden /> : icon}
      {children}
    </button>
  );
}
