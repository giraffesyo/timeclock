import { useTranslations } from 'use-intl';
import { controlClass } from '@/components/field';
import { cn } from '@/lib/cn';
import { type Project, useProjects } from '@/lib/queries';

/** Projects grouped by customer, in the order the API lists them. */
function byCustomer(projects: Project[]): [string, Project[]][] {
  const groups = new Map<string, Project[]>();
  for (const p of projects) {
    groups.set(p.customerName, [...(groups.get(p.customerName) ?? []), p]);
  }
  return [...groups];
}

/**
 * Picks the project time is recorded on. A project that was archived since
 * the entry was made stays in the list while it is the value, so editing the
 * entry doesn't silently drop it.
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
  const projects = active.data ?? [];
  const current = value && !projects.some((p) => p.id === value) ? all.data?.find((p) => p.id === value) : undefined;
  return (
    <select
      id={id}
      aria-label={label ?? t('label')}
      className={cn(controlClass, className)}
      value={value}
      required={required}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{required ? t('choose') : t('none')}</option>
      {current && <option value={current.id}>{`${current.customerName} / ${current.name}`}</option>}
      {byCustomer(projects).map(([customer, list]) => (
        <optgroup key={customer} label={customer}>
          {list.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/** "Customer / Project" for a project id, or the no-project label. */
export function useProjectName() {
  const t = useTranslations('common.project');
  const all = useProjects(true);
  return (id?: string | null) => {
    if (!id) return t('none');
    const p = all.data?.find((x) => x.id === id);
    return p ? `${p.customerName} / ${p.name}` : '';
  };
}
