import { ConfirmModal } from '@parallelworks/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { encode } from 'uqr';
import { useFormatter, useTranslations } from 'use-intl';
import { authInput } from '@/components/auth-page';
import { Button } from '@/components/button';
import { Field } from '@/components/field';
import { ErrorNote, Loading, Page, Panel } from '@/components/page';
import { Chip } from '@/components/status';
import { useAccount } from '@/components/workspace-switcher';
import { accounts, passkeysSupported } from '@/lib/accounts';
import { useSession } from '@/lib/session';

export const Route = createFileRoute('/account')({ component: AccountPage });

/** The otpauth link as a QR code an authenticator app scans. */
function QR({ value, label }: { value: string; label: string }) {
  const { data, size } = encode(value, { border: 2 });
  let path = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (data[y]?.[x]) path += `M${x} ${y}h1v1h-1z`;
    }
  }
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      className="size-44 rounded-md bg-white"
      shapeRendering="crispEdges"
    >
      <path d={path} fill="#000" />
    </svg>
  );
}

/** A dialog that asks for the password again before changing how the account signs in. */
function PasswordGate({
  title,
  description,
  confirmLabel,
  destructive,
  needed,
  onClose,
  run,
  children,
}: {
  title: string;
  description?: string;
  confirmLabel: string;
  destructive?: boolean;
  /** Whether the account has a password to ask for. */
  needed: boolean;
  onClose: () => void;
  run: (password: string) => Promise<void>;
  children?: ReactNode;
}) {
  const t = useTranslations('account');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  return (
    <ConfirmModal
      open
      onClose={onClose}
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      destructive={destructive}
      confirmDisabled={needed && !password}
      closeOnConfirm={false}
      onConfirm={async () => {
        try {
          await run(password);
        } catch (err) {
          setError(err);
        }
      }}
    >
      <div className="space-y-3">
        {children}
        {needed && (
          <Field label={t('confirmPassword')}>
            <input
              className={authInput}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        )}
        {error !== null && <ErrorNote error={error} />}
      </div>
    </ConfirmModal>
  );
}

