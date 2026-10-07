import { CloseIcon, CopyIcon, NewWindowIcon, StartIcon } from '@parallelworks/ui/icons';
import { useFormatter, useTranslations } from 'use-intl';
import { Button, buttonClass } from '@/components/button';
import { useContinue } from '@/components/clock-bar';
import { EntryPopover } from '@/components/entry-dialog';
import type { CalendarEvent } from '@/lib/queries';

/**
 * An event on the caller's calendar, opened from beside their time: what it
 * is and when, with the clock to start on it, a button that copies it onto
 * the week, and the way back to it in Google Calendar. A meeting copied
 * before says which project it copies to, and can change it.
 */
export function CalendarEventPopover({
  event,
  calendar,
  zone,
  anchor,
  projectName,
  onCopy,
  onClose,
}: {
  event: CalendarEvent;
  /** The calendar's name, normally its owner's email address. */
  calendar?: string;
  zone: string;
  anchor: HTMLElement;
  /** The project a remembered meeting copies to; absent when it isn't remembered. */
  projectName?: string;
  /** Copies the event onto the week, asking for its project when `ask`; absent when the day takes no more. */
  onCopy?: (ask: boolean) => void;
  onClose: () => void;
}) {
  const t = useTranslations('timeline');
  const format = useFormatter();
  const again = useContinue();
  const title = event.title || t('untitled');
  const time = (iso: string) => format.dateTime(new Date(iso), { hour: 'numeric', minute: '2-digit', timeZone: zone });
  return (
    <EntryPopover anchor={anchor} onClose={onClose} title={t('eventTitle')}>
      <div className="mb-2 flex min-h-8 items-center gap-1">
        <Button
          variant="primary"
          className="!size-9 !rounded-full !p-0"
          aria-label={t('eventStart')}
          title={t('eventStart')}
          icon={<StartIcon aria-hidden className="!size-5" />}
          onClick={() => {
            again.start({ note: event.title });
            onClose();
          }}
        />
        {onCopy && (
          <Button
            variant="ghost"
            className="!size-9 !p-0"
            aria-label={projectName ? t('eventCopyTo', { project: projectName }) : t('eventCopy')}
            title={projectName ? t('eventCopyTo', { project: projectName }) : t('eventCopy')}
            icon={<CopyIcon aria-hidden className="!size-5" />}
            onClick={() => onCopy(false)}
          />
        )}
        {event.link && (
          <a
            href={event.link}
            target="_blank"
            rel="noreferrer"
            className={buttonClass('ghost', 'md', '!size-9 !p-0')}
            aria-label={t('eventOpen')}
            title={t('eventOpen')}
          >
            <NewWindowIcon aria-hidden className="!size-5" />
          </a>
        )}
        <span className="flex-1" />
        <Button
          variant="ghost"
          className="!size-8 !p-0"
          aria-label={t('eventClose')}
          title={t('eventClose')}
          icon={<CloseIcon aria-hidden className="!size-4" />}
          onClick={onClose}
        />
      </div>
      <h2 className="text-base font-semibold break-words">{title}</h2>
      {calendar && <p className="mt-1 text-sm break-all text-muted-foreground">{t('eventSource', { calendar })}</p>}
      <p className="tabular mt-1 text-sm">{t('range', { start: time(event.startedAt), end: time(event.endedAt) })}</p>
      {projectName && onCopy && (
        <p className="mt-2 flex flex-wrap items-baseline gap-x-2 text-sm text-muted-foreground">
          {t('eventCopiesTo', { project: projectName })}
          <button
            type="button"
            className="cursor-pointer text-primary underline-offset-2 hover:underline"
            onClick={() => onCopy(true)}
          >
            {t('eventChange')}
          </button>
        </p>
      )}
    </EntryPopover>
  );
}
