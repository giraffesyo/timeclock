import { ConfirmModal, TOOLTIP_ID } from '@parallelworks/ui';
import { CloseIcon } from '@parallelworks/ui/icons';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/button';
import { Field } from '@/components/field';
import { ErrorNote } from '@/components/page';
import { ZoneSelect } from '@/components/zone-select';
import { useSetOwnTimezone } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { browserZone, useZone } from '@/lib/zone';

/** A zone as people say it: "Chicago", "Los Angeles". */
export const zoneCity = (zone: string) => (zone.split('/').pop() ?? zone).replaceAll('_', ' ');

/** Sets the caller's own time zone. */
export function ZoneDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations('zone');
  const tc = useTranslations('common');
  const { person, settings } = useSession();
  const save = useSetOwnTimezone();
  const [zone, setZone] = useState(person.timezone);
  const here = browserZone();
  return (
    <ConfirmModal
      open
      onClose={onClose}
      title={t('title')}
      description={t('description')}
      confirmLabel={tc('save')}
      closeOnConfirm={false}
      onConfirm={async () => {
        try {
          await save.mutateAsync(zone);
          onClose();
        } catch {
          // Shown below from save.error; the dialog stays open to fix it.
        }
      }}
    >
      <Field label={t('label')}>
        <ZoneSelect value={zone} onChange={setZone} defaultLabel={t('organization', { zone: settings.timezone })} />
      </Field>
      {(zone || settings.timezone) !== here && (
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => setZone(here)}>
          {t('useBrowser', { zone: here })}
        </Button>
      )}
      {save.isError && <ErrorNote className="mt-3" context={t('saveFailed')} error={save.error} />}
    </ConfirmModal>
  );
}

/** The zone the caller's times are in, as its short name; it opens the dialog that changes it. */
export function ZoneButton({ className }: { className?: string }) {
  const t = useTranslations('zone');
  const zone = useZone();
  const [open, setOpen] = useState(false);
  // The zone's short name ("CDT"), which Intl gives only as part of a date.
  const short =
    new Intl.DateTimeFormat(undefined, { timeZone: zone, timeZoneName: 'short' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')?.value ?? zoneCity(zone);
  return (
    <>
      <button
        type="button"
        className={className}
        aria-label={t('button', { zone })}
        data-tooltip-id={TOOLTIP_ID}
        data-tooltip-content={t('button', { zone })}
        onClick={() => setOpen(true)}
      >
        {short}
      </button>
      {open && <ZoneDialog onClose={() => setOpen(false)} />}
    </>
  );
}

const DISMISSED = 'timeclock-zone-kept';

/**
 * Says so when the browser is in another time zone than the caller's times
 * are shown in, and offers to switch. Keeping the zone is remembered for
 * that pair, so it asks again only if either changes.
 */
export function ZoneBanner() {
  const t = useTranslations('zone');
  const zone = useZone();
  const save = useSetOwnTimezone();
  const here = browserZone();
  const pair = `${here}>${zone}`;
  const [kept, setKept] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED);
    } catch {
      return pair; // storage blocked: don't nag on every page load
    }
  });
  if (!here || here === zone || kept === pair) return null;
  const keep = () => {
    try {
      localStorage.setItem(DISMISSED, pair);
    } catch {
      // Not remembered; it asks again next time.
    }
    setKept(pair);
  };
  return (
    <div className="flex items-start gap-2 rounded-lg bg-info-subtle py-2 pr-2 pl-4 text-sm text-info">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2 py-0.5">
        <p>{t('banner', { here: zoneCity(here), zone: zoneCity(zone) })}</p>
        <Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate(here)}>
          {t('switch', { zone: zoneCity(here) })}
        </Button>
        {save.isError && <ErrorNote className="basis-full" context={t('saveFailed')} error={save.error} />}
      </div>
      <Button
        size="sm"
        variant="ghost"
        className="w-7 px-0 text-info"
        icon={<CloseIcon aria-hidden />}
        aria-label={t('keep', { zone: zoneCity(zone) })}
        data-tooltip-id={TOOLTIP_ID}
        data-tooltip-content={t('keep', { zone: zoneCity(zone) })}
        onClick={keep}
      />
    </div>
  );
}
