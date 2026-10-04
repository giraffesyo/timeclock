import { createFileRoute, Link } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { useTranslations } from 'use-intl';
import { AuthPage, authInput } from '@/components/auth-page';
import { Button } from '@/components/button';
import { Field } from '@/components/field';
import { ErrorNote } from '@/components/page';
import { accounts } from '@/lib/accounts';

export const Route = createFileRoute('/forgot')({ component: ForgotPage });

function ForgotPage() {
  const t = useTranslations('auth.forgot');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await accounts.forgotPassword(email);
      setSent(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const back = (
    <Link to="/login" className="underline-offset-4 hover:text-foreground hover:underline">
      {t('back')}
    </Link>
  );

  if (sent) {
    return (
      <AuthPage title={t('sentTitle')} footer={back}>
        <p className="text-sm text-muted-foreground" role="status">
          {t('sent', { email })}
        </p>
      </AuthPage>
    );
  }
  return (
    <AuthPage title={t('title')} intro={t('intro')} footer={back}>
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
        {error !== null && <ErrorNote error={error} />}
        <Button type="submit" variant="primary" className="h-10 w-full" loading={busy}>
          {t('submit')}
        </Button>
      </form>
    </AuthPage>
  );
}
