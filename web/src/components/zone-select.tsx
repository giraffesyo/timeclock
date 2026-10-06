import { Combobox, ComboboxButton, ComboboxInput, ComboboxOption, ComboboxOptions } from '@headlessui/react';
import { CheckIcon } from '@parallelworks/ui/icons';
import { useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { controlClass } from '@/components/field';
import { cn } from '@/lib/cn';
import { browserZone, timeZones } from '@/lib/zone';

interface Zone {
  /** The IANA name, or '' for the default. */
  value: string;
  city: string;
  /** Where the city is: "America", "America / Argentina". */
  region: string;
  /** Now, as "UTC−5" or "UTC+5:30". */
  offset: string;
  /** Its abbreviation now ("CDT"), where it has one. */
  short: string;
  /** Everything a search can match, folded. */
  search: string;
}

/**
 * Cities whose zone browsers still name the old way (Chrome lists
 * Asia/Calcutta, not Asia/Kolkata). Shown and searched by today's name;
 * the old one still matches.
 */
const RENAMED: Record<string, string> = {
  'Africa/Asmera': 'Asmara',
  'America/Coral_Harbour': 'Atikokan',
  'America/Godthab': 'Nuuk',
  'Asia/Calcutta': 'Kolkata',
  'Asia/Katmandu': 'Kathmandu',
  'Asia/Rangoon': 'Yangon',
  'Asia/Saigon': 'Ho Chi Minh',
  'Atlantic/Faeroe': 'Faroe',
  'Europe/Kiev': 'Kyiv',
  'Pacific/Enderbury': 'Kanton',
  'Pacific/Ponape': 'Pohnpei',
  'Pacific/Truk': 'Chuuk',
};

/** The row shown, not chosen, when nothing matches. */
const NONE = '\u0000none';

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[_/]+/g, ' ');

/** A zone's offset and abbreviation now, as Intl gives them. */
function describe(zone: string, now: Date): Zone {
  const part = (style: 'shortOffset' | 'short') =>
    new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: style })
      .formatToParts(now)
      .find((p) => p.type === 'timeZoneName')?.value ?? '';
  const offset = part('shortOffset').replace(/^GMT/, 'UTC').replace('-', '−') || 'UTC';
  const short = part('short');
  const parts = zone.split('/');
  const named = (parts.pop() ?? zone).replaceAll('_', ' ');
  const city = RENAMED[zone] ?? named;
  const region = parts.join(' / ').replaceAll('_', ' ');
  // "GMT+2" says nothing an offset doesn't.
  const abbreviation = /^(GMT|UTC)/.test(short) ? '' : short;
  // Both signs, so "-5" and "−5" find the same zones.
  const search = fold(`${zone} ${city} ${named} ${region} ${offset} ${offset.replace('−', '-')} ${abbreviation}`);
  return { value: zone, city, region, offset, short: abbreviation, search };
}

/**
 * Chooses a time zone by typing any of its city, region, abbreviation or
 * offset. With `defaultLabel`, an empty value is a choice of its own.
 */
export function ZoneSelect({
  value,
  onChange,
  defaultLabel,
  className,
}: {
  value: string;
  onChange: (zone: string) => void;
  /** The label of '', when the zone can be left to a default. */
  defaultLabel?: string;
  className?: string;
}) {
  const t = useTranslations('zone.picker');
  const [query, setQuery] = useState('');
  const zones = useMemo(() => {
    const now = new Date();
    const here = browserZone();
    const all = timeZones(value).map((z) => describe(z, now));
    // The browser's own zone first: it is the likeliest choice.
    return [...all.filter((z) => z.value === here), ...all.filter((z) => z.value !== here)];
  }, [value]);
  const choices = defaultLabel
    ? [{ value: '', city: defaultLabel, region: '', offset: '', short: '', search: fold(defaultLabel) }, ...zones]
    : zones;
  const words = fold(query).split(/\s+/).filter(Boolean);
  const shown = words.length ? choices.filter((z) => words.every((w) => z.search.includes(w))) : choices;
  const byValue = new Map(choices.map((z) => [z.value, z]));
  const label = (zone: string) => {
    const z = byValue.get(zone);
    if (!z) return zone;
    return z.value ? `${z.city} (${z.value}) · ${z.offset}` : z.city;
  };

  return (
    <Combobox
      value={value}
      onChange={(zone: string | null) => {
        if (zone !== null && zone !== NONE) onChange(zone);
      }}
      onClose={() => setQuery('')}
      // Hundreds of zones: only the rows in view are rendered.
      virtual={{ options: shown.length ? shown.map((z) => z.value) : [NONE], disabled: (zone) => zone === NONE }}
      immediate
    >
      <div className={cn('relative', className)}>
        <ComboboxInput
          className={cn(controlClass, 'pr-8')}
          displayValue={label}
          placeholder={t('search')}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          autoComplete="off"
          spellCheck={false}
        />
        <ComboboxButton className="absolute inset-y-0 right-0 flex w-8 cursor-pointer items-center justify-center text-muted-foreground">
          <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
            <path d="m5 6 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </ComboboxButton>
      </div>
      <ComboboxOptions
        anchor="bottom start"
        // Not modal: the input keeps its label, and the dialog stays usable, while the list is open.
        modal={false}
        className="popover z-[10000] max-h-72 w-(--input-width) min-w-72 overflow-y-auto p-1 [--anchor-gap:4px] [--anchor-padding:8px] focus:outline-none"
      >
        {({ option }: { option: string }) => {
          if (option === NONE) {
            return (
              <ComboboxOption value={NONE} disabled className="px-2 py-2 text-sm text-muted-foreground">
                {t('empty', { query })}
              </ComboboxOption>
            );
          }
          const z = byValue.get(option);
          if (!z) return <ComboboxOption value={option} />;
          return (
            <ComboboxOption
              value={z.value}
              className="group flex h-11 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-sm data-focus:bg-muted"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">{z.city}</span>
                {z.region && <span className="block truncate text-xs text-muted-foreground">{z.region}</span>}
              </span>
              {z.value && (
                <span className="tabular shrink-0 text-right text-xs text-muted-foreground">
                  {z.short && <span className="mr-1.5">{z.short}</span>}
                  {z.offset}
                </span>
              )}
              <CheckIcon className="invisible size-3.5 shrink-0 text-primary group-data-selected:visible" aria-hidden />
            </ComboboxOption>
          );
        }}
      </ComboboxOptions>
    </Combobox>
  );
}
