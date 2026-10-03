import { CheckIcon, ChevronDownIcon } from '@parallelworks/ui/icons';
import { type CSSProperties, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { controlClass } from '@/components/field';
import { cn } from '@/lib/cn';
import { type Project, useProjects } from '@/lib/queries';
import { projectHue } from '@/lib/timeline';

/** "Customer / Project", or just the project for internal work. */
export function projectLabel(p: Project): string {
  return p.customerName ? `${p.customerName} / ${p.name}` : p.name;
}

/** The label of a project id, or the no-project label. */
export function useProjectName() {
  const t = useTranslations('common.project');
  const all = useProjects(true);
  return (id?: string | null) => {
    if (!id) return t('none');
    const p = all.data?.find((x) => x.id === id);
    return p ? projectLabel(p) : '';
  };
}

/** A project's color, as a dot: the same hue its time has everywhere. */
export function ProjectDot({ projectId, className }: { projectId?: string | null; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('project-dot', !projectId && 'project-dot-none', className)}
      style={projectId ? ({ '--hue': projectHue(projectId) } as CSSProperties) : undefined}
    />
  );
}

type Option = { id: string; name: string; group: string };

/**
 * Picks the project time is recorded on: a button that opens a list to
 * search, grouped by customer. A project that was archived since the entry
 * was made stays in the list while it is the value, so editing the entry
 * doesn't silently drop it.
 */
export function ProjectSelect({
  value,
  onChange,
  required,
  className,
  id,
  disabled,
  label,
}: {
  value: string;
  onChange: (projectId: string) => void;
  /** The organization requires a project on every entry. */
  required: boolean;
  className?: string;
  id?: string;
  disabled?: boolean;
  /** What the control is for, when it isn't simply "Project". */
  label?: string;
}) {
  const t = useTranslations('common.project');
  const active = useProjects();
  const all = useProjects(true);
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);

  const projects = active.data ?? [];
  const current = value ? (projects.find((p) => p.id === value) ?? all.data?.find((p) => p.id === value)) : undefined;
  const listed = current && !projects.includes(current) ? [current, ...projects] : projects;
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const options: Option[] = [
    ...(required ? [] : [{ id: '', name: t('none'), group: '' }]),
    ...listed.map((p) => ({ id: p.id, name: p.name, group: p.customerName })),
  ].filter((o) => words.every((w) => `${o.group} ${o.name}`.toLowerCase().includes(w)));
  const at = Math.min(cursor, Math.max(options.length - 1, 0));

  // A press outside closes the list.
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  const show = () => {
    setQuery('');
    setCursor(
      Math.max(
        0,
        options.findIndex((o) => o.id === value),
      ),
    );
    setOpen(true);
  };
  const pick = (projectId: string) => {
    setOpen(false);
    trigger.current?.focus();
    if (projectId !== value) onChange(projectId);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setCursor(Math.min(at + 1, options.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setCursor(Math.max(at - 1, 0));
        break;
      case 'Enter': {
        e.preventDefault();
        const o = options[at];
        if (o) pick(o.id);
        break;
      }
      case 'Escape':
        // The list closes; a dialog around it stays.
        e.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();
        setOpen(false);
        trigger.current?.focus();
        break;
      case 'Tab':
        setOpen(false);
        break;
    }
  };

  const shown = current ? projectLabel(current) : required ? t('choose') : t('none');
  return (
    <div ref={root} className={cn('relative', className)}>
      <button
        ref={trigger}
        id={id}
        type="button"
        className={cn(
          controlClass,
          'flex h-full min-h-9 cursor-pointer items-center gap-2 text-left disabled:cursor-not-allowed',
        )}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('picker', { label: label ?? t('label'), value: shown })}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            show();
          }
        }}
      >
        <ProjectDot projectId={current?.id} />
        <span className={cn('min-w-0 flex-1 truncate', !current && 'text-muted-foreground')}>{shown}</span>
        <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <div className="popover absolute top-full left-0 z-40 mt-1 w-72 max-w-[calc(100vw-2rem)]">
          <input
            className="w-full border-b border-border bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={options[at] ? `${listId}-${at}` : undefined}
            aria-label={t('search')}
            placeholder={t('search')}
            value={query}
            // biome-ignore lint/a11y/noAutofocus: opening the list is asking to search it
            autoFocus
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={onKeyDown}
          />
          <div id={listId} role="listbox" aria-label={label ?? t('label')} className="max-h-64 overflow-y-auto p-1">
            {options.length === 0 && (
              <p className="px-2 py-3 text-center text-sm text-muted-foreground">{t('noMatch')}</p>
            )}
            {options.map((o, i) => (
              <div key={o.id}>
                {o.group !== (options[i - 1]?.group ?? '') && (
                  <div className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">{o.group}</div>
                )}
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: the search field above holds focus and drives the list with the arrow keys */}
                <div
                  id={`${listId}-${i}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={o.id === value}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                    i === at && 'bg-muted',
                  )}
                  onPointerMove={() => setCursor(i)}
                  onClick={() => pick(o.id)}
                >
                  <ProjectDot projectId={o.id} />
                  <span className="min-w-0 flex-1 truncate">{o.name}</span>
                  {o.id === value && <CheckIcon aria-hidden className="size-3.5 shrink-0 text-primary" />}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
