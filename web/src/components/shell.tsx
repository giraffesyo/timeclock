import { useErrorMessage } from '@parallelworks/problem/react';
import { TOOLTIP_ID } from '@parallelworks/ui';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'use-intl';
import { ClockBar } from '@/components/clock-bar';
import {
  BackIcon,
  BrandIcon,
  MoonIcon,
  OverviewIcon,
  ReportsIcon,
  SettingsIcon,
  SignOutIcon,
  SunIcon,
  SystemIcon,
  TeamIcon,
  TimeOffIcon,
  TimerIcon,
  TimesheetIcon,
} from '@/components/nav-icons';
import { ZoneButton } from '@/components/zone';
import { useSession } from '@/lib/session';
import { onThemeChange, readPreference, setPreference } from '@/lib/theme';

const item =
  'flex h-8 items-center gap-2.5 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground md:h-7';
const itemActive = '!bg-foreground/[0.07] !font-medium !text-foreground';

const MODES = [
  { value: 'light', icon: <SunIcon /> },
  { value: 'dark', icon: <MoonIcon /> },
  { value: 'system', icon: <SystemIcon /> },
] as const;

/** Light, dark, or whatever the system is in. Inside a host this is the host's own choice, kept in step. */
function ModeSwitch({ compact }: { compact?: boolean }) {
  const t = useTranslations('shell.mode');
  const preference = useSyncExternalStore(onThemeChange, readPreference);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a legend the sidebar has no room for
    <div role="group" aria-label={t('label')} className={compact ? 'flex gap-px' : 'flex gap-px px-1 pt-1'}>
      {MODES.map((m) => (
        <button
          key={m.value}
          type="button"
          className="shell-icon-button"
          aria-label={t(m.value)}
          aria-pressed={preference === m.value}
          data-tooltip-id={TOOLTIP_ID}
          data-tooltip-content={t(m.value)}
          onClick={() => setPreference(m.value)}
        >
          {m.icon}
        </button>
      ))}
    </div>
  );
}

/**
 * The frame every page sits in: the sections down the side, and the page on
 * a sheet beside them with the clock across its top. On a phone the sections
 * are a strip above the clock.
 */
export function Shell({ children }: { children: ReactNode }) {
  const t = useTranslations('shell');
  const errorMessage = useErrorMessage();
  const me = useSession();
  const { info } = me;

  const signOut = async () => {
    if (!info.signOutUrl) return;
    try {
      const res = await fetch(info.signOutUrl, { method: 'POST' });
      const body = (await res.json().catch(() => null)) as { redirectUrl?: string } | null;
      window.location.assign(body?.redirectUrl || info.homeUrl || '/');
    } catch (err) {
      toast.error(t('signOutFailed'), { description: errorMessage(err) });
    }
  };

  const groups = [
    {
      label: t('nav.groups.track'),
      links: [
        { to: '/', label: t('nav.today'), icon: <TimerIcon />, exact: true },
        { to: '/overview', label: t('nav.overview'), icon: <OverviewIcon /> },
      ],
    },
    {
      label: t('nav.groups.yours'),
      links: [
        { to: '/timesheet', label: t('nav.timesheet'), icon: <TimesheetIcon /> },
        { to: '/time-off', label: t('nav.timeOff'), icon: <TimeOffIcon /> },
      ],
    },
    {
      label: t('nav.groups.payroll'),
      links: [
        ...(me.admin || me.manager ? [{ to: '/team', label: t('nav.team'), icon: <TeamIcon /> }] : []),
        { to: '/reports', label: t('nav.reports'), icon: <ReportsIcon /> },
        ...(me.admin ? [{ to: '/settings', label: t('nav.settings'), icon: <SettingsIcon /> }] : []),
      ],
    },
  ];
  const links = groups.flatMap((g) => g.links);
  const link = (l: (typeof links)[number], className?: string) => (
    <Link
      key={l.to}
      to={l.to}
      className={className ? `${item} ${className}` : item}
      activeProps={{ className: itemActive }}
      activeOptions={{ exact: 'exact' in l }}
    >
      {l.icon}
      {l.label}
    </Link>
  );

  return (
    <div className="shell">
      <aside className="shell-side">
        <Link to="/" className="flex h-9 items-center gap-2 px-2 text-sm font-semibold">
          <BrandIcon className="text-primary" />
          {t('name')}
        </Link>
        <nav aria-label={t('nav.label')} className="mt-3 flex flex-1 flex-col gap-4 overflow-y-auto">
          {groups.map((g) => (
            <div key={g.label}>
              <div className="px-2 pb-1 text-xs text-muted-foreground/80">{g.label}</div>
              <div className="flex flex-col gap-px">{g.links.map((l) => link(l))}</div>
            </div>
          ))}
        </nav>
        <div className="flex flex-col gap-px border-t border-border pt-2">
          {info.homeUrl && (
            <a href={info.homeUrl} className={item}>
              <BackIcon />
              {info.homeLabel ? t('home', { name: info.homeLabel }) : null}
            </a>
          )}
          <div className="flex h-8 items-center gap-2 pr-1 pl-2">
            <span className="min-w-0 flex-1 truncate text-sm">{me.person.name}</span>
            <ZoneButton className="shell-zone tabular" />
            {info.signOutUrl && (
              <button type="button" className="shell-icon-button" aria-label={t('signOut')} onClick={signOut}>
                <SignOutIcon />
              </button>
            )}
          </div>
          <ModeSwitch />
        </div>
      </aside>

      {/* A phone: the name and the way out, then the sections as a strip. */}
      <header className="shell-top">
        <div className="flex h-12 items-center gap-2 px-4">
          <Link to="/" className="flex items-center gap-2 text-sm font-semibold">
            <BrandIcon className="text-primary" />
            {t('name')}
          </Link>
          <span className="ml-auto" />
          <ModeSwitch compact />
          <ZoneButton className="shell-zone tabular" />
          {info.signOutUrl && (
            <button type="button" className="shell-icon-button" aria-label={t('signOut')} onClick={signOut}>
              <SignOutIcon />
            </button>
          )}
        </div>
        <nav aria-label={t('nav.label')} className="flex gap-1 overflow-x-auto px-3 pb-2">
          {links.map((l) => link(l, 'shrink-0'))}
          {info.homeUrl && (
            <a href={info.homeUrl} className={`${item} shrink-0`}>
              <BackIcon />
              {info.homeLabel ? t('home', { name: info.homeLabel }) : null}
            </a>
          )}
        </nav>
      </header>

      <div className="shell-sheet">
        <ClockBar />
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
