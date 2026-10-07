import { Combobox, ComboboxButton, ComboboxInput, ComboboxOption, ComboboxOptions } from '@headlessui/react';
import { CheckIcon } from '@parallelworks/ui/icons';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { controlClass } from '@/components/field';
import { cn } from '@/lib/cn';

export interface SearchChoice {
  /** '' is a choice too, such as "No customer". */
  value: string;
  label: string;
  disabled?: boolean;
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

/**
 * Chooses one of a list that can grow long (customers, another tool's
 * projects) by typing any words of its name. It sits in a Field, whose
 * label names it.
 */
export function SearchSelect({
  value,
  onChange,
  choices,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  choices: SearchChoice[];
  className?: string;
}) {
  const t = useTranslations('common.search');
  const [query, setQuery] = useState('');
  const words = fold(query).split(/\s+/).filter(Boolean);
  const shown = words.length ? choices.filter((c) => words.every((w) => fold(c.label).includes(w))) : choices;
  const labelOf = (v: string) => choices.find((c) => c.value === v)?.label ?? v;
  return (
    <Combobox
      value={value}
      onChange={(next: string | null) => {
        if (next !== null) onChange(next);
      }}
      onClose={() => setQuery('')}
      immediate
    >
      <div className={cn('relative', className)}>
        <ComboboxInput
          className={cn(controlClass, 'pr-8')}
          displayValue={labelOf}
          placeholder={t('placeholder')}
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
        // Not modal: the input keeps its label, and a dialog around it stays usable.
        modal={false}
        className="popover z-[10000] max-h-72 w-(--input-width) min-w-56 overflow-y-auto p-1 [--anchor-gap:4px] [--anchor-padding:8px] empty:invisible focus:outline-none"
      >
        {shown.length === 0 && query && (
          <p className="px-2 py-2 text-sm text-muted-foreground">{t('empty', { query })}</p>
        )}
        {shown.map((c) => (
          <ComboboxOption
            key={c.value}
            value={c.value}
            disabled={c.disabled}
            className="group flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-sm data-disabled:cursor-not-allowed data-disabled:opacity-50 data-focus:bg-muted"
          >
            <span className="min-w-0 flex-1 truncate">{c.label}</span>
            <CheckIcon className="invisible size-3.5 shrink-0 text-primary group-data-selected:visible" aria-hidden />
          </ComboboxOption>
        ))}
      </ComboboxOptions>
    </Combobox>
  );
}
