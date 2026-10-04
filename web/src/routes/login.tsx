import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { AuthPage, authInput } from '@/components/auth-page';
import { Button, buttonClass } from '@/components/button';
import { Field } from '@/components/field';
import { ErrorNote } from '@/components/page';
import { accounts, passkeysSupported, safeNext } from '@/lib/accounts';

interface Search {
  /** Where to go once signed in. */
  next?: string;
  error?: string;
  /** "second" comes back from an invitation or reset that still owes the second step. */
  step?: 'second';
}

export const Route = createFileRoute('/login')({
  component: LoginPage,
  validateSearch: (search: Record<string, unknown>): Search => ({
    next: typeof search['next'] === 'string' ? search['next'] : undefined,
    error: search['error'] === 'sso' ? 'sso' : undefined,
    step: search['step'] === 'second' ? 'second' : undefined,
  }),
});

type Step =
  | { name: 'email' }
  | { name: 'password'; sso: { workspace: string; name: string }[]; password: boolean }
  | { name: 'second'; passkey: boolean };

/**
 * Signing in, a step at a time: who you are, then how. An address whose
 * workspace has its own single sign-on is offered that; an account with an
 * authenticator is asked for its code after the password; and a passkey
 * does the whole thing at once.
 */
function LoginPage() {
  const t = useTranslations('auth.login');
  const search = Route.useSearch();
  const next = safeNext(search.next);
  const session = useQuery({ queryKey: ['account-session'], queryFn: accounts.session, retry: false });
  const [step, setStep] = useState<Step>(
    search.step === 'second' ? { name: 'second', passkey: false } : { name: 'email' },
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // Already signed in: on to where they were going.
  const signedIn = !!session.data?.session;
  useEffect(() => {
    if (signedIn) window.location.replace(next);
  }, [signedIn, next]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const done = () => window.location.assign(next);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (step.name === 'email') {
      return run(async () => setStep({ name: 'password', ...(await accounts.start(email)) }));
    }
    if (step.name === 'password') {
      return run(async () => {
        const out = await accounts.login(email, password);
        if (out.secondStep) setStep({ name: 'second', passkey: out.passkey });
        else done();
      });
    }
    return run(async () => {
      await accounts.second(recovery ? { recovery: code } : { code });
      done();
    });
  };
  const passkey = () =>
    run(async () => {
      await accounts.passkeyLogin();
      done();
    });

  const title = step.name === 'second' ? t('secondTitle') : t('title');
  return (
    <AuthPage
      title={title}
      intro={step.name === 'second' ? (recovery ? t('recoveryIntro') : t('secondIntro')) : undefined}
    >
      <form className="space-y-4" onSubmit={submit}>
        {step.name !== 'second' && (
          <Field label={t('email')}>
            <input
              className={authInput}
              type="email"
              autoComplete="username webauthn"
              required
              readOnly={step.name === 'password'}
              // biome-ignore lint/a11y/noAutofocus: the page is this form
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
        )}
        {step.name === 'password' && step.password && (
          <Field label={t('password')}>
            <input
              className={authInput}
              type="password"
              autoComplete="current-password"
              required
              // biome-ignore lint/a11y/noAutofocus: the step is this field
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        )}
        {step.name === 'second' && (
          <Field label={recovery ? t('recovery') : t('code')}>
            <input
              className={`${authInput} tabular font-mono tracking-widest`}
              inputMode={recovery ? 'text' : 'numeric'}
              autoComplete="one-time-code"
              required
              maxLength={recovery ? 12 : 7}
              // biome-ignore lint/a11y/noAutofocus: the step is this field
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
        )}
        {error !== null && <ErrorNote error={error} />}
        {search.error === 'sso' && error === null && step.name === 'email' && (
          <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger">
            {t('ssoFailed')}
          </p>
        )}
        {(step.name !== 'password' || step.password) && (
          <Button type="submit" variant="primary" className="h-10 w-full" loading={busy}>
            {step.name === 'email' ? t('continue') : step.name === 'password' ? t('submit') : t('verify')}
          </Button>
        )}
        {step.name === 'password' && !step.password && step.sso.length > 0 && (
          <p className="text-sm text-muted-foreground">{t('ssoOnly')}</p>
        )}
        {step.name === 'password' &&
          step.sso.map((s) => (
            <a
              key={s.workspace}
              href={accounts.workspaceSSOUrl(s.workspace, next)}
              className={buttonClass('outline', 'md', 'h-10 w-full')}
            >
              {t('ssoFor', { workspace: s.name || s.workspace })}
            </a>
          ))}
        {step.name === 'email' && session.data?.sso && (
          <a href={accounts.ssoUrl(next)} className={buttonClass('outline', 'md', 'h-10 w-full')}>
            {t('sso')}
          </a>
        )}
        {step.name !== 'password' && passkeysSupported() && (step.name === 'email' || step.passkey) && (
          <Button className="h-10 w-full" disabled={busy} onClick={passkey}>
            {t('passkey')}
          </Button>
        )}
        <p className="flex justify-center gap-4 text-center text-sm">
          {step.name === 'email' && (
            <Link
              to="/forgot"
              className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              {t('forgot')}
            </Link>
          )}
          {step.name === 'password' && (
            <button
              type="button"
              className="cursor-pointer text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              onClick={() => {
                setStep({ name: 'email' });
                setPassword('');
                setError(null);
              }}
            >
              {t('otherEmail')}
            </button>
          )}
          {step.name === 'second' && (
            <button
              type="button"
              className="cursor-pointer text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              onClick={() => {
                setRecovery(!recovery);
                setCode('');
                setError(null);
              }}
            >
              {recovery ? t('useCode') : t('useRecovery')}
            </button>
          )}
        </p>
      </form>
    </AuthPage>
  );
}
