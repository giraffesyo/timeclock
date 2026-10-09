import { CalendarIcon } from '@parallelworks/ui/icons';
import { useState } from 'react';
import { toast } from 'sonner';
import { useFormatter, useTranslations } from 'use-intl';
import { Button, buttonClass } from '@/components/button';
import { controlClass } from '@/components/field';
import { ErrorNote, Loading, Panel } from '@/components/page';
import { SwitchRow } from '@/components/settings/switch';
import {
  type FeedContents,
  useCalendarFeed,
  useCreateCalendarFeed,
  useStopCalendarFeed,
  useUpdateCalendarFeed,
} from '@/lib/queries';

const CONTENTS = ['holidays', 'timeOff', 'trackedTime'] as const;

/** Where Google Calendar subscribes to a feed: it asks, then adds it. */
const googleHref = (feed: string) =>
  `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(feed.replace(/^https?:/, 'webcal:'))}`;

/**
 * The caller's calendar feed, in their settings: a secret link a calendar
 * app subscribes to, of what they choose: the company's holidays, who is
 * out, and their own tracked time. The link is shown once, when it is made;
 * the choice can change at the same link.
 */
export function CalendarFeedSettings() {
  const t = useTranslations('calendar.feed');
  const format = useFormatter();
  const status = useCalendarFeed();
  const create = useCreateCalendarFeed();
  const stop = useStopCalendarFeed();
  const update = useUpdateCalendarFeed();
  // The choice as last made here, ahead of what the server has.
  const [draft, setDraft] = useState<FeedContents>();
  const [nothing, setNothing] = useState(false);
  if (!status.data) return status.isError ? <ErrorNote context={t('loadFailed')} error={status.error} /> : <Loading />;
  const made = create.data?.path ? window.location.origin + create.data.path : undefined;
  const s = status.data;
  const contents: FeedContents = draft ?? {
    holidays: s.holidays,
    timeOff: s.timeOff,
    trackedTime: s.trackedTime,
  };
  const choose = (key: (typeof CONTENTS)[number], on: boolean) => {
    const next = { ...contents, [key]: on };
    const none = !CONTENTS.some((k) => next[k]);
    setNothing(none);
    if (none) return;
    // Shown at once, so quick changes build on each other, not on the last save.
    setDraft(next);
    if (s.enabled) update.mutate(next, { onError: () => setDraft(undefined) });
  };
  return (
    <Panel title={t('title')} className="w-full max-w-3xl">
      <div className="space-y-3 text-sm">
        <p>{t('intro')}</p>
        <div className="space-y-3 rounded-md border border-border p-3">
          {CONTENTS.map((key) => (
            <SwitchRow
              key={key}
              label={t(key)}
              hint={t(`${key}Hint`)}
              value={contents[key]}
              onChange={(on) => choose(key, on)}
            />
          ))}
        </div>
        {nothing && (
          <p role="alert" className="text-danger">
            {t('nothing')}
          </p>
        )}
        {update.isError && <ErrorNote context={t('saveFailed')} error={update.error} />}
        <p className="text-muted-foreground">{t('private')}</p>
        {made ? (
          <div className="space-y-3 rounded-md bg-info-subtle p-3">
            <p className="text-info">{t('once')}</p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                className={`${controlClass} min-w-0 flex-1 basis-64 font-mono text-xs`}
                readOnly
                aria-label={t('link')}
                value={made}
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button
                onClick={() => {
                  navigator.clipboard.writeText(made).then(
                    () => toast.success(t('copied')),
                    () => toast.error(t('copyFailed')),
                  );
                }}
              >
                {t('copy')}
              </Button>
              <a href={googleHref(made)} target="_blank" rel="noreferrer" className={buttonClass('primary')}>
                <CalendarIcon aria-hidden className="size-4" />
                {t('google')}
              </a>
            </div>
            <p className="text-muted-foreground">{t('googleDelay')}</p>
          </div>
        ) : s.enabled ? (
          <p>
            {t('on', { date: format.dateTime(new Date(s.createdAt ?? Date.now()), { dateStyle: 'medium' }) })}{' '}
            <span className="text-muted-foreground">{t('lost')}</span>
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {s.enabled ? (
            <>
              <Button loading={create.isPending} onClick={() => create.mutate(contents)}>
                {t('remake')}
              </Button>
              <Button
                variant="danger"
                loading={stop.isPending}
                onClick={() =>
                  stop.mutate(undefined, {
                    onSuccess: () => {
                      create.reset();
                      setDraft(contents);
                    },
                  })
                }
              >
                {t('off')}
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              icon={<CalendarIcon aria-hidden />}
              loading={create.isPending}
              onClick={() => create.mutate(contents)}
            >
              {t('make')}
            </Button>
          )}
        </div>
        {create.isError && <ErrorNote context={t('makeFailed')} error={create.error} />}
        {stop.isError && <ErrorNote context={t('offFailed')} error={stop.error} />}
      </div>
    </Panel>
  );
}
