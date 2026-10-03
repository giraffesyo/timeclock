import { ConfirmModal, TOOLTIP_ID } from '@parallelworks/ui';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/button';
import { controlClass, Field } from '@/components/field';
import { ErrorNote } from '@/components/page';
import { useSetOwnTimezone } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { browserZone, timeZones, useZone } from '@/lib/zone';

/** A zone as people say it: "Chicago", "Los Angeles". */
export const zoneCity = (zone: string) => (zone.split('/').pop() ?? zone).replaceAll('_', ' ');

/** Sets the caller's own time zone. */
function ZoneDialog({ onClose }: { onClose: () => void }) {
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
        <select className={controlClass} value={zone} onChange={(e) => setZone(e.target.value)}>
          <option value="">{t('organization', { zone: settings.timezone })}</option>
          {timeZones(zone).map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
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
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-info-subtle px-4 py-2.5 text-sm text-info">
      <p className="min-w-0 flex-1 basis-64">{t('banner', { here: zoneCity(here), zone: zoneCity(zone) })}</p>
      <div className="flex gap-2">
        <Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate(here)}>
          {t('switch', { zone: zoneCity(here) })}
        </Button>
        <Button size="sm" onClick={keep}>
          {t('keep', { zone: zoneCity(zone) })}
        </Button>
      </div>
      {save.isError && <ErrorNote className="basis-full" context={t('saveFailed')} error={save.error} />}
    </div>
  );
}
