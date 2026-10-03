import { useErrorMessage } from '@parallelworks/problem/react';
import { ArrowLeftIcon, ClockIcon, SignOutIcon, StopSolidIcon } from '@parallelworks/ui/icons';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/button';
import { useProjectName } from '@/components/project-select';
import { cn } from '@/lib/cn';
import { useClockOut } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { stopwatch } from '@/lib/time';
import { useNow } from '@/lib/use-now';

const navLink =
  'rounded-md px-2.5 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';
const navLinkActive = '!bg-muted !text-foreground';

/** The running clock, in the header of every page, so it is never out of sight. */
function RunningClock() {
  const t = useTranslations('shell.running');
  const errorMessage = useErrorMessage();
  const { running } = useSession();
  const projectName = useProjectName();
  const clockOut = useClockOut();
  const now = useNow(1000, !!running);
  if (!running) return null;
  const elapsed = Math.max(0, now - Date.parse(running.startedAt));
  return (
    <div className="flex items-center gap-2 rounded-md border border-success/30 bg-success-subtle py-1 pr-1 pl-2.5 text-success">
      <span className="relative flex size-2" aria-hidden>
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60 motion-reduce:hidden" />
        <span className="relative inline-flex size-2 rounded-full bg-success" />
      </span>
      <span className="sr-only">{t('label')}</span>
      <span className="hidden max-w-40 truncate text-xs sm:inline">{projectName(running.projectId)}</span>
      <span className="tabular text-sm font-semibold" role="timer">
        {stopwatch(elapsed)}
      </span>
      <Button
        variant="outline"
        size="sm"
        loading={clockOut.isPending}
        icon={<StopSolidIcon aria-hidden />}
        onClick={() =>
          clockOut.mutate(undefined, {
            onError: (err) => toast.error(t('stopFailed'), { description: errorMessage(err) }),
          })
        }
      >
        {t('stop')}
      </Button>
    </div>
  );
}

/** The frame every page sits in: where you are, where you can go, and the clock. */
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

  const links = [
    { to: '/', label: t('nav.today'), show: true, exact: true },
    { to: '/overview', label: t('nav.overview'), show: true },
    { to: '/timesheet', label: t('nav.timesheet'), show: true },
    { to: '/time-off', label: t('nav.timeOff'), show: true },
    { to: '/team', label: t('nav.team'), show: me.admin || me.manager },
    { to: '/reports', label: t('nav.reports'), show: true },
    { to: '/settings', label: t('nav.settings'), show: me.admin },
  ] as const;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:px-6">
          <Link to="/" className="flex shrink-0 items-center gap-2 font-semibold">
            <ClockIcon className="size-5 text-primary" aria-hidden />
            {t('name')}
          </Link>
          <nav aria-label={t('nav.label')} className="hidden items-center gap-0.5 md:flex">
            {links
              .filter((l) => l.show)
              .map((l) => (
                <Link
                  key={l.to}
                  to={l.to}
                  className={navLink}
                  activeProps={{ className: navLinkActive }}
                  activeOptions={{ exact: 'exact' in l }}
                >
                  {l.label}
                </Link>
              ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <RunningClock />
            {info.homeUrl && (
              <a href={info.homeUrl} className={cn(navLink, 'hidden items-center gap-1.5 lg:flex')}>
                <ArrowLeftIcon className="size-3.5" aria-hidden />
                {info.homeLabel ? t('home', { name: info.homeLabel }) : null}
              </a>
            )}
            <span className="hidden max-w-40 truncate text-sm text-muted-foreground lg:inline">{me.person.name}</span>
            {info.signOutUrl && (
              <Button variant="ghost" size="sm" aria-label={t('signOut')} onClick={signOut}>
                <SignOutIcon aria-hidden />
              </Button>
            )}
          </div>
        </div>
        {/* On a phone the sections scroll sideways under the bar. */}
        <nav
          aria-label={t('nav.label')}
          className="flex gap-0.5 overflow-x-auto border-t border-border px-3 py-1.5 md:hidden"
        >
          {links
            .filter((l) => l.show)
            .map((l) => (
              <Link
                key={l.to}
                to={l.to}
                className={cn(navLink, 'shrink-0')}
                activeProps={{ className: navLinkActive }}
                activeOptions={{ exact: 'exact' in l }}
              >
                {l.label}
              </Link>
            ))}
        </nav>
      </header>
      <div className="flex-1">{children}</div>
    </div>
  );
}
