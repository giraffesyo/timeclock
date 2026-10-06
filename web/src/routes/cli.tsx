import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { AuthPage, authInput } from '@/components/auth-page';
import { Button } from '@/components/button';
import { Field } from '@/components/field';
import { Loading } from '@/components/page';
import { accounts } from '@/lib/accounts';
import { basePath } from '@/lib/base';

export const Route = createFileRoute('/cli')({
  component: CLIAuthorization,
  validateSearch: (search: Record<string, unknown>) => ({
    request: typeof search['request'] === 'string' ? search['request'] : undefined,
    user_code: typeof search['user_code'] === 'string' ? search['user_code'] : undefined,
  }),
});

function CLIAuthorization() {
  const t = useTranslations('cli');
  const search = Route.useSearch();
  const session = useQuery({ queryKey: ['account-session'], queryFn: accounts.session, retry: false });
  const [code, setCode] = useState(search.user_code ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<'approved' | 'denied' | null>(null);
  const account = session.data?.session;

  useEffect(() => {
    if (session.data?.available && !account) {
      window.location.replace(
        `${basePath}/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`,
      );
    }
  }, [session.data, account]);

  const decide = async (approve: boolean) => {
    if (!account) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`${basePath}/auth/cli/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request: search.request,
          userCode: search.request ? undefined : code,
          approve,
          workspace: account.workspace,
        }),
      });
      const out = await response.json();
      if (!response.ok) throw new Error(out.error_description ?? t('failed'));
      if (out.redirectUrl) {
        window.location.assign(out.redirectUrl);
      } else {
        setDone(approve ? 'approved' : 'denied');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failed'));
    } finally {
      setBusy(false);
    }
  };

  if (done)
    return (
      <AuthPage title={t(done)} intro={t('returnToTerminal')}>
        <p role="status">{t('closeTab')}</p>
      </AuthPage>
    );
  if (session.isError || session.data?.available === false) {
    return (
      <AuthPage title={t('title')}>
        <p role="alert">{t('unavailable')}</p>
      </AuthPage>
    );
  }
  if (!account) return <Loading className="min-h-screen items-center" />;
  const workspace = account.workspaces.find((w) => w.key === account.workspace);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void decide(true);
  };

  return (
    <AuthPage title={t('title')} intro={t('intro')}>
      <form onSubmit={submit} className="space-y-4">
        <dl className="space-y-2 text-sm">
          <div>
            <dt className="text-muted-foreground">{t('account')}</dt>
            <dd className="break-words font-medium">{account.account.email}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('workspace')}</dt>
            <dd className="break-words font-medium">{workspace?.name || account.workspace || t('noWorkspace')}</dd>
          </div>
        </dl>
        <p className="text-sm text-muted-foreground">{t('permissions')}</p>
        {!search.request && (
          <Field label={t('code')}>
            <input
              className={`${authInput} font-mono uppercase tracking-widest`}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              maxLength={9}
              autoComplete="off"
              spellCheck={false}
              placeholder={t('codePlaceholder')}
            />
          </Field>
        )}
        <p className="text-sm font-medium">{search.request ? t('confirmBrowser') : t('confirmDevice')}</p>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" variant="primary" className="flex-1" loading={busy} disabled={!account.workspace}>
            {t('approve')}
          </Button>
          <Button type="button" disabled={busy || !account.workspace} onClick={() => void decide(false)}>
            {t('deny')}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{t('changeWorkspace')}</p>
      </form>
    </AuthPage>
  );
}
