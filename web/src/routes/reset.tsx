import { createFileRoute, Link } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { useTranslations } from 'use-intl';
import { AuthPage, authInput } from '@/components/auth-page';
import { Button } from '@/components/button';
import { Field } from '@/components/field';
import { ErrorNote } from '@/components/page';
import { accounts } from '@/lib/accounts';
import { basePath } from '@/lib/base';

export const Route = createFileRoute('/reset')({
  component: ResetPage,
  validateSearch: (search: Record<string, unknown>): { token?: string } => ({
    token: typeof search['token'] === 'string' ? search['token'] : undefined,
  }),
});

function ResetPage() {
  const t = useTranslations('auth.reset');
  const { token = '' } = Route.useSearch();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await accounts.resetPassword(token, password);
      window.location.assign(`${basePath}/`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <AuthPage
      title={t('title')}
      intro={t('intro')}
      footer={
        <Link to="/forgot" className="underline-offset-4 hover:text-foreground hover:underline">
          {t('again')}
        </Link>
      }
    >
      <form className="space-y-4" onSubmit={submit}>
        <Field label={t('password')} hint={t('rule')}>
          <input
            className={authInput}
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            // biome-ignore lint/a11y/noAutofocus: the page is this form
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {error !== null && <ErrorNote error={error} />}
        <Button type="submit" variant="primary" className="h-10 w-full" loading={busy}>
          {t('submit')}
        </Button>
      </form>
    </AuthPage>
  );
}
