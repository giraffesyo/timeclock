import { projectLabel } from '@giraffesyo/timeclock';
import { ProjectPicker } from '@giraffesyo/timeclock/react';
import type { CSSProperties } from 'react';
import { useTranslations } from 'use-intl';
import { cn } from '@/lib/cn';
import { useProjects } from '@/lib/queries';
import { projectHue } from '@/lib/timeline';

export { projectLabel };

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

/**
 * Picks the project time is recorded on: @giraffesyo/timeclock's picker,
 * over the projects that take new time. A project that was archived since
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
  const archived = value && !projects.some((p) => p.id === value) ? all.data?.find((p) => p.id === value) : undefined;
  return (
    <ProjectPicker
      id={id}
      className={className}
      projects={archived ? [archived, ...projects] : projects}
      value={value}
      onChange={onChange}
      required={required}
      disabled={disabled}
      label={label}
      labels={{
        project: t('label'),
        none: t('none'),
        choose: t('choose'),
        search: t('search'),
        noMatch: t('noMatch'),
      }}
    />
  );
}
