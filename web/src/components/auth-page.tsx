import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { BrandIcon } from '@/components/nav-icons';

/** The page someone not yet signed in sees: one small form, and nothing else. */
export function AuthPage({
  title,
  intro,
  children,
  footer,
}: {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const t = useTranslations('shell');
  return (
    <main className="auth-ground">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2 text-sm font-semibold">
          <BrandIcon className="text-primary" />
          {t('name')}
        </div>
        <div className="rounded-xl border border-border bg-background p-6 shadow-sm">
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          {intro && <p className="mt-1 text-sm text-muted-foreground">{intro}</p>}
          <div className="mt-5">{children}</div>
        </div>
        {footer && <div className="mt-4 text-center text-sm text-muted-foreground">{footer}</div>}
      </div>
    </main>
  );
}

/** The class names of a full-size field on an auth page. */
export const authInput =
  'h-10 w-full rounded-md border border-border bg-(--theme-input-bg) px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring';
