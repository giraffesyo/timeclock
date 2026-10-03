import { useErrorMessage } from '@parallelworks/problem/react';
import { LoaderIcon } from '@parallelworks/ui/icons';
import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { cn } from '@/lib/cn';

/** A page: a title row with actions, then its content. */
export function Page({
  title,
  description,
  actions,
  children,
  wide,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** Use the full width, for tables with many columns. */
  wide?: boolean;
}) {
  return (
    <main className={cn('mx-auto w-full px-4 py-6 sm:px-6', wide ? 'max-w-7xl' : 'max-w-5xl')}>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </main>
  );
}

/** A bordered section of a page, with an optional heading row. */
export function Panel({
  title,
  actions,
  children,
  className,
  flush,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** No padding around the content, for a table that runs edge to edge. */
  flush?: boolean;
}) {
  return (
    <section className={cn('rounded-lg border border-border bg-card text-card-foreground', className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={flush ? undefined : 'p-4'}>{children}</div>
    </section>
  );
}

/** What a list shows when it has nothing: one line saying so, and what to do. */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-8 text-center text-sm text-muted-foreground">{children}</p>;
}

/** A failure, in words: the context, then the reason from the API. */
export function ErrorNote({ context, error, className }: { context?: string; error: unknown; className?: string }) {
  const errorMessage = useErrorMessage();
  return (
    <p role="alert" className={cn('rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger', className)}>
      {context && <span className="font-medium">{context} </span>}
      {errorMessage(error)}
    </p>
  );
}

/** A centered spinner while something loads. */
export function Loading({ className }: { className?: string }) {
  const t = useTranslations('ui');
  return (
    <div role="status" aria-label={t('loading')} className={cn('flex justify-center py-10', className)}>
      <LoaderIcon className="size-5 text-muted-foreground" />
    </div>
  );
}
