import { useQuery } from '@tanstack/react-query';
import { createRootRoute, Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useTranslations } from 'use-intl';
import { api, unwrap } from '@/api/client';
import { Button } from '@/components/button';
import { ErrorNote, Loading } from '@/components/page';
import { Shell } from '@/components/shell';
import { Toaster } from '@/components/toaster';
import { AppUIProvider } from '@/components/ui-provider';
import { useMe } from '@/lib/queries';
import { SessionProvider } from '@/lib/session';
import { adoptHostTheme, setTheme } from '@/lib/theme';

export const Route = createRootRoute({
  component: Root,
  notFoundComponent: NotFound,
});

// Pages for someone who isn't signed in yet: they render without a session.
const PUBLIC = ['/login', '/invite', '/forgot', '/reset'];

function Root() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  return (
    <AppUIProvider>
      {PUBLIC.includes(path.replace(/\/$/, '')) ? <Public /> : <Session />}
      <Toaster />
    </AppUIProvider>
  );
}

/** A page outside the app, wearing the workspace's or host's look all the same. */
function Public() {
  const info = useQuery({
    queryKey: ['info'],
    queryFn: async () => unwrap(await api.GET('/api/v1/info')),
  });
  const theme = info.data?.theme;
  useEffect(() => {
    if (info.data) setTheme(theme);
  }, [info.data, theme]);
  return <Outlet />;
}

/** Loads who is calling before any page renders, so pages can assume it. */
function Session() {
  const t = useTranslations('shell');
  const me = useMe();
  const themeKey = me.data?.info.themeStorageKey;
  useEffect(() => {
    if (me.data) adoptHostTheme(themeKey);
  }, [me.data, themeKey]);
  const theme = me.data?.info.theme;
  useEffect(() => {
    if (me.data) setTheme(theme);
  }, [me.data, theme]);

  if (me.data) {
    return (
      <SessionProvider value={me.data}>
        <Shell>
          <Outlet />
        </Shell>
      </SessionProvider>
    );
  }
  if (me.isError) {
    return (
      <div className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center gap-3 px-4 text-center">
        <ErrorNote context={t('loadFailed')} error={me.error} />
        <Button loading={me.isFetching} onClick={() => me.refetch()}>
          {t('retry')}
        </Button>
      </div>
    );
  }
  return <Loading className="min-h-screen items-center" />;
}

function NotFound() {
  const t = useTranslations('shell.notFound');
  return (
    <main className="mx-auto max-w-md space-y-2 px-4 py-24">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <p className="text-sm text-muted-foreground">{t('description')}</p>
      <Link to="/" className="text-sm text-primary hover:underline">
        {t('home')}
      </Link>
    </main>
  );
}
