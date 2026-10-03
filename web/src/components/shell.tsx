import { useErrorMessage } from '@parallelworks/problem/react';
import { ArrowLeftIcon, ClockIcon, SignOutIcon } from '@parallelworks/ui/icons';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/button';
import { ClockBar } from '@/components/clock-bar';
import { cn } from '@/lib/cn';
import { useSession } from '@/lib/session';

const navLink =
  'rounded-md px-2.5 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';
const navLinkActive = '!bg-muted !text-foreground';

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
      <header className="top-0 z-30 bg-background/95 backdrop-blur md:sticky">
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
        <ClockBar />
      </header>
      <div className="flex-1">{children}</div>
    </div>
  );
}
