import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { useTranslations } from 'use-intl';
import { AuthPage, authInput } from '@/components/auth-page';
import { Button } from '@/components/button';
import { Field } from '@/components/field';
import { ErrorNote, Loading } from '@/components/page';
import { accounts } from '@/lib/accounts';
import { basePath } from '@/lib/base';

export const Route = createFileRoute('/invite')({
  component: InvitePage,
  validateSearch: (search: Record<string, unknown>): { token?: string } => ({
    token: typeof search['token'] === 'string' ? search['token'] : undefined,
  }),
});

function InvitePage() {
  const t = useTranslations('auth.invite');
  const { token = '' } = Route.useSearch();
  const invitation = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => accounts.invitation(token),
    retry: false,
  });
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const out = await accounts.acceptInvite(token, name, password);
      // An account with an authenticator still owes its code.
      window.location.assign(out.secondStep ? `${basePath}/login?step=second` : `${basePath}/`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  if (invitation.isPending) return <Loading className="min-h-screen items-center" />;
  if (invitation.isError) {
    return (
      <AuthPage title={t('goneTitle')}>
        <ErrorNote error={invitation.error} />
      </AuthPage>
    );
  }
  const { email, workspace, hasAccount } = invitation.data;
  const place = workspace || t('unnamed');
  return (
    <AuthPage
      title={t('title', { workspace: place })}
      intro={hasAccount ? t('introKnown', { email }) : t('introNew', { email })}
    >
      <form className="space-y-4" onSubmit={submit}>
        {/* The address is fixed, and here so a password manager files the password under it. */}
        <input type="email" autoComplete="username" value={email} readOnly hidden />
        {!hasAccount && (
          <Field label={t('name')}>
            <input
              className={authInput}
              autoComplete="name"
              required
              maxLength={120}
              // biome-ignore lint/a11y/noAutofocus: the page is this form
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
        )}
        <Field label={hasAccount ? t('passwordKnown') : t('passwordNew')} hint={hasAccount ? undefined : t('rule')}>
          <input
            className={authInput}
            type="password"
            autoComplete={hasAccount ? 'current-password' : 'new-password'}
            required
            minLength={hasAccount ? undefined : 10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {error !== null && <ErrorNote error={error} />}
        <Button type="submit" variant="primary" className="h-10 w-full" loading={busy}>
          {t('submit', { workspace: place })}
        </Button>
      </form>
    </AuthPage>
  );
}
