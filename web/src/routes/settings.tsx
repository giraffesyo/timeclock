import { createFileRoute, Link } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { Page } from '@/components/page';
import { Appearance } from '@/components/settings/appearance';
import { Catalog } from '@/components/settings/catalog';
import { History } from '@/components/settings/history';
import { PayrollSettings } from '@/components/settings/payroll';
import { People } from '@/components/settings/people';
import { SignIn } from '@/components/settings/sso';
import { cn } from '@/lib/cn';
import { useSession } from '@/lib/session';

const TABS = ['payroll', 'projects', 'people', 'appearance', 'signin', 'history'] as const;
type Tab = (typeof TABS)[number];

const isTab = (value: unknown): value is Tab => TABS.includes(value as Tab);

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
  // Payroll is the default, so it stays out of the URL.
  validateSearch: (search: Record<string, unknown>): { tab?: Tab } =>
    isTab(search['tab']) && search['tab'] !== 'payroll' ? { tab: search['tab'] } : {},
});

function SettingsPage() {
  const t = useTranslations('settings');
  const { admin } = useSession();
  const { tab = 'payroll' } = Route.useSearch();

  if (!admin) {
    return (
      <Page title={t('title')}>
        <p className="text-sm text-muted-foreground">{t('adminOnly')}</p>
      </Page>
    );
  }

  return (
    <Page title={t('title')} description={t('description')} wide={tab === 'people' || tab === 'history'}>
      <nav aria-label={t('title')} className="mb-4 flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((name) => (
          <Link
            key={name}
            to="/settings"
            search={name === 'payroll' ? {} : { tab: name }}
            aria-current={name === tab ? 'page' : undefined}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors',
              name === tab
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`tabs.${name}`)}
          </Link>
        ))}
      </nav>
      {tab === 'payroll' && <PayrollSettings />}
      {tab === 'projects' && <Catalog />}
      {tab === 'people' && <People />}
      {tab === 'appearance' && <Appearance />}
      {tab === 'signin' && <SignIn />}
      {tab === 'history' && <History />}
    </Page>
  );
}
