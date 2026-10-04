import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { AuthPage, authInput } from '@/components/auth-page';
import { Button, buttonClass } from '@/components/button';
import { Field } from '@/components/field';
import { ErrorNote } from '@/components/page';
import { accounts, safeNext } from '@/lib/accounts';

interface Search {
  /** Where to go once signed in. */
  next?: string;
  error?: string;
}

export const Route = createFileRoute('/login')({
  component: LoginPage,
  validateSearch: (search: Record<string, unknown>): Search => ({
    next: typeof search['next'] === 'string' ? search['next'] : undefined,
    error: search['error'] === 'sso' ? 'sso' : undefined,
  }),
});

function LoginPage() {
  const t = useTranslations('auth.login');
  const search = Route.useSearch();
  const next = safeNext(search.next);
  const session = useQuery({ queryKey: ['account-session'], queryFn: accounts.session, retry: false });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // Already signed in: on to where they were going.
  const signedIn = !!session.data?.session;
  useEffect(() => {
    if (signedIn) window.location.replace(next);
  }, [signedIn, next]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await accounts.login(email, password);
      window.location.assign(next);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <AuthPage title={t('title')}>
      <form className="space-y-4" onSubmit={submit}>
        <Field label={t('email')}>
          <input
            className={authInput}
            type="email"
            autoComplete="username"
            required
            // biome-ignore lint/a11y/noAutofocus: the page is this form
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label={t('password')}>
          <input
            className={authInput}
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {error !== null && <ErrorNote error={error} />}
        {search.error === 'sso' && error === null && (
          <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger">
            {t('ssoFailed')}
          </p>
        )}
        <Button type="submit" variant="primary" className="h-10 w-full" loading={busy}>
          {t('submit')}
        </Button>
        {session.data?.sso && (
          <a href={accounts.ssoUrl(next)} className={buttonClass('outline', 'md', 'h-10 w-full')}>
            {t('sso')}
          </a>
        )}
        <p className="text-center text-sm">
          <Link to="/forgot" className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            {t('forgot')}
          </Link>
        </p>
      </form>
    </AuthPage>
  );
}
