import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { Page } from '@/components/page';
import { Appearance } from '@/components/settings/appearance';
import { PayrollSettings } from '@/components/settings/payroll';
import { SignIn } from '@/components/settings/sso';
import { cn } from '@/lib/cn';
import { useSession } from '@/lib/session';

const TABS = ['payroll', 'signin', 'appearance'] as const;
type Tab = (typeof TABS)[number];

const isTab = (value: unknown): value is Tab => TABS.includes(value as Tab);

/** Tabs that became pages of their own: old links still land on them. */
const MOVED = { people: '/people', projects: '/projects', integrations: '/integrations', history: '/history' } as const;
type Moved = keyof typeof MOVED;
const isMoved = (value: unknown): value is Moved => typeof value === 'string' && Object.hasOwn(MOVED, value);

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
  // Payroll is the default, so it stays out of the URL.
  validateSearch: (search: Record<string, unknown>): { tab?: Tab | Moved } =>
    (isTab(search['tab']) && search['tab'] !== 'payroll') || isMoved(search['tab']) ? { tab: search['tab'] } : {},
  beforeLoad: ({ search }) => {
    if (isMoved(search.tab)) throw redirect({ to: MOVED[search.tab], replace: true });
  },
});

function SettingsPage() {
  const t = useTranslations('settings');
  const { admin } = useSession();
  const { tab: requestedTab } = Route.useSearch();
  const tab = (isTab(requestedTab) ? requestedTab : undefined) ?? (admin ? 'payroll' : 'appearance');

  if (!admin && tab !== 'appearance') {
    return (
      <Page title={t('title')}>
        <p className="text-sm text-muted-foreground">{t('adminOnly')}</p>
      </Page>
    );
  }

  return (
    <Page title={t('title')} description={t('description')}>
      <nav aria-label={t('title')} className="mb-4 flex gap-1 overflow-x-auto overflow-y-hidden border-b border-border">
        {TABS.filter((name) => admin || name === 'appearance').map((name) => (
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
      {tab === 'appearance' && <Appearance />}
      {tab === 'signin' && <SignIn />}
    </Page>
  );
}