/** Recovery codes, shown the one time they can be. */
function RecoveryCodes({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  const t = useTranslations('account.recovery');
  return (
    <ConfirmModal
      open
      onClose={onClose}
      title={t('title')}
      description={t('description')}
      confirmLabel={t('saved')}
      onConfirm={onClose}
    >
      <ul className="tabular grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-md bg-muted p-4 font-mono text-sm">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <Button
        className="mt-3"
        size="sm"
        onClick={() => {
          navigator.clipboard.writeText(codes.join('\n')).then(
            () => toast.success(t('copied')),
            () => toast.error(t('copyFailed')),
          );
        }}
      >
        {t('copy')}
      </Button>
    </ConfirmModal>
  );
}

type Dialog = 'password' | 'totp' | 'totp-off' | 'codes' | 'passkey' | null;

/** How the signed-in account signs in: its password, its authenticator, and its passkeys. */
function AccountPage() {
  const t = useTranslations('account');
  const format = useFormatter();
  const { info } = useSession();
  const account = useAccount();
  const client = useQueryClient();
  const security = useQuery({
    queryKey: ['account-security'],
    queryFn: accounts.security,
    enabled: !!info.accountsUrl,
  });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [keyName, setKeyName] = useState('');
  const [error, setError] = useState<unknown>(null);
  const refresh = () => client.invalidateQueries({ queryKey: ['account-security'] });
  const remove = useMutation({ mutationFn: accounts.removePasskey, onSuccess: refresh });
  const confirm = useMutation({
    mutationFn: () => accounts.totpConfirm(code),
    onSuccess: (list) => {
      setSetup(null);
      setCode('');
      setCodes(list);
      return refresh();
    },
  });

  if (!info.accountsUrl) {
    return (
      <Page title={t('title')}>
        <p className="text-sm text-muted-foreground">{t('hosted')}</p>
      </Page>
    );
  }
  if (security.isPending || account.isPending) return <Loading />;
  if (security.isError) {
    return (
      <Page title={t('title')}>
        <ErrorNote context={t('loadFailed')} error={security.error} />
      </Page>
    );
  }
  const s = security.data;
  const limited = !!account.data?.limited;
  const close = () => {
    setDialog(null);
    setCurrent('');
    setNext('');
    setKeyName('');
    setError(null);
  };
  const row = 'flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3';

  return (
    <Page title={t('title')} description={account.data?.account.email}>
      <div className="max-w-2xl space-y-4">
        {limited && (
          <p className="rounded-md bg-info-subtle px-3 py-2 text-sm text-info" role="note">
            {t('limited')}
          </p>
        )}

        <Panel flush title={t('password.title')}>
          <div className={row}>
            <p className="text-sm text-muted-foreground">{s.password ? t('password.set') : t('password.none')}</p>
            <Button disabled={limited || !s.password} onClick={() => setDialog('password')}>
              {t('password.change')}
            </Button>
          </div>
        </Panel>

        <Panel
          flush
          title={t('totp.title')}
          actions={s.totp ? <Chip tone="success">{t('on')}</Chip> : <Chip tone="neutral">{t('off')}</Chip>}
        >
          <div className={row}>
            <p className="min-w-0 flex-1 basis-64 text-sm text-muted-foreground">
              {s.totp ? t('totp.isOn') : t('totp.isOff')}
            </p>
            {s.totp ? (
              <Button variant="danger" disabled={limited} onClick={() => setDialog('totp-off')}>
                {t('totp.turnOff')}
              </Button>
            ) : (
              <Button variant="primary" disabled={limited} onClick={() => setDialog('totp')}>
                {t('totp.setUp')}
              </Button>
            )}
          </div>
          {setup && (
            <div className="flex flex-wrap gap-5 border-t border-border px-4 py-4">
              <QR value={setup.uri} label={t('totp.qr')} />
              <form
                className="min-w-0 flex-1 basis-60 space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  confirm.mutate();
                }}
              >
                <p className="text-sm">{t('totp.scan')}</p>
                <p className="text-xs text-muted-foreground">
                  {t('totp.manual')} <code className="tabular font-mono break-all text-foreground">{setup.secret}</code>
                </p>
                <Field label={t('totp.code')}>
                  <input
                    className={`${authInput} tabular font-mono tracking-widest`}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={7}
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </Field>
                {confirm.isError && <ErrorNote error={confirm.error} />}
                <Button type="submit" variant="primary" loading={confirm.isPending}>
                  {t('totp.turnOn')}
                </Button>
              </form>
            </div>
          )}
          {s.totp && (
            <div className={`${row} border-t border-border`}>
              <p className="text-sm text-muted-foreground">{t('recovery.left', { count: s.recoveryCodes })}</p>
              <Button disabled={limited} onClick={() => setDialog('codes')}>
                {t('recovery.renew')}
              </Button>
            </div>
          )}
        </Panel>

        <Panel
          flush
          title={t('passkeys.title')}
          actions={
            <Button
              size="sm"
              variant="primary"
              disabled={limited || !passkeysSupported()}
              onClick={() => setDialog('passkey')}
            >
              {t('passkeys.add')}
            </Button>
          }
        >
          <p className="px-4 py-3 text-sm text-muted-foreground">{t('passkeys.about')}</p>
          {s.passkeys.length > 0 && (
            <ul className="divide-y divide-border border-t border-border">
              {s.passkeys.map((k) => (
                <li key={k.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate font-medium">{k.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {k.lastUsedAt
                      ? t('passkeys.used', {
                          date: format.dateTime(new Date(k.lastUsedAt), {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                          }),
                        })
                      : t('passkeys.added', {
                          date: format.dateTime(new Date(k.createdAt), {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                          }),
                        })}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t('passkeys.removeFor', { name: k.name })}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(k.id)}
                  >
                    {t('passkeys.remove')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {remove.isError && <ErrorNote className="m-3" error={remove.error} />}
        </Panel>
      </div>

      {dialog === 'password' && (
        <ConfirmModal
          open
          onClose={close}
          title={t('password.change')}
          description={t('password.description')}
          confirmLabel={t('password.change')}
          confirmDisabled={next.length < 10}
          closeOnConfirm={false}
          onConfirm={async () => {
            try {
              await accounts.changePassword(current, next);
              toast.success(t('password.changed'));
              close();
            } catch (err) {
              setError(err);
            }
          }}
        >
          <div className="space-y-3">
            <input type="email" autoComplete="username" value={account.data?.account.email ?? ''} readOnly hidden />
            <Field label={t('password.current')}>
              <input
                className={authInput}
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </Field>
            <Field label={t('password.next')} hint={t('password.rule')}>
              <input
                className={authInput}
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
            </Field>
            {error !== null && <ErrorNote error={error} />}
          </div>
        </ConfirmModal>
      )}
      {dialog === 'totp' && (
        <PasswordGate
          title={t('totp.setUp')}
          description={t('totp.gate')}
          confirmLabel={t('continue')}
          needed={s.password}
          onClose={close}
          run={async (password) => {
            setSetup(await accounts.totpSetup(password));
            close();
          }}
        />
      )}
      {dialog === 'totp-off' && (
        <PasswordGate
          title={t('totp.turnOff')}
          description={t('totp.offDescription')}
          confirmLabel={t('totp.turnOff')}
          destructive
          needed={s.password}
          onClose={close}
          run={async (password) => {
            await accounts.totpDisable(password);
            await refresh();
            close();
          }}
        />
      )}
      {dialog === 'codes' && (
        <PasswordGate
          title={t('recovery.renew')}
          description={t('recovery.renewDescription')}
          confirmLabel={t('recovery.renew')}
          needed={s.password}
          onClose={close}
          run={async (password) => {
            setCodes(await accounts.renewRecoveryCodes(password));
            await refresh();
            close();
          }}
        />
      )}
      {dialog === 'passkey' && (
        <PasswordGate
          title={t('passkeys.add')}
          description={t('passkeys.gate')}
          confirmLabel={t('continue')}
          needed={s.password}
          onClose={close}
          run={async (password) => {
            await accounts.addPasskey(password, keyName);
            await refresh();
            close();
          }}
        >
          <Field label={t('passkeys.name')} hint={t('passkeys.nameHint')}>
            <input className={authInput} maxLength={60} value={keyName} onChange={(e) => setKeyName(e.target.value)} />
          </Field>
        </PasswordGate>
      )}
      {codes && <RecoveryCodes codes={codes} onClose={() => setCodes(null)} />}
    </Page>
  );
}
