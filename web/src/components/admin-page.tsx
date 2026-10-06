import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { Page } from '@/components/page';
import { useSession } from '@/lib/session';

/** A page only an admin uses: anyone else is told who can. */
export function AdminPage({
  title,
  description,
  wide,
  children,
}: {
  title: string;
  description?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  const t = useTranslations('settings');
  const { admin } = useSession();
  if (!admin) {
    return (
      <Page title={title}>
        <p className="text-sm text-muted-foreground">{t('adminOnly')}</p>
      </Page>
    );
  }
  return (
    <Page title={title} description={description} wide={wide}>
      {children}
    </Page>
  );
}
