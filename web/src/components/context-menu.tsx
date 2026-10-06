import { type ReactNode, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/**
 * A menu at the pointer, for a right click (or the keyboard's menu key) on
 * something. It sits in the top layer as a manual popover: an auto one would
 * take the opening click's own release as a click outside and close at
 * once. A press outside, Escape, or leaving the page closes it; arrow keys
 * move between its items.
 */
export function ContextMenu({
  at,
  label,
  heading,
  items,
  onClose,
}: {
  at: { x: number; y: number };
  label: string;
  heading?: ReactNode;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = menu.current;
    if (!el) return;
    const returnTo = document.activeElement as HTMLElement | null;
    el.showPopover();
    el.style.left = `${Math.max(8, Math.min(at.x, window.innerWidth - el.offsetWidth - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(at.y, window.innerHeight - el.offsetHeight - 8))}px`;
    el.querySelector<HTMLButtonElement>('[role=menuitem]:not(:disabled)')?.focus({ preventScroll: true });
    const outside = (e: PointerEvent) => {
      if (!el.contains(e.target as Node)) onClose();
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', onEscape);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', onEscape);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
      returnTo?.focus({ preventScroll: true });
    };
  }, [at, onClose]);

  const move = (step: number) => {
    const all = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)') ?? [])];
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    all[(i + step + all.length) % all.length]?.focus();
  };

  return createPortal(
    <div
      ref={menu}
      popover="manual"
      role="menu"
      aria-label={label}
      className="popover fixed m-0 min-w-52 p-1 text-sm"
      style={{ inset: 'auto' }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') move(1);
        else if (e.key === 'ArrowUp') move(-1);
        else return;
        e.preventDefault();
      }}
    >
      {heading && <div className="px-3 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">{heading}</div>}
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          className={cn(
            'flex w-full cursor-pointer items-center rounded-md px-3 py-1.5 text-left focus:outline-none disabled:cursor-not-allowed disabled:opacity-50',
            item.danger ? 'text-danger hover:bg-danger-subtle focus:bg-danger-subtle' : 'hover:bg-muted focus:bg-muted',
          )}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
