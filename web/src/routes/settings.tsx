import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { CalendarSettings } from '@/components/calendar-connect';
import { CalendarFeedSettings } from '@/components/calendar-feed';
import { Page } from '@/components/page';
import { Appearance } from '@/components/settings/appearance';
import { PayrollSettings } from '@/components/settings/payroll';
import { SignIn } from '@/components/settings/sso';
import { cn } from '@/lib/cn';
import { useSession } from '@/lib/session';

const TABS = ['payroll', 'signin', 'appearance', 'calendar'] as const;
/** Everyone's own, beside the admins' workspace settings. */
const PERSONAL: readonly Tab[] = ['appearance', 'calendar'];
type Tab = (typeof TABS)[number];

const isTab = (value: unknown): value is Tab => TABS.includes(value as Tab);

/** Tabs that became pages of their own: old links still land on them. */
const MOVED = { people: '/people', projects: '/projects', integrations: '/integrations', history: '/history' } as const;
type Moved = keyof typeof MOVED;
const isMoved = (value: unknown): value is Moved => typeof value === 'string' && Object.hasOwn(MOVED, value);

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
  // Payroll is the default, so it stays out of the URL.
  validateSearch: (search: Record<string, unknown>): { tab?: Tab | Moved; calendar?: 'denied' | 'failed' } => ({
    ...((isTab(search['tab']) && search['tab'] !== 'payroll') || isMoved(search['tab']) ? { tab: search['tab'] } : {}),
    // How connecting a calendar went, when it didn't.
    ...(search['calendar'] === 'denied' || search['calendar'] === 'failed' ? { calendar: search['calendar'] } : {}),
  }),
  beforeLoad: ({ search }) => {
    if (isMoved(search.tab)) throw redirect({ to: MOVED[search.tab], replace: true });
  },
});

function SettingsPage() {
  const t = useTranslations('settings');
  const { admin, info } = useSession();
  const { tab: requestedTab, calendar } = Route.useSearch();
  const shown = TABS.filter((name) => admin || PERSONAL.includes(name));
  const tab = (isTab(requestedTab) ? requestedTab : undefined) ?? (admin ? 'payroll' : 'appearance');

  if (!shown.includes(tab)) {
    return (
      <Page title={t('title')}>
        <p className="text-sm text-muted-foreground">{t('adminOnly')}</p>
      </Page>
    );
  }

  return (
    <Page title={t('title')} description={t('description')}>
      <nav aria-label={t('title')} className="mb-4 flex gap-1 overflow-x-auto overflow-y-hidden border-b border-border">
        {shown.map((name) => (
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
      {tab === 'calendar' && (
        <div className="space-y-4">
          {/* Reading a Google Calendar is there where the server can. */}
          {info.calendar && <CalendarSettings outcome={calendar} />}
          <CalendarFeedSettings />
        </div>
      )}
    </Page>
  );
}
