import { Popover, PopoverButton, PopoverPanel } from '@headlessui/react';
import { useErrorMessage } from '@parallelworks/problem/react';
import { Avatar, TOOLTIP_ID } from '@parallelworks/ui';
import { Link, useMatchRoute } from '@tanstack/react-router';
import { type ReactNode, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'use-intl';
import { ClockBar } from '@/components/clock-bar';
import {
  BackIcon,
  BrandIcon,
  HistoryIcon,
  IntegrationsIcon,
  KeyIcon,
  MoonIcon,
  OverviewIcon,
  PeopleIcon,
  ProjectsIcon,
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
import { WorkspaceSwitcher } from '@/components/workspace-switcher';
import { ZoneDialog, zoneCity } from '@/components/zone';
import { useSession } from '@/lib/session';
import { onThemeChange, readPreference, setPreference } from '@/lib/theme';
import { useZone } from '@/lib/zone';

// The ring is drawn inside: the scrolling nav would clip one outside the link.
const item =
  'flex h-8 items-center gap-2.5 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-offset-[-2px] md:h-7';
const itemActive = '!bg-(--sidebar-wash) !font-medium !text-foreground [&_svg]:text-(--sidebar-accent)';

const MODES = [
  { value: 'light', icon: <SunIcon /> },
  { value: 'dark', icon: <MoonIcon /> },
  { value: 'system', icon: <SystemIcon /> },
] as const;

/** Light, dark, or whatever the system is in. Inside a host this is the host's own choice, kept in step. */
function ModeSwitch() {
  const t = useTranslations('shell.mode');
  const preference = useSyncExternalStore(onThemeChange, readPreference);
  return (
    <fieldset aria-label={t('label')} className="flex gap-1">
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
    </fieldset>
  );
}

const userAction =
  'flex min-h-10 w-full cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm hover:bg-(--theme-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

function UserMenu({ mobile = false }: { mobile?: boolean }) {
  const t = useTranslations('shell');
  const tz = useTranslations('zone');
  const errorMessage = useErrorMessage();
  const { person, avatarUrl, info } = useSession();
  const zone = useZone();
  const [zoneOpen, setZoneOpen] = useState(false);
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

  return (
    <>
      <Popover className={mobile ? 'ml-auto min-w-0 max-w-[60%]' : 'min-w-0'}>
        {({ close }) => (
          <>
            <PopoverButton
              aria-label={t('userMenu', { name: person.name })}
              className="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-foreground/5 data-open:bg-foreground/5"
            >
              <Avatar src={avatarUrl || person.avatarUrl} name={person.name} size="sm" className="shrink-0" />
              <span className="min-w-0 flex-1 wrap-anywhere">{person.name}</span>
            </PopoverButton>
            <PopoverPanel
              anchor={mobile ? 'bottom end' : 'top start'}
              focus
              className="popover z-50 w-72 max-w-[calc(100vw-1rem)] p-1 [--anchor-gap:8px] [--anchor-padding:8px]"
            >
              <Link to="/settings" className={userAction} onClick={() => close()}>
                <SettingsIcon />
                {t('nav.settings')}
              </Link>
              {info.accountsUrl && (
                <Link to="/account" className={userAction} onClick={() => close()}>
                  <KeyIcon />
                  {t('account')}
                </Link>
              )}
              <button
                type="button"
                className={userAction}
                aria-label={tz('button', { zone })}
                onClick={() => {
                  close();
                  setZoneOpen(true);
                }}
              >
                <BrandIcon />
                <span>{tz('label')}</span>
                <span className="ml-auto truncate text-xs text-muted-foreground">{zoneCity(zone)}</span>
              </button>
              <div className="flex min-h-10 items-center justify-between gap-3 px-3 py-1">
                <span className="text-sm">{t('theme')}</span>
                <ModeSwitch />
              </div>
              {info.signOutUrl && (
                <div className="mt-1 border-t border-border pt-1">
                  <button type="button" className={userAction} onClick={signOut}>
                    <SignOutIcon />
                    {t('signOut')}
                  </button>
                </div>
              )}
            </PopoverPanel>
          </>
        )}
      </Popover>
      {zoneOpen && <ZoneDialog onClose={() => setZoneOpen(false)} />}
    </>
  );
}

/** The page frame, with sidebar navigation on desktop and a top strip on phones. */
export function Shell({ children }: { children: ReactNode }) {
  const t = useTranslations('shell');
  const me = useSession();
  const { info } = me;
  // The clock bar belongs to the Timer page; elsewhere the page has the room.
  const onTimer = !!useMatchRoute()({ to: '/' });

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
        ...(me.admin ? [{ to: '/history', label: t('nav.history'), icon: <HistoryIcon /> }] : []),
      ],
    },
    // What an admin changes week to week; Settings holds what is set once.
    ...(me.admin
      ? [
          {
            label: t('nav.groups.manage'),
            links: [
              { to: '/people', label: t('nav.people'), icon: <PeopleIcon /> },
              { to: '/projects', label: t('nav.projects'), icon: <ProjectsIcon /> },
              { to: '/integrations', label: t('nav.integrations'), icon: <IntegrationsIcon /> },
              { to: '/settings', label: t('nav.settings'), icon: <SettingsIcon /> },
            ],
          },
        ]
      : []),
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
        <WorkspaceSwitcher />
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
          <UserMenu />
        </div>
      </aside>

      {/* A phone: the name and the way out, then the sections as a strip. */}
      <header className="shell-top">
        <div className="flex min-h-12 items-center gap-2 px-4">
          <Link to="/" className="flex items-center gap-2 text-sm font-semibold">
            <BrandIcon className="text-primary" />
            {t('name')}
          </Link>
          <UserMenu mobile />
        </div>
        <nav aria-label={t('nav.label')} className="flex gap-1 overflow-x-auto overflow-y-hidden px-3 pb-2">
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
        {onTimer && <ClockBar />}
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
