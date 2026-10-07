import { TOOLTIP_ID } from '@parallelworks/ui';
import { CalendarIcon, CloseIcon } from '@parallelworks/ui/icons';
import { useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { Button, buttonClass } from '@/components/button';
import { ErrorNote, Loading, Panel } from '@/components/page';
import { basePath } from '@/lib/base';
import { useCalendarEvents, useDisconnectGoogleCalendar, useGoogleCalendar } from '@/lib/queries';
import { useSession } from '@/lib/session';
import type { Day } from '@/lib/time';

const DISMISSED = 'timeclock.calendar-prompt';

/**
 * Where connecting a calendar starts: a visit to Google, and back to `path`
 * in the app. It is a page, not a call, so it is an ordinary link.
 */
export const connectHref = (path: string) =>
  `${basePath}/api/v1/calendar/google/connect?return=${encodeURIComponent(path)}`;

/** Where the browser is in the app, to come back to. */
const here = () => window.location.pathname.slice(basePath.length) + window.location.search || '/';

/**
 * Offers to connect the caller's Google Calendar above their week, where
 * they could and haven't. Dismissed, it stays away on this browser; the
 * calendar settings still connect it.
 */
export function CalendarBanner({ from, to }: { from: Day; to: Day }) {
  const t = useTranslations('calendar');
  const { info } = useSession();
  // The week's own read: the same query, so no second request.
  const calendar = useCalendarEvents(from, to, !!info.calendar);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED) === '1';
    } catch {
      return true; // storage blocked: don't nag on every page load
    }
  });
  if (dismissed || !calendar.data?.connectable || calendar.data.connected) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED, '1');
    } catch {
      // Not remembered; it offers again next time.
    }
    setDismissed(true);
  };
  return (
    <div className="flex items-start gap-2 rounded-lg bg-info-subtle py-2 pr-2 pl-4 text-sm text-info">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2 py-0.5">
        <p>{t('banner')}</p>
        <a href={connectHref(here())} className={buttonClass('primary', 'sm')}>
          <CalendarIcon aria-hidden className="size-4" />
          {t('connect')}
        </a>
      </div>
      <Button
        size="sm"
        variant="ghost"
        className="w-7 px-0 text-info"
        icon={<CloseIcon aria-hidden />}
        aria-label={t('notNow')}
        data-tooltip-id={TOOLTIP_ID}
        data-tooltip-content={t('notNow')}
        onClick={dismiss}
      />
    </div>
  );
}

/** The caller's Google Calendar, in their settings: connect it, see which account, or disconnect it. */
export function CalendarSettings({ outcome }: { outcome?: 'denied' | 'failed' }) {
  const t = useTranslations('calendar');
  const format = useFormatter();
  const status = useGoogleCalendar();
  const disconnect = useDisconnectGoogleCalendar();
  if (!status.data) return status.isError ? <ErrorNote context={t('loadFailed')} error={status.error} /> : <Loading />;
  const s = status.data;
  return (
    <Panel title={t('title')} className="w-full max-w-3xl">
      <div className="space-y-3 text-sm">
        {s.managed ? (
          <p>{t('managed')}</p>
        ) : !s.connectable ? (
          <p className="text-muted-foreground">{t('unavailable')}</p>
        ) : s.connected ? (
          <>
            <p>
              {t.rich('connected', {
                account: s.account || t('yourAccount'),
                strong: (chunks) => <strong className="font-medium">{chunks}</strong>,
              })}
              {s.connectedAt && (
                <span className="text-muted-foreground">
                  {' '}
                  {t('since', { date: format.dateTime(new Date(s.connectedAt), { dateStyle: 'medium' }) })}
                </span>
              )}
            </p>
            <p className="text-muted-foreground">{t('what')}</p>
            <Button variant="danger" loading={disconnect.isPending} onClick={() => disconnect.mutate()}>
              {t('disconnect')}
            </Button>
            {disconnect.isError && <ErrorNote context={t('disconnectFailed')} error={disconnect.error} />}
          </>
        ) : (
          <>
            <p>{t('intro')}</p>
            <p className="text-muted-foreground">{t('what')}</p>
            {outcome && (
              <p role="alert" className="text-danger">
                {t(outcome)}
              </p>
            )}
            <a href={connectHref('/settings?tab=calendar')} className={buttonClass('primary')}>
              <CalendarIcon aria-hidden className="size-4" />
              {t('connect')}
            </a>
          </>
        )}
      </div>
    </Panel>
  );
}
